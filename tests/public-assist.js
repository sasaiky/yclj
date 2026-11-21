const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { app, BrowserWindow, clipboard } = require('electron');
const { createServer } = require('../public-assist/server');
const { deviceDirectory: defaultDeviceDirectory, configFile, loadConfiguredUrl } = require('../operator-cli/settings');
const protocol = require('../public-assist/protocol');
const { getIdentity, createPinOffer, makeExchangeKey, pinSecret, signSignal, verifySignal } = protocol;

const base = process.env.YCLJ_ASSIST_TEST_TEMP;
const noDirectUdp = process.env.YCLJ_ASSIST_TEST_BLOCK_UDP === '1';
const deployedUrl = process.env.YCLJ_ASSIST_TEST_DEPLOYED_URL;
if (noDirectUdp) {
  app.on('web-contents-created', (_event, contents) => {
    contents.setWebRTCIPHandlingPolicy('disable_non_proxied_udp');
  });
}
const deviceDirectory = deployedUrl ? defaultDeviceDirectory : path.join(base, 'operator');
const useStoredServer = deployedUrl && loadConfiguredUrl(configFile) === deployedUrl &&
  !['RELAY_URL', 'YCLJ_PUBLIC_URL', 'ADMIN_TOKEN', 'YCLJ_ADMIN_TOKEN'].some(name => process.env[name]);
const operatorIdentity = getIdentity(deviceDirectory);
const untrustedDirectory = path.join(base, 'server-only-operator');
const untrustedIdentity = getIdentity(untrustedDirectory);
process.env.YCLJ_ASSIST_TRUSTED_OPERATORS = operatorIdentity.id;
const profile = path.join(base, 'client');
fs.mkdirSync(profile);
app.setPath('userData', profile);
app.setPath('desktop', base);
const children = new Set();
if (process.platform === 'win32') delete process.env.PSModulePath;
let nextPinLifetime;
let lastPinExpiry;
let renewedIce = false;
let copiedText;

if (deployedUrl) {
  Object.assign(require('../package.json'), { ycljPublicUrl: deployedUrl, ycljTrustedOperators: operatorIdentity.id });
  clipboard.writeText = value => { copiedText = value; };
}

if (!deployedUrl) {
  protocol.createPinOffer = (...args) => {
    const offer = createPinOffer(...args);
    if (nextPinLifetime) offer.expires = Date.now() + nextPinLifetime;
    nextPinLifetime = undefined;
    lastPinExpiry = offer.expires;
    return offer;
  };
  const rtc = require('../public-assist/rtc');
  const openRtc = rtc.openRtc;
  rtc.openRtc = (options, onEvent) => {
    const connection = openRtc(options, onEvent);
    const send = connection.send;
    const originalUsername = options.iceServers.find(item => item.username)?.username;
    connection.send = message => {
      if (message.op === 'ice_update' && message.servers.some(item => item.username && item.username !== originalUsername)) {
        renewedIce = true;
      }
      send(message);
    };
    return connection;
  };
}

const server = deployedUrl ? null : createServer({
  operatorIds: [operatorIdentity.id, untrustedIdentity.id],
  turnUrls: (process.env.YCLJ_ASSIST_TURN_URLS || 'turn:127.0.0.1:3478?transport=udp').split(','),
  turnSecret: process.env.YCLJ_ASSIST_TURN_SECRET || 'test-only-secret-at-least-32-bytes',
  turnRenewalInterval: 1200
});

require('../electron-client-win/main');

async function waitFor(check, label, timeout = 10_000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const found = await check();
    if (found) return found;
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error(`timeout: ${label}`);
}

function operator(pin, url, args = [], directory = deviceDirectory) {
  const address = useStoredServer && directory === deviceDirectory ? [] : ['--url', url];
  const child = spawn(process.execPath, [path.resolve(__dirname, '..', 'operator-cli', 'index.js'), pin, ...address, ...args], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', YCLJ_OPERATOR_DEVICE_DIR: directory },
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true
  });
  children.add(child);
  const result = { child, output: '', errors: '' };
  child.stdout.setEncoding('utf8').on('data', text => { result.output += text; });
  child.stderr.setEncoding('utf8').on('data', text => { result.errors += text; });
  child.on('close', code => { children.delete(child); result.exitCode = code; });
  return result;
}

function terminalOutput(result) {
  return result.output.split('\n').slice(0, -1).map(line => {
    try { return JSON.parse(line).payload || ''; } catch { return ''; }
  }).join('');
}

