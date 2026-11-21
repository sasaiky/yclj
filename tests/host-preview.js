#!/usr/bin/env node

const { app, BrowserWindow } = require('electron');
const crypto = require('crypto');
const fs = require('fs');
const net = require('net');
const path = require('path');
const WebSocket = require('ws');

const previewData = path.join(__dirname, '..', 'work', 'host-preview');
fs.mkdirSync(previewData, { recursive: true });
app.setPath('userData', previewData);
process.env.YCLJ_HOST_CONTROL_FILE = path.join(previewData, 'agent-control.json');
process.env.ADMIN_TOKEN = crypto.randomBytes(32).toString('hex');
process.env.YCLJ_HOST_PREVIEW = '1';

const clients = [];
app.on('before-quit', () => clients.forEach(client => client.terminate()));

function waitFor(check, label, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const poll = async () => {
      try {
        const result = await check();
        if (result) return resolve(result);
        if (Date.now() >= deadline) return reject(new Error(`预览启动超时：${label}`));
        setTimeout(poll, 50);
      } catch (error) { reject(error); }
    };
    poll();
  });
}

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function connectClient(port, name) {
  const client = new WebSocket(`ws://127.0.0.1:${port}`);
  clients.push(client);
  const pin = new Promise((resolve, reject) => {
    client.once('error', reject);
    client.on('message', raw => {
      const message = JSON.parse(raw.toString('utf8'));
      if (message.type === 'session' && message.action === 'pin_generated') resolve(message.pin);
    });
  });
  await new Promise((resolve, reject) => { client.once('open', resolve); client.once('error', reject); });
  client.send(JSON.stringify({ type: 'auth', role: 'client', client_name: name }));
  return pin;
}

(async () => {
  process.env.YCLJ_HOST_PORT = String(await freePort());
  require('../electron-host-win/main.js');
  await app.whenReady();
  const win = await waitFor(() => BrowserWindow.getAllWindows()[0], '窗口');
  await waitFor(() => !win.webContents.isLoading(), '界面');
  await waitFor(async () => (await win.webContents.executeJavaScript('window.ycljHost.getState()')).status === 'running', '测试服务');
  const firstPin = await connectClient(Number(process.env.YCLJ_HOST_PORT), '演示同事 A');
  const secondPin = await connectClient(Number(process.env.YCLJ_HOST_PORT), '演示同事 B');
  const thirdPin = await connectClient(Number(process.env.YCLJ_HOST_PORT), '演示同事 C');
  fs.writeFileSync(path.join(previewData, 'demo-pins.json'), JSON.stringify({ B: secondPin, C: thirdPin }));
  await waitFor(async () => (await win.webContents.executeJavaScript('window.ycljHost.getState()')).peers.length === 3, '三位同事');
  const result = await win.webContents.executeJavaScript(`window.ycljHost.pair(${JSON.stringify(firstPin)})`);
  if (!result.ok) throw new Error(result.error);
  await waitFor(async () => (await win.webContents.executeJavaScript('window.ycljHost.getState()')).session.status === 'paired', '演示配对');
  win.setSize(680, 1180);
  win.setTitle('本机连接中心 · 三人预览');
  win.show();
  win.focus();
  console.log(`[host-preview] ready: port ${process.env.YCLJ_HOST_PORT}, three demo clients`);
})().catch(error => {
  console.error(`[host-preview] ${error.message}`);
  app.quit();
});
