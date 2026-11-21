#!/usr/bin/env node

const { app, BrowserWindow } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const net = require('net');
const path = require('path');

const previewData = path.join(__dirname, '..', 'work', 'client-copy-preview');
fs.mkdirSync(previewData, { recursive: true });
app.setPath('userData', previewData);

let relay = null;
app.on('before-quit', () => {
  if (relay) relay.kill();
});

async function freePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  return port;
}

async function waitFor(check, label) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    const value = await check();
    if (value) return value;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`预览启动超时：${label}`);
}

function startRelay(port) {
  return new Promise((resolve, reject) => {
    relay = spawn(process.execPath, [path.join(__dirname, '..', 'relay', 'index.js')], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', RELAY_HOST: '127.0.0.1', RELAY_PORT: String(port), ADMIN_TOKEN: 'client-copy-preview-token' },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    relay.stdout.on('data', chunk => { if (chunk.toString().includes('[relay] listening')) resolve(); });
    relay.once('error', reject);
    relay.once('exit', code => reject(new Error(`预览中继已退出：${code}`)));
  });
}

(async () => {
  const port = await freePort();
  const relayUrl = `ws://127.0.0.1:${port}`;
  process.env.RELAY_URL = relayUrl;
  await startRelay(port);
  require('../electron-client-win/main.js');
  await app.whenReady();
  const win = await waitFor(() => BrowserWindow.getAllWindows()[0], '窗口');
  await waitFor(() => !win.webContents.isLoading(), '界面');
  await win.webContents.executeJavaScript(`window.ycljClient.start({ relayUrl: ${JSON.stringify(relayUrl)} })`);
  await waitFor(async () => /^\d{6}$/.test((await win.webContents.executeJavaScript('window.ycljClient.getState()')).pin || ''), '验证码');
  win.setTitle('同事端 · 复制验证码和 IP 预览');
  win.show();
  win.focus();
  console.log(`[client-copy-preview] ready: ${relayUrl}`);
})().catch(error => {
  console.error(`[client-copy-preview] ${error.message}`);
  app.quit();
});
