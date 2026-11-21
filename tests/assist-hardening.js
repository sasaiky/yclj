const assert = require('node:assert/strict');
const { createHash, generateKeyPairSync, randomBytes } = require('node:crypto');
const dns = require('node:dns');
const { once } = require('node:events');
const { promisify } = require('node:util');
const WebSocket = require('ws');
const { createServer } = require('../public-assist/server');
const { lanRelayOptions, operationAllowed, makeExchangeKey, signSignal } = require('../public-assist/protocol');
const { createVerifier, createPasswordGate } = require('../public-assist/operator-password');
const { terminalText } = require('../operator-cli/terminal-text');

assert.equal(terminalText('\x1b[32m中文\tDone\x1b[0m\r\n'), '中文\tDone\n');
assert.equal(terminalText('a\u0007b\u0000c\r\u0080d\u007f'), 'abcd');
assert.equal(['hello\x1b', '[32m\x1b', '[0m\n'].map(terminalText).join(''), 'hello[32m[0m\n');

const session = 'test-session';
const command = { type: 'exec', stream: 'stdin', payload: 'test', session_id: session };
assert.equal(operationAllowed(command, true, session), true);
assert.equal(operationAllowed(command, false, session), false);
assert.equal(operationAllowed({ ...command, stream: 'stdout' }, false, session), true);
assert.equal(operationAllowed(command, true, 'other-session'), false);

async function verifyLanAddresses() {
  for (const host of ['127.0.0.1', '192.168.1.4', '100.64.0.5', '[fd7a::1]', '[::ffff:7f00:1]']) {
    assert.doesNotThrow(() => lanRelayOptions(`ws://${host}:8080`));
  }
  for (const host of ['203.0.113.1', '[2001:db8::1]', '[::ffff:cb00:7101]']) {
    assert.throws(() => lanRelayOptions(`wss://${host}/`), /仅支持本机或私网/);
  }
  const lookup = promisify(lanRelayOptions('ws://relay.test').lookup);
  const originalLookup = dns.lookup;
  const privateAnswer = { address: '192.168.1.4', family: 4 };
  const publicAnswer = { address: '203.0.113.1', family: 4 };
  try {
    dns.lookup = (_hostname, _options, callback) => callback(null, [publicAnswer, privateAnswer]);
    assert.deepEqual(await lookup('relay.test', { all: true }), [privateAnswer]);
    assert.equal(await lookup('relay.test', { all: false }), privateAnswer.address);
    dns.lookup = (_hostname, _options, callback) => callback(null, [publicAnswer]);
    await assert.rejects(lookup('relay.test', { all: true }), /仅支持本机或私网/);
  } finally {
    dns.lookup = originalLookup;
  }
}

function upgrade(url, source) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(url, { headers: { 'X-Forwarded-For': source }, handshakeTimeout: 2000 });
    socket.once('error', reject);
    socket.once('open', () => resolve({ status: 101, socket }));
    socket.once('unexpected-response', (_request, response) => {
      response.resume();
      resolve({ status: response.statusCode });
      socket.terminate();
    });
  });
}

function testIdentity() {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  const der = publicKey.export({ type: 'spki', format: 'der' });
  return { privateKey, key: der.toString('base64url'), id: createHash('sha256').update(der).digest('base64url') };
}

async function verifyPasswordProtection() {
  const operator = testIdentity();
  const client = testIdentity();
  const password = 'A!天7';
  const verifier = createVerifier(password);
  let now = 1000;
  const verify = createPasswordGate(new Map([[operator.id, verifier]]), () => now);
  for (let i = 0; i < 4; i++) assert.equal(verify(operator.id, 'wrong'), 'operator_password_invalid');
  assert.equal(verify(operator.id, 'wrong'), 'operator_password_locked');
  assert.equal(verify(operator.id, password), 'operator_password_locked');
  now += 10 * 60_000;
  assert.equal(verify(operator.id, password), null);

  const server = createServer({ operatorIds: [operator.id], operatorPasswords: `${operator.id}:${verifier}`,
    turnSecret: 'test-only-secret-at-least-32-bytes', turnUrls: ['turn:127.0.0.1:3478?transport=udp'] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/assist`;
  const sockets = new Set();
  const pin = '135790';
  const receive = async ws => JSON.parse((await once(ws, 'message'))[0].toString());
  async function send(identity, op, body, secret) {
    const ws = new WebSocket(url);
    sockets.add(ws);
    ws.once('close', () => sockets.delete(ws));
    const { challenge } = await receive(ws);
    const route = randomBytes(32).toString('base64url');
    const session = randomBytes(16).toString('hex');
    const answer = receive(ws);
    ws.send(JSON.stringify(signSignal(identity, { route, secret }, op, session, 0, { challenge, ...body })));
    return { ws, message: await answer };
  }
  async function lookup(password) {
    const { ws, message } = await send(operator, 'lookup_pin', { pin, password });
    ws.terminate();
    return message;
  }
  try {
    const registration = await send(client, 'register_pin', { pin, expires: Date.now() + 30_000, exchangeKey: makeExchangeKey().key });
    assert.equal(registration.message.op, 'registered');
    assert.equal((await lookup()).code, 'operator_password_required');
    const legacy = await send(operator, 'request', {}, randomBytes(32).toString('base64url'));
    assert.equal(legacy.message.code, 'operator_password_required');
    const correct = await lookup(password);
    assert.equal(correct.op, 'pin_target');
    assert.equal(correct.passwordVerified, true);
    assert.equal(JSON.stringify(correct).includes(password), false);
    for (let i = 0; i < 4; i++) assert.equal((await lookup('wrong')).code, 'operator_password_invalid');
    assert.equal((await lookup('wrong')).code, 'operator_password_locked');
    assert.equal((await lookup(password)).code, 'operator_password_locked');
  } finally {
    for (const ws of sockets) ws.terminate();
    server.close();
  }
}

async function main() {
  await verifyLanAddresses();
  await verifyPasswordProtection();
  const server = createServer({ operatorIds: ['a'.repeat(43)], turnSecret: 'test-only-secret-at-least-32-bytes',
    turnUrls: ['turn:127.0.0.1:3478?transport=udp'] });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const url = `ws://127.0.0.1:${server.address().port}/assist`;
  const sockets = new Set();
  let firstServerSocket;
  server.once('upgrade', (_request, socket) => { firstServerSocket = socket; });
  const sourceA = '192.0.2.1';
  const sourceB = '198.51.100.1';
  try {
    for (let i = 0; i < 16; i++) {
      const result = await upgrade(url, sourceA);
      assert.equal(result.status, 101);
      sockets.add(result.socket);
    }
    assert.equal((await upgrade(url, sourceA)).status, 429);
    for (let i = 0; i < 40; i++) {
      const { status, socket } = await upgrade(url, sourceB);
      assert.equal(status, 101);
      const closed = once(socket, 'close');
      socket.close();
      await closed;
    }
    assert.equal((await upgrade(url, sourceB)).status, 429);
    const [released] = sockets;
    const closed = once(firstServerSocket, 'close');
    released.close();
    await closed;
    const replacement = await upgrade(url, sourceA);
    assert.equal(replacement.status, 101);
    sockets.add(replacement.socket);
  } finally {
    for (const socket of sockets) socket.terminate();
    server.close();
  }
  console.log('[assist-hardening] PASS private relay addresses, operation direction, terminal text, source limits and optional password lockout');
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
