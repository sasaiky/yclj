#!/usr/bin/env node

const assert = require('assert');
const path = require('path');
const { spawn } = require('child_process');
const { app, BrowserWindow, clipboard } = require('electron');
const WebSocket = require('ws');
const Module = require('module');

const port = 19000 + Math.floor(Math.random() * 1000);
const relayUrl = `ws://127.0.0.1:${port}`;
const preset = 'ws://127.0.0.1:1/';
require('../package.json').ycljLanUrl = preset;
delete process.env.RELAY_URL;
const originalLoad = Module._load;
try {
  Module._load = function(request, ...args) {
    if (request === 'node-pty') throw new Error('use the standard shell in this test');
    return originalLoad.call(this, request, ...args);
  };
  require('../electron-client-win/main.js');
} finally {
  Module._load = originalLoad;
}

const relay = spawn(process.execPath, [path.join(__dirname, '..', 'relay', 'index.js')], {
  env: { ...process.env, RELAY_HOST: '127.0.0.1', RELAY_PORT: String(port), ADMIN_TOKEN: 'pin-refresh-test' },
  stdio: ['ignore', 'pipe', 'pipe']
});

function relayReady() {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('relay start timeout')), 5000);
    relay.stdout.on('data', (chunk) => {
      if (chunk.toString().includes('[relay] listening')) {
        clearTimeout(timeout);
        resolve();
      }
    });
    relay.once('exit', code => reject(new Error(`relay exited with ${code}`)));
  });
}

async function waitFor(check, label, timeoutMs = 5000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`timeout: ${label}`);
}

async function main() {
  let operator = null;
  try {
    await Promise.all([app.whenReady(), relayReady()]);
    const win = await waitFor(() => BrowserWindow.getAllWindows()[0], 'window');
    await waitFor(async () => {
      if (win.webContents.isLoading()) return false;
      return win.webContents.executeJavaScript('Boolean(window.ycljClient)').catch(() => false);
    }, 'renderer');
    const evaluate = expression => win.webContents.executeJavaScript(expression);
    await waitFor(() => evaluate(`document.getElementById('relay-url').value === ${JSON.stringify(preset)}`), 'editable LAN preset');
    assert.equal(await evaluate('getComputedStyle(document.getElementById("relay-address")).display'), 'flex');
    await evaluate(`document.getElementById('relay-url').value = ${JSON.stringify(relayUrl)}; document.getElementById('btn-connect').click()`);
    const first = await waitFor(async () => {
      const state = await evaluate('window.ycljClient.getState()');
      return state.connection === 'connected' && /^\d{6}$/.test(state.pin || '') ? state.pin : null;
    }, 'first PIN');

    await evaluate("document.getElementById('btn-copy-pin').click()");
    await waitFor(async () => await clipboard.readText() === `验证码：${first}\nIP：127.0.0.1`, 'copied PIN and relay-observed IP');

    const refreshDisabledOnClick = await evaluate("(() => { const button=document.getElementById('btn-refresh-pin'); button.click(); return button.disabled; })()");
    assert.strictEqual(refreshDisabledOnClick, true);
    const second = await waitFor(async () => {
      const state = await evaluate('window.ycljClient.getState()');
      return state.connection === 'connected' && /^\d{6}$/.test(state.pin || '') && state.pin !== first ? state.pin : null;
    }, 'refreshed PIN');
    assert.notStrictEqual(second, first);

    operator = new WebSocket(relayUrl);
    await new Promise((resolve, reject) => { operator.once('open', resolve); operator.once('error', reject); });
    operator.send(JSON.stringify({type:'auth', role:'operator', token:'pin-refresh-test'}));
    await waitFor(async () => {
      const state = await evaluate('window.ycljClient.getState()');
      return state.connection === 'connected';
    }, 'client ready for pairing');
    const paired = new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('operator pairing timeout')), 5000);
      operator.on('message', raw => {
        const message = JSON.parse(raw.toString());
        if (message.type === 'session' && message.action === 'paired') {
          clearTimeout(timeout);
          resolve();
        }
      });
    });
    operator.send(JSON.stringify({type:'session', action:'join', pin:second}));
    await paired;
    await waitFor(async () => (await evaluate('window.ycljClient.getState()')).connection === 'paired', 'client paired');
    operator.close();
    const third = await waitFor(async () => {
      const state = await evaluate('window.ycljClient.getState()');
      return state.connection === 'connected' && /^\d{6}$/.test(state.pin || '') && state.pin !== second ? state.pin : null;
    }, 'new PIN after operator disconnect');
    assert.notStrictEqual(third, second);

    const connecting = await evaluate('window.ycljClient.refreshPin()');
    assert.strictEqual(connecting.connection, 'connecting');
    await evaluate('window.ycljClient.disconnect()');
    await new Promise(resolve => setTimeout(resolve, 200));
    const finalState = await evaluate('window.ycljClient.getState()');
    assert.strictEqual(finalState.connection, 'idle');
    console.log('[pin-refresh] PASS copy, refresh, operator disconnect, connecting disconnect');
  } finally {
    if (operator) operator.terminate();
    relay.kill();
    app.quit();
  }
}

main().catch(error => {
  console.error(`[pin-refresh] FAIL ${error.message}`);
  app.exit(1);
});