async function main() {
  const listening = server && new Promise((resolve, reject) => {
    server.once('error', reject).listen(0, '127.0.0.1', resolve);
  });
  await Promise.all([listening, app.whenReady()]);
  const url = deployedUrl || `ws://127.0.0.1:${server.address().port}/assist`;
  const firstIdentity = getIdentity(profile);
  assert.equal(getIdentity(profile).id, firstIdentity.id);
  const offer = createPinOffer(url, firstIdentity.id);
  const session = '0'.repeat(32);
  const a = makeExchangeKey();
  const b = makeExchangeKey();
  const secret = pinSecret(a, b.key, offer, session, operatorIdentity.id);
  const same = pinSecret(b, a.key, offer, session, operatorIdentity.id);
  assert.equal(secret, same);
  const signed = signSignal(operatorIdentity, { ...offer, secret }, 'offer', session, 0, 'authentic SDP');
  assert.equal(verifySignal(signed, { ...offer, secret }), operatorIdentity.id);
  assert.equal(verifySignal({ ...signed, body: 'changed SDP' }, { ...offer, secret }), null);
  assert.equal(verifySignal(signed, { ...offer, secret: 'x'.repeat(43) }), null);

  const window = await waitFor(() => BrowserWindow.getAllWindows()[0], 'main window');
  const evaluate = expression => window.webContents.executeJavaScript(expression);
  await waitFor(() => evaluate('Boolean(window.ycljClient && document.getElementById("btn-connect"))'), 'window ready');
  assert.equal(await evaluate('document.querySelector("#mode-public, #btn-approve") === null'), true);
  assert.equal(await evaluate('document.title'), 'kk远程连接');
  assert.equal(await evaluate('Boolean(document.getElementById("assist-status").closest(".pin-status"))'), true);
  const state = () => evaluate('window.ycljClient.getState()');

  if (deployedUrl) {
    assert.equal((await state()).addressEditable, false);
    assert.equal((await state()).relayUrl, '');
    assert.equal(await evaluate('getComputedStyle(document.getElementById("relay-address")).display'), 'none');
    assert.equal(await evaluate('document.getElementById("relay-url").value'), '');
  }

  async function readCode(previous) {
    return waitFor(async () => {
      const next = await state();
      return next.connection === 'connected' && /^\d{6}$/.test(next.pin || '') && next.pin !== previous && next.pin;
    }, 'public code');
  }

  async function newCode() {
    await waitFor(() => evaluate('!document.getElementById("btn-connect").disabled'), 'start button enabled');
    await evaluate(`(() => {
      document.getElementById('relay-url').value = ${JSON.stringify(url)};
      document.getElementById('btn-connect').click();
    })()`);
    const pin = await readCode();
    assert.equal(await evaluate('document.getElementById("pin-value").textContent'), pin);
    assert.equal((await state()).terminalMode, 'none');
    return pin;
  }

  if (!deployedUrl) {
    nextPinLifetime = 1250;
    const first = await newCode();
    nextPinLifetime = 2500;
    await readCode(first);
    const withdrawnExpiry = lastPinExpiry;
    const expired = operator(first, url);
    await waitFor(() => expired.exitCode === 1, 'expired code invalid after automatic renewal');
    assert.match(expired.output, /pin_unavailable/);
    await evaluate('document.getElementById("btn-disconnect").click()');
    await waitFor(() => Date.now() >= withdrawnExpiry + 150, 'withdrawn code expiry');
    assert.equal((await state()).connection, 'idle');
    assert.equal((await state()).pin, null);
  }

  let pin = await newCode();
  if (deployedUrl && !noDirectUdp) {
    await evaluate('document.getElementById("btn-copy-pin").click()');
    await waitFor(() => copiedText === pin, 'copy only the code');
    await evaluate('document.getElementById("btn-disconnect").click()');
    await waitFor(async () => (await state()).connection === 'idle', 'fixed client idle');
    await evaluate('window.ycljClient.start({ relayUrl: "ws://127.0.0.1:1" })');
    pin = await readCode();
    console.log('[assist] PASS embedded server, hidden address and code-only copy');
  }
  if (!noDirectUdp) {
    const intruder = operator(pin, url, [], path.join(base, 'unauthorized'));
    await waitFor(() => intruder.exitCode === 1, 'server device allowlist');
    assert.match(intruder.output, /operator_unauthorized/);
    assert.equal((await state()).terminalMode, 'none');

    if (!deployedUrl) {
      const authenticatedElsewhere = operator(pin, url, [], untrustedDirectory);
      await waitFor(() => authenticatedElsewhere.exitCode === 1, 'client device allowlist');
      assert.equal((await state()).terminalMode, 'none');
      assert.match((await state()).assistStatus, /未获/);
      pin = await newCode();
    }

    await evaluate('document.getElementById("btn-refresh-pin").click()');
    const refreshed = await readCode();
    assert.notEqual(refreshed, pin);
    const revoked = operator(pin, url);
    await waitFor(() => revoked.exitCode === 1, 'refreshed code invalid');
    assert.match(revoked.output, /pin_unavailable/);
    pin = refreshed;
  }

  let expiredAfterPairing;
  if (!deployedUrl) {
    await evaluate('document.getElementById("btn-disconnect").click()');
    nextPinLifetime = 5000;
    pin = await newCode();
    expiredAfterPairing = lastPinExpiry;
  }
  const connected = operator(pin, url);
  const expectedRoute = noDirectUdp ? 'relay' : 'direct';
  await waitFor(() => connected.output.includes(`"route":"${expectedRoute}"`), `${expectedRoute} path`, 35000).catch(error => {
    return state().then(client => {
      throw new Error(`${error.message}\nClient: ${client.connection} ${client.assistStatus}\n${connected.output.slice(0, 1000)}\n${connected.errors.slice(0, 1000)}`);
    });
  });
  assert.equal((await state()).route, expectedRoute);
  const routeLabel = expectedRoute === 'relay' ? '中继' : '直连';
  await waitFor(() => evaluate(`(() => {
    const route = document.getElementById('connection-route');
    const bounds = route.getBoundingClientRect();
    return route.textContent === ${JSON.stringify(routeLabel)} && bounds.height > 0 &&
      bounds.top >= document.getElementById('pin-value').getBoundingClientRect().bottom &&
      bounds.bottom <= document.getElementById('btn-connect').getBoundingClientRect().top;
  })()`), 'route directly below pairing code');
  assert.equal((await state()).pin, pin);
  assert.equal(await evaluate('document.getElementById("pin-value").textContent'), pin);
  assert.equal(await evaluate('document.getElementById("btn-copy-pin").disabled'), true);
  if (expiredAfterPairing) {
    const sessionId = (await state()).sessionId;
    await waitFor(() => renewedIce && Date.now() >= expiredAfterPairing + 150, 'credential renewal after pairing');
    assert.equal((await state()).sessionId, sessionId);
    assert.equal((await state()).pin, pin);
    console.log('[assist] PASS idle code renewal, cancellation, connected code retention and refreshed ICE credentials');
  }
  if (!noDirectUdp) {
    const replay = operator(pin, url);
    await waitFor(() => replay.exitCode === 1, 'code already used');
    assert.match(replay.output, /pin_unavailable/);
  }
  await waitFor(() => /PS [^>]+>/.test(terminalOutput(connected)), 'PowerShell prompt');
  connected.child.stdin.write("Write-Output ('YCLJ-' + 'PATH-OK')\n");
  await waitFor(() => terminalOutput(connected).includes('YCLJ-PATH-OK'), 'actual PowerShell result');
  await evaluate('document.getElementById("btn-disconnect").click()');
  await waitFor(() => evaluate('document.getElementById("connection-route").textContent === ""'), 'route cleared');
  assert.equal((await state()).pin, null);
  assert.equal((await state()).terminalMode, 'none');
  assert.equal((await state()).sessionId, null);
  await waitFor(() => connected.exitCode === 0, 'operator disconnected');
  assert.match(connected.output, /peer_disconnected|signal_unavailable/);

  if ((process.env.YCLJ_ASSIST_TURN_URLS || deployedUrl) && !noDirectUdp) {
    const script = path.join(base, 'operation.ps1');
    fs.writeFileSync(script, "Write-Output 'TURN-OK'\n", 'utf8');
    const relayed = operator(await newCode(), url, ['--relay-only', '--run', script]);
    await waitFor(() => relayed.exitCode !== undefined, `TURN PowerShell result`, 38_000);
    assert.equal(relayed.exitCode, 0, relayed.errors || relayed.output);
    assert.match(relayed.errors, /path=relay/);
    assert.match(JSON.parse(relayed.output).stdout, /TURN-OK/);
    console.log('[assist] PASS TURN relay and PowerShell script');
  }

  console.log(`[assist] PASS shared client, PIN, signed key exchange, replay, ${expectedRoute} PowerShell and disconnect`);
  if (useStoredServer) console.log('[assist] PASS daily CLI using the saved server without --url');
}

async function finish(code, error) {
  if (error) console.error(error.stack);
  for (const child of children) child.stdin.destroy();
  await waitFor(() => !children.size, 'operator cleanup', 4000).catch(() => {
    for (const child of children) child.kill();
  });
  for (const window of BrowserWindow.getAllWindows()) window.close();
  server?.close();
  app.exit(code);
}

main().then(() => finish(0), error => finish(1, error));
