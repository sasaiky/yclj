#!/usr/bin/env node

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const WebSocket = require('ws');

const port = Number(process.env.SMOKE_PORT || 18080 + Math.floor(Math.random() * 1000));
const token = 'smoke-admin-token';

function waitForOpen(ws, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('open timeout')), timeoutMs);
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

function waitForMessage(ws, matcher, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const onMessage = (raw) => {
      let message = null;
      try {
        message = JSON.parse(raw.toString('utf8'));
      } catch {
        return;
      }

      if (matcher(message)) {
        clearTimeout(timer);
        ws.off('message', onMessage);
        resolve(message);
      }
    };

    const timer = setTimeout(() => {
      ws.off('message', onMessage);
      reject(new Error('message timeout'));
    }, timeoutMs);

    ws.on('message', onMessage);
  });
}

function closeSocket(ws) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === WebSocket.CLOSED) {
      resolve();
      return;
    }

    ws.once('close', () => resolve());
    ws.close(1000, 'smoke_done');
  });
}

function waitForRelayReady(relayProc, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const onData = (buf) => {
      const text = buf.toString('utf8');
      if (text.includes('[relay] listening')) {
        clearTimeout(timer);
        relayProc.stdout.off('data', onData);
        resolve();
      }
    };

    const timer = setTimeout(() => {
      relayProc.stdout.off('data', onData);
      reject(new Error('relay start timeout'));
    }, timeoutMs);

    relayProc.stdout.on('data', onData);
    relayProc.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`relay exited early with code ${code}`));
    });
  });
}

async function main() {
  const relayPath = path.join(__dirname, '..', 'relay', 'index.js');
  const relayCwd = path.join(__dirname, '..');

  const relayProc = spawn(process.execPath, [relayPath], {
    cwd: relayCwd,
    env: {
      ...process.env,
      RELAY_PORT: String(port),
      ADMIN_TOKEN: token
    },
    stdio: ['ignore', 'pipe', 'pipe']
  });

  relayProc.stderr.on('data', (buf) => {
    process.stderr.write(buf.toString('utf8'));
  });

  let client = null;
  let operator = null;

  try {
    await waitForRelayReady(relayProc);

    client = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(client);

    client.send(JSON.stringify({
      type: 'auth',
      role: 'client'
    }));

    await waitForMessage(client, (m) => m.type === 'auth' && m.status === 'ok');
    const pinMessage = await waitForMessage(client, (m) => m.type === 'session' && m.action === 'pin_generated');

    operator = new WebSocket(`ws://127.0.0.1:${port}`);
    await waitForOpen(operator);

    operator.send(JSON.stringify({
      type: 'auth',
      role: 'operator',
      token
    }));

    await waitForMessage(operator, (m) => m.type === 'auth' && m.status === 'ok');

    operator.send(JSON.stringify({
      type: 'session',
      action: 'join',
      pin: pinMessage.pin
    }));

    const pairedOperator = await waitForMessage(operator, (m) => m.type === 'session' && m.action === 'paired');
    const pairedClient = await waitForMessage(client, (m) => m.type === 'session' && m.action === 'paired');

    assert.strictEqual(pairedOperator.session_id, pairedClient.session_id, 'session IDs should match');

    const sessionId = pairedOperator.session_id;

    operator.send(JSON.stringify({
      type: 'exec',
      stream: 'stdin',
      payload: 'echo smoke\r',
      session_id: sessionId
    }));

    const forwardedToClient = await waitForMessage(
      client,
      (m) => m.type === 'exec' && m.stream === 'stdin' && m.payload === 'echo smoke\r'
    );
    assert.strictEqual(forwardedToClient.session_id, sessionId);

    client.send(JSON.stringify({
      type: 'exec',
      stream: 'stdout',
      payload: 'smoke-ok\n',
      session_id: sessionId
    }));

    const forwardedToOperator = await waitForMessage(
      operator,
      (m) => m.type === 'exec' && m.stream === 'stdout' && m.payload === 'smoke-ok\n'
    );
    assert.strictEqual(forwardedToOperator.session_id, sessionId);

    process.stdout.write('[smoke] PASS relay handshake + pairing + routing\n');

    await closeSocket(operator);
    await closeSocket(client);

    relayProc.kill();
  } catch (err) {
    try {
      await closeSocket(operator);
      await closeSocket(client);
    } catch {
      // no-op
    }

    relayProc.kill();
    throw err;
  }
}

main().catch((err) => {
  process.stderr.write(`[smoke] FAIL: ${err.message}\n`);
  process.exit(1);
});
