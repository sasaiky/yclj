const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { app, BrowserWindow, desktopCapturer, screen, session } = require('electron');
const { getIdentity } = require('../public-assist/protocol');
const { createServer } = require('../public-assist/server');
const { connectPeer } = require('../public-assist/peer');
const { openRtc } = require('../public-assist/rtc');
const { terminalText } = require('../operator-cli/terminal-text');
const inputEvents = [];
let inputReleases = 0;
require('../electron-client-win/remote-input').createRemoteInput = () => ({
  apply: event => inputEvents.push(event),
  release: () => { inputReleases++; }
});

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yclj-screen-test-'));
const operator = getIdentity(path.join(base, 'operator'));
app.setPath('userData', path.join(base, 'client'));
app.setPath('desktop', base);
process.env.YCLJ_ASSIST_TRUSTED_OPERATORS = operator.id;
let captureSelections = 0;
desktopCapturer.getSources = async () => {
  captureSelections++;
  return [{ id: 'screen:test', display_id: String(screen.getPrimaryDisplay().id) }];
};
require('../electron-client-win/main');

const server = createServer({
  operatorIds: [operator.id],
  turnUrls: ['turn:127.0.0.1:3478?transport=udp'],
  turnSecret: 'screen-sharing-loopback-test-secret'
});
let peer;

async function waitFor(check, description) {
  const end = Date.now() + 10000;
  do {
    const result = await check();
    if (result) return result;
    await delay(40);
  } while (Date.now() < end);
  throw new Error('Timeout: ' + description);
}

async function click(window, selector = '#btn-share-screen') {
  const contents = window.webContents;
  const position = await contents.executeJavaScript(`(() => {
    const box = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  })()`);
  window.focus();
  contents.sendInputEvent({ type: 'mouseMove', ...position });
  contents.sendInputEvent({ type: 'mouseDown', ...position, button: 'left', clickCount: 1 });
  contents.sendInputEvent({ type: 'mouseUp', ...position, button: 'left', clickCount: 1 });
}

