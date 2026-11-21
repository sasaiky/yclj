#!/usr/bin/env node

const assert = require('assert');
const { app, BrowserWindow, clipboard, dialog } = require('electron');
const WebSocket = require('ws');
const fs = require('fs');
const net = require('net');
const os = require('os');
const path = require('path');

const port = 20000 + Math.floor(Math.random() * 1000);
process.env.YCLJ_HOST_PORT = String(port);
process.env.ADMIN_TOKEN = 'host-dashboard-integration-test-token';
process.env.YCLJ_HOST_CONTROL_FILE = path.join(os.tmpdir(), `yclj-host-control-test-${process.pid}.json`);
app.setPath('userData', path.join(os.tmpdir(), `yclj-host-test-${process.pid}`));
require('../electron-host-win/main.js');

async function waitFor(check, label, timeoutMs = 7000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const result = await check();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`timeout: ${label}`);
}

async function main() {
  let client = null;
  let clientTwo = null;
  const clientMessages = [];
  try {
    await app.whenReady();
    const win = await waitFor(() => BrowserWindow.getAllWindows()[0], 'window');
    await waitFor(async () => {
      if (win.webContents.isLoading()) return false;
      return win.webContents.executeJavaScript('Boolean(window.ycljHost)').catch(() => false);
    }, 'renderer');
    const evaluate = script => win.webContents.executeJavaScript(script);
    const setPin = pin => evaluate(`{ const input = document.querySelector('#pair-pin'); input.value = ${JSON.stringify(pin)}; input.dispatchEvent(new Event('input', { bubbles: true })); }`);
    const ready = await waitFor(async () => {
      const state = await evaluate('window.ycljHost.getState()');
      return state.status === 'running' ? state : null;
    }, 'host listening');
    assert.strictEqual(ready.port, port);
    assert.ok(ready.addresses.length > 0, 'local address should be visible');

    const firstAddress = ready.addresses[0];
    await evaluate("document.querySelector('.address-row .copy-button').click()");
    await waitFor(async () => await clipboard.readText() === firstAddress.url, 'copied connection address');

    client = new WebSocket(`ws://127.0.0.1:${port}`);
    client.on('message', raw => clientMessages.push(JSON.parse(raw.toString('utf8'))));
    await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
    client.send(JSON.stringify({type:'auth',role:'client',client_name:'演示同事'}));
    const peer = await waitFor(async () => {
      const state = await evaluate('window.ycljHost.getState()');
      return state.peers.length === 1 ? state.peers[0] : null;
    }, 'client shown online');
    assert.strictEqual(peer.name, '演示同事');
    const firstPin = await waitFor(() => clientMessages.find(message => message.type === 'session' && message.action === 'pin_generated')?.pin, 'client PIN');
    assert.strictEqual(peer.pin, undefined);
    await waitFor(() => evaluate("document.querySelectorAll('.peer-row').length === 1"), 'client shown in UI');
    await evaluate("document.querySelector('.peer-row .copy-button').click()");
    await waitFor(async () => await clipboard.readText() === peer.ip, 'copied peer IP');

    assert.strictEqual(await evaluate("document.querySelector('#pair-button').disabled"), true);
    await setPin('12 34 5');
    assert.strictEqual(await evaluate("document.querySelector('#pair-pin').value"), '12345');
    assert.strictEqual(await evaluate("document.querySelector('#pair-button').disabled"), true);
    await setPin('12 34 56');
    assert.strictEqual(await evaluate("document.querySelector('#pair-pin').value"), '123456');
    assert.strictEqual(await evaluate("document.querySelector('#pair-button').disabled"), false);
    await setPin('000000');
    await evaluate("document.querySelector('#pair-button').click()");
    await waitFor(() => evaluate("document.querySelector('#pair-message').textContent.includes('验证码不正确')"), 'invalid PIN rejected');
    assert.strictEqual(await evaluate("document.querySelector('#pair-pin').value"), '000000');
    await setPin(firstPin);
    await evaluate("document.querySelector('#pair-button').click()");
    const paired = await waitFor(async () => {
      const state = await evaluate('window.ycljHost.getState()');
      return state.session.status === 'paired' ? state : null;
    }, 'host paired to client');
    assert.strictEqual(paired.session.pin, firstPin);
    assert.strictEqual(paired.peers[0].status, '已连接');
    await waitFor(() => evaluate("document.querySelector('#pair-pin').value === ''"), 'successful PIN cleared');
    assert.strictEqual(await evaluate("document.querySelector('#pair-pin').disabled"), false);
    assert.strictEqual(await evaluate("document.querySelector('#pair-button').disabled"), true);
    assert.strictEqual(await evaluate("document.querySelector('#pair-form .peer-disconnect')"), null);
    await waitFor(() => evaluate("document.querySelectorAll('.peer-row .peer-disconnect').length === 1"), 'disconnect belongs to paired peer');
    assert.strictEqual(await evaluate("document.querySelector('.peer-row').children.length"), 2);
    assert.strictEqual(await evaluate("document.querySelector('.peer-ip').nextElementSibling.className"), 'peer-status');
    assert.strictEqual(await evaluate("document.querySelector('.peer-controls .copy-button').nextElementSibling.className"), 'peer-disconnect');
    await setPin('212121');
    await evaluate("document.querySelector('#pair-button').click()");
    await waitFor(() => evaluate("document.querySelector('#pair-message').textContent.includes('验证码不正确')"), 'second invalid PIN rejected');
    assert.strictEqual(await evaluate("document.querySelector('#pair-pin').value"), '212121');
    assert.strictEqual(await evaluate("document.querySelector('#pair-button').disabled"), false);
    assert.strictEqual((await evaluate('window.ycljHost.getState()')).sessions.length, 1);
    clientTwo = new WebSocket(`ws://127.0.0.1:${port}`);
    const clientTwoMessages = [];
    clientTwo.on('message', raw => clientTwoMessages.push(JSON.parse(raw.toString('utf8'))));
    await new Promise((resolve, reject) => { clientTwo.once('open', resolve); clientTwo.once('error', reject); });
    clientTwo.send(JSON.stringify({ type: 'auth', role: 'client', client_name: '同时连接的同事' }));
    const extraPin = await waitFor(() => clientTwoMessages.find(message => message.type === 'session' && message.action === 'pin_generated')?.pin, 'second PIN');
    await setPin(extraPin);
    await evaluate("document.querySelector('#pair-button').click()");
    await waitFor(async () => (await evaluate('window.ycljHost.getState()')).sessions.length === 2, 'two active sessions');
    await waitFor(() => evaluate("document.querySelectorAll('.peer-row .peer-disconnect').length === 2"), 'two peer disconnect buttons');
    await waitFor(() => evaluate("document.querySelector('#pair-pin').value === ''"), 'second successful PIN cleared');
    await evaluate("document.querySelectorAll('.peer-row .peer-disconnect')[1].click()");
    await waitFor(async () => (await evaluate('window.ycljHost.getState()')).sessions.length === 1, 'second session disconnected');
    assert.strictEqual((await evaluate('window.ycljHost.getState()')).peers[0].status, '已连接');
    clientTwo.close();
    await waitFor(async () => (await evaluate('window.ycljHost.getState()')).peers.length === 1, 'second peer removed');
    if (process.env.YCLJ_HOST_PREVIEW_IMAGE) {
      if (process.env.YCLJ_HOST_PREVIEW_PEERS === '3') {
        const preview = {
          ...paired,
          peers: [
            { ...paired.peers[0], name: '同事 A', ip: '192.0.2.75' },
            { id: 'preview-b', name: '同事 B', ip: '192.0.2.76', status: '等待配对', connectedAt: new Date().toISOString() },
            { id: 'preview-c', name: '同事 C', ip: '192.0.2.77', status: '等待配对', connectedAt: new Date().toISOString() }
          ]
        };
        await evaluate(`renderState(${JSON.stringify(preview)})`);
      }
      win.setSize(680, process.env.YCLJ_HOST_PREVIEW_PEERS === '3' ? 1180 : 950);
      await new Promise(resolve => setTimeout(resolve, 2700));
      const image = await win.capturePage();
      fs.writeFileSync(process.env.YCLJ_HOST_PREVIEW_IMAGE, image.toPNG());
    }
    await waitFor(() => fs.existsSync(process.env.YCLJ_HOST_CONTROL_FILE), 'local agent control address');
    const { port: controlPort } = JSON.parse(fs.readFileSync(process.env.YCLJ_HOST_CONTROL_FILE, 'utf8'));
    const control = async (endpoint, method = 'GET', body) => {
      const response = await fetch(`http://127.0.0.1:${controlPort}${endpoint}`, {
        method,
        headers: { Authorization: `Bearer ${process.env.ADMIN_TOKEN}`, 'Content-Type': 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {})
      });
      assert.strictEqual(response.status, 200);
      return response.json();
    };
    assert.strictEqual((await control('/status')).sessions.length, 1);
    const command = "Write-Output '原样 > $ready'\r";
    const output = '原样 > $ready\n';
    await control('/send', 'POST', { type: 'exec', stream: 'stdin', payload: command });
    await waitFor(() => clientMessages.some(message => message.type === 'exec' && message.payload === command), 'agent command reached client unchanged');
    client.send(JSON.stringify({ type: 'exec', stream: 'stdout', payload: output, session_id: paired.session.sessionId }));
    await waitFor(async () => (await control('/events')).events.some(event => event.type === 'exec' && event.payload === output), 'client output reached agent unchanged');
    assert.deepStrictEqual(clientMessages.filter(message => message.type === 'exec').map(message => message.payload), [command]);
    await evaluate("document.querySelector('.peer-row .peer-disconnect').click()");
    await waitFor(async () => (await evaluate('window.ycljHost.getState()')).session.status === 'idle', 'host session disconnected');

    client.close();
    await waitFor(async () => (await evaluate('window.ycljHost.getState()')).peers.length === 0, 'client removed after disconnect');
    client = new WebSocket(`ws://127.0.0.1:${port}`);
    const secondMessages = [];
    client.on('message', raw => secondMessages.push(JSON.parse(raw.toString('utf8'))));
    await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
    client.send(JSON.stringify({ type: 'auth', role: 'client', client_name: '第二位同事' }));
    await waitFor(async () => {
      const state = await evaluate('window.ycljHost.getState()');
      return state.peers.length === 1 ? state.peers[0] : null;
    }, 'second client online');
    const secondPin = await waitFor(() => secondMessages.find(message => message.type === 'session' && message.action === 'pin_generated')?.pin, 'second client PIN');
    await control('/pair', 'POST', { pin: secondPin });
    await waitFor(async () => (await evaluate('window.ycljHost.getState()')).peers[0].status === '已连接', 'agent pairing shown in UI');
    await control('/disconnect', 'POST', {});
    client.close();
    await waitFor(async () => (await evaluate('window.ycljHost.getState()')).peers.length === 0, 'second client removed');
    await evaluate('window.ycljHost.stop()');
    assert.strictEqual((await evaluate('window.ycljHost.getState()')).status, 'stopped');
    const oldRelay = net.createServer();
    try {
      await new Promise((resolve, reject) => oldRelay.once('error', reject).listen(port, firstAddress.ip, resolve));
      const blocked = await control('/start', 'POST', {});
      assert.strictEqual(blocked.status, 'error');
      assert.match(blocked.message, /端口 .*已被其他服务占用/);
    } finally {
      await new Promise(resolve => oldRelay.close(resolve));
    }
    assert.strictEqual((await control('/start', 'POST', {})).status, 'starting');
    await waitFor(async () => (await control('/status')).status === 'running', 'agent restarted host');
    const originalDialog = dialog.showMessageBoxSync;
    let closePromptSeen = false;
    dialog.showMessageBoxSync = (_window, options) => {
      closePromptSeen = true;
      assert.deepStrictEqual(options.buttons, ['只关闭面板', '同时退出服务', '取消']);
      return 0;
    };
    win.close();
    await waitFor(() => BrowserWindow.getAllWindows().length === 0, 'window closed');
    dialog.showMessageBoxSync = originalDialog;
    assert.ok(closePromptSeen, 'closing window should prompt');
    assert.strictEqual((await control('/status')).status, 'running');
    assert.strictEqual((await control('/stop', 'POST', {})).status, 'stopped');
    app.emit('second-instance', {}, ['yclj-host-win']);
    await waitFor(() => BrowserWindow.getAllWindows().length === 1, 'window reopened');
    await waitFor(async () => (await control('/status')).status === 'running', 'opening window started service');
    console.log('[host-dashboard] PASS listen, pairing, agent control, duplicate relay blocked, close prompt keeps service, reopen starts service');
  } finally {
    if (client && client.readyState !== WebSocket.CLOSED) client.terminate();
    if (clientTwo && clientTwo.readyState !== WebSocket.CLOSED) clientTwo.terminate();
    app.quit();
  }
}

main().catch(error => {
  console.error(`[host-dashboard] FAIL ${error.message}`);
  app.exit(1);
});
