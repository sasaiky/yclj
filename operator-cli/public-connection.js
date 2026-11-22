const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require('ws');
const { readInvite, signalUrl } = require('../public-assist/protocol');
const { deviceDirectory } = require('./settings');

function openPublic(config, relayOnly) {
  const address = config.pin ? signalUrl(config.url) : readInvite(config.invitation).url;
  const bundledViewer = path.join(__dirname, '..', 'viewer', process.platform === 'win32'
    ? 'YCLJViewer.exe' : 'YCLJ Viewer.app/Contents/MacOS/YCLJViewer');
  let nativeViewer = fs.existsSync(bundledViewer) ? bundledViewer : undefined;
  if (!nativeViewer && process.platform === 'darwin' && config.viewScreen && address.startsWith('wss:') && process.env.YCLJ_MAC_RTC !== 'electron') {
    try { nativeViewer = require('../public-assist/rtc-webkit').buildWebKit(); } catch (error) {
      console.error(`[operator] WebKit 启动前准备失败，使用 Electron (${error.message})`);
    }
  }
  const executable = nativeViewer ? process.execPath : require('electron');
  const profile = fs.mkdtempSync(path.resolve(os.tmpdir(), 'yclj-operator-'));
  const env = { ...process.env };
  if (!nativeViewer) delete env.ELECTRON_RUN_AS_NODE;
  const child = spawn(executable, [path.join(__dirname, '..', 'public-assist', 'operator-sidecar.js')], {
    env, stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true
  });
  child.stderr.resume();
  const transport = new EventEmitter();
  transport.readyState = WebSocket.CONNECTING;
  let manual = false;
  let outcome;
  let killTimer;

  child.on('spawn', () => {
    if (manual) return child.kill();
    child.send({ ...config, relayOnly, deviceDirectory, profile, nativeViewer }, error => {
      if (error && !manual) transport.emit('error', error);
    });
    config.operatorPassword = undefined;
    transport.readyState = WebSocket.OPEN;
  });
  child.on('message', message => {
    if (manual) return;
    if (message.type === 'assist_closed') {
      outcome = message;
      transport.readyState = WebSocket.CLOSING;
      return;
    }
    transport.emit('message', JSON.stringify(message));
  });
  child.on('error', error => { if (!manual) transport.emit('error', error); });
  child.on('close', (exitCode) => {
    clearTimeout(killTimer);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch (error) {
      console.error(`[operator] 无法清理临时目录 ${profile} (${error.code})`);
    }
    transport.readyState = WebSocket.CLOSED;
    const code = manual ? 1000 : outcome?.code || (exitCode ? 'sidecar_failed' : 'peer_disconnected');
    transport.emit('close', code, outcome?.message);
  });

  transport.send = raw => {
    if (transport.readyState !== WebSocket.OPEN || !child.connected) return;
    child.send(JSON.parse(raw), error => { if (error && !manual) transport.emit('error', error); });
  };
  transport.close = () => {
    if (transport.readyState >= WebSocket.CLOSING) return;
    manual = true;
    transport.readyState = WebSocket.CLOSING;
    // Let the sidecar exit before the parent closes IPC so ChildProcess emits 'close'.
    if (child.connected) child.send({ type: 'close' }, error => { if (error) child.kill(); });
    killTimer = setTimeout(() => child.kill(), 3000);
  };
  return transport;
}

module.exports = { openPublic };