async function main() {
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await Promise.all([listening, app.whenReady()]);
  const url = 'ws://127.0.0.1:' + server.address().port + '/assist';
  const windowsClient = await waitFor(() => BrowserWindow.getAllWindows()[0], 'Windows client window');
  const evaluate = code => windowsClient.webContents.executeJavaScript(code);
  const clientState = () => evaluate('window.ycljClient.getState()');
  await waitFor(() => evaluate('Boolean(window.ycljClient)'), 'Windows client preload');
  await evaluate(`window.ycljClient.start(${JSON.stringify({ relayUrl: url, shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/cat' })})`);
  const pin = await waitFor(async () => (await clientState()).pin, 'pairing code');
  let legacyReceiver = false;
  const rtcFactory = (options, onEvent) => openRtc(options, event => {
    if (legacyReceiver && event.event === 'data') {
      const message = JSON.parse(event.data);
      if (message.action === 'screen_started') {
        delete message.screenStop;
        return onEvent({ ...event, data: JSON.stringify(message) });
      }
    }
    onEvent(event);
  });
  peer = connectPeer({ identity: operator, pin, url, operator: true, viewScreen: true, rtcFactory });
  await waitFor(async () => (await clientState()).screenShareAvailable, 'sharing capability');

  const rtcWindows = BrowserWindow.getAllWindows().filter(window => window !== windowsClient);
  const capture = rtcWindows.find(window => window.webContents.session === session.fromPartition('yclj-assist-display'));
  const viewer = rtcWindows.find(window => window !== capture);
  const inCapture = code => capture.webContents.executeJavaScriptInIsolatedWorld(999, [{ code }]);
  const inViewer = code => viewer.webContents.executeJavaScript(code);
  await inCapture(`const setParameters = RTCRtpSender.prototype.setParameters;
  RTCRtpSender.prototype.setParameters = function (params) {
    globalThis.testVideoEncoding = params.encodings[0];
    return setParameters.call(this, params);
  };
  navigator.mediaDevices.getUserMedia = async ({ audio, video }) => {
    if (audio !== false || video.mandatory.chromeMediaSourceId !== 'screen:test') throw new Error('Unexpected capture');
    const canvas = document.createElement('canvas');
    canvas.width = video.mandatory.maxWidth;
    canvas.height = video.mandatory.maxHeight;
    const context = canvas.getContext('2d');
    let frame = 0;
    const paint = () => {
      context.fillStyle = ++frame % 2 ? '#336699' : '#346998';
      context.fillRect(0, 0, canvas.width, canvas.height);
    };
    paint();
    const stream = canvas.captureStream(15);
    globalThis.testTrack = stream.getVideoTracks()[0];
    const timer = setInterval(() => {
      if (globalThis.testTrack.readyState === 'ended') clearInterval(timer);
      else paint();
    }, 50);
    return stream;
  }; undefined`);

  assert.equal(viewer.isVisible(), false);
  assert.equal(await inViewer('document.querySelector("video").srcObject === null'), true);
  assert.equal(await inViewer('document.querySelector("#screen-stop").hidden'), true);
  const { sessionId } = await clientState();
  const textInput = { type: 'input', action: 'text', text: '共享输入', session_id: sessionId };
  assert(peer.send(textInput));
  await delay(100);
  assert.equal(inputEvents.length, 0, 'input requires local sharing');
  assert.equal(await evaluate('document.querySelector("#btn-share-screen").textContent'), '共享屏幕并允许控制');
  await evaluate('document.querySelector("#btn-share-screen").click()');
  assert.equal(captureSelections, 0, 'programmatic click must not capture');
  let commandOutput = '';
  peer.on('message', message => {
    if (message.type === 'exec') commandOutput = (commandOutput + message.payload).slice(-4096);
  });

  async function expectEcho(marker) {
    const command = process.platform === 'win32' ? 'echo ' + marker : marker;
    assert(peer.send({ type: 'exec', stream: 'stdin', payload: command + '\r\n', session_id: sessionId }));
    await waitFor(() => terminalText(commandOutput).split('\n').some(line => line.trim() === marker),
      'command output ' + marker);
  }

  for (let index = 0; index < 2; index++) {
    legacyReceiver = index === 1;
    await click(windowsClient);
    await waitFor(async () => (await clientState()).screenSharing, 'local share started');
    await waitFor(() => viewer.isVisible(), 'viewer opened');
    assert.equal(await inViewer('document.querySelector("video").videoHeight'), 720);
    assert.equal(await inCapture('globalThis.testVideoEncoding.maxBitrate'), 900_000);
    assert.equal(await inViewer('document.querySelector("#screen-controls").hidden'), false);
    assert.equal(await inViewer('document.querySelector("#screen-stop").hidden'), legacyReceiver);

    if (index === 0) {
      assert.equal(await inViewer('document.querySelector("#screen-input-status").hidden'), false);
      await click(viewer, '#screen');
      await waitFor(() => inputEvents.some(event => event.action === 'button' && event.down === false), 'viewer click forwarded');
      assert(peer.send(textInput));
      await waitFor(() => inputEvents.some(event => event.text === textInput.text), 'shared keyboard input forwarded');
      for (const [quality, height, bitrate, fps] of [
        ['clear', 1080, 1_800_000, 15],
        ['economy', 540, 350_000, 8],
        ['standard', 720, 900_000, 15]
      ]) {
        await inViewer(`(() => {
          const select = document.querySelector('#screen-quality');
          select.value = ${JSON.stringify(quality)};
          select.dispatchEvent(new Event('change'));
        })()`);
        await waitFor(async () => await inViewer('document.querySelector("video").videoHeight') === height, 'video resized to ' + height);
        const encoding = await inCapture('globalThis.testVideoEncoding');
        assert.equal(encoding.maxBitrate, bitrate);
        assert.equal(encoding.maxFramerate, fps);
        assert.equal(captureSelections, 1, 'changing quality must reuse the selected screen');
      }
    }

    await expectEcho('YCLJ-DURING-SHARE-' + index);

    const releasesBeforeStop = inputReleases;
    if (index === 0) await click(viewer, '#screen-stop');
    else await click(windowsClient);
    await waitFor(async () => !(await clientState()).screenSharing && !viewer.isVisible(), 'share stopped');
    assert.equal(await inViewer('document.querySelector("video").srcObject === null'), true);
    assert.equal(await inCapture('globalThis.testTrack.readyState'), 'ended');
    assert(inputReleases > releasesBeforeStop, 'stopping share releases input');
    const count = inputEvents.length;
    assert(peer.send(textInput));
    await delay(100);
    assert.equal(inputEvents.length, count, 'input stops with sharing');
    assert.equal((await clientState()).sessionId, sessionId);
    await expectEcho('YCLJ-AFTER-STOP-' + index);
  }
  legacyReceiver = false;
  await click(windowsClient);
  await waitFor(() => viewer.isVisible(), 'viewer reopened before disconnect');
  assert.equal(await inViewer('!document.querySelector("#screen-stop").hidden && !document.querySelector("#screen-stop").disabled'), true);
  assert.equal(captureSelections, 3);
  await evaluate('window.ycljClient.disconnect()');
  await waitFor(() => viewer.isDestroyed() && capture.isDestroyed(), 'RTC windows closed');
  console.log('[screen] PASS consent, keyboard/mouse gating, all three quality settings, stop from either end, commands before and after stopping, repeat, and disconnect');
}

function finish(code, error) {
  if (error) console.error(error.stack);
  peer?.close();
  server.close();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  app.exit(code);
}

main().then(() => finish(0), error => finish(1, error));
