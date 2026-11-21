const { app, BrowserWindow, Menu, Tray, dialog, ipcMain, clipboard } = require('electron');
const { spawn } = require('child_process');
const net = require('net');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createOperatorManager } = require('./operator-link');
const { startLocalControl } = require('./local-control');

app.setName('yclj-host-win');

const configuredPort = Number(process.env.YCLJ_HOST_PORT || 18081);
const port = Number.isInteger(configuredPort) && configuredPort > 0 && configuredPort < 65536
  ? configuredPort : 18081;
const relayPath = path.join(__dirname, '..', 'relay', 'index.js');
const appIcon = path.join(__dirname, '..', 'build-assets', 'kunkunxin4.ico');
const backgroundMode = process.argv.includes('--background') || process.env.YCLJ_HOST_BACKGROUND === '1';
const previewMode = process.env.YCLJ_HOST_PREVIEW === '1';
const ownsInstance = app.requestSingleInstanceLock();

const state = {
  status: 'stopped',
  message: '',
  port,
  addresses: [],
  peers: [],
  session: { status: 'idle', pin: '', sessionId: '', message: '' },
  sessions: []
};

let mainWindow = null;
let relayProcess = null;
let lastRelayError = '';
let operatorLink = null;
let localControl = null;
let tray = null;
let startGeneration = 0;
let quitting = false;
let agentEvents = [];
let eventSequence = 0;

function localAddresses() {
  const found = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.internal || (entry.family !== 'IPv4' && entry.family !== 4)) continue;
      const ip = entry.address;
      if (!ip || ip.startsWith('169.254.') || /^198\.(18|19)\./.test(ip)) continue;
      if (found.some(item => item.ip === ip)) continue;
      const privateLan = ip.startsWith('192.168.') || ip.startsWith('10.') ||
        /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
      found.push({ name, ip, url: `ws://${ip}:${port}`, priority: privateLan ? 0 : 1 });
    }
  }
  return found.sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name, 'zh-CN'))
    .map(({ name, ip, url }) => ({ name, ip, url }));
}

function snapshot() {
  return { ...state, addresses: state.addresses.map(item => ({ ...item })), peers: state.peers.map(item => ({ ...item })), session: { ...state.session }, sessions: state.sessions.map(item => ({ ...item })), windowOpen: Boolean(mainWindow && !mainWindow.isDestroyed()) };
}

function recordAgentEvent(message) {
  const event = { ...message, sequence: ++eventSequence };
  if (typeof event.payload === 'string' && event.payload.length > 16384) {
    event.payload = `${event.payload.slice(0, 16384)}…`;
  }
  agentEvents.push(event);
  if (agentEvents.length > 400) agentEvents.shift();
}

function agentEventsSince(after) {
  return { cursor: eventSequence, events: agentEvents.filter(event => event.sequence > after) };
}

function pairWithPin(pin) {
  if (state.status !== 'running') throw new Error('请先启动本机服务');
  if (!/^\d{6}$/.test(pin)) throw new Error('请输入六位数字验证码');
  return operatorLink.pair(pin);
}

function emitState() {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('host:state', snapshot());
  updateTray();
}

function updateTray() {
  if (!tray) return;
  tray.setToolTip(`远程帮助主机端 · ${state.status === 'running' ? '服务已开启' : '服务未开启'}`);
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开主机端', click: openWindow },
    { label: '启动服务', enabled: state.status === 'stopped' || state.status === 'error', click: () => { void startRelay(); } },
    { label: '停止服务', enabled: state.status === 'running' || state.status === 'starting', click: stopRelay },
    { type: 'separator' },
    { label: '退出主机端', click: () => {
      const choice = closeChoice();
      if (choice === 0 && mainWindow && !mainWindow.isDestroyed()) mainWindow.destroy();
      if (choice === 1) app.quit();
    } }
  ]));
}

function closeChoice() {
  const options = {
    type: 'question',
    title: '关闭主机端',
    message: '关闭面板后，是否继续运行服务？',
    buttons: ['只关闭面板', '同时退出服务', '取消'],
    defaultId: 0,
    cancelId: 2,
    noLink: true
  };
  return mainWindow && !mainWindow.isDestroyed()
    ? dialog.showMessageBoxSync(mainWindow, options)
    : dialog.showMessageBoxSync(options);
}

function portAcceptsConnection(ip) {
  return new Promise(resolve => {
    const socket = net.createConnection({ host: ip, port });
    socket.setTimeout(500);
    socket.once('connect', () => { socket.destroy(); resolve(true); });
    socket.once('error', () => { socket.destroy(); resolve(false); });
    socket.once('timeout', () => { socket.destroy(); resolve(false); });
  });
}

function tokenFile() {
  return process.env.YCLJ_OPERATOR_TOKEN_FILE || path.join(app.getPath('userData'), 'operator-token');
}

function getOperatorToken() {
  const supplied = process.env.ADMIN_TOKEN || process.env.YCLJ_ADMIN_TOKEN;
  if (supplied && supplied.length >= 32) return supplied;
  const file = tokenFile();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (fs.existsSync(file)) {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (existing.length >= 32) return existing;
  }
  const token = crypto.randomBytes(32).toString('base64url');
  fs.writeFileSync(file, `${token}\n`, { mode: 0o600 });
  return token;
}

function updatePeer(event) {
  const id = String(event.id || '');
  if (!id) return;
  if (event.event === 'client_online') {
    const ip = String(event.ip || '').replace(/^::ffff:/, '');
    state.peers = state.peers.filter(peer => peer.id !== id);
    state.peers.push({
      id,
      name: String(event.name || '未知设备'),
      ip,
      status: '等待配对',
      connectedAt: event.time || new Date().toISOString()
    });
  } else if (event.event === 'client_offline') {
    state.peers = state.peers.filter(peer => peer.id !== id);
  } else {
    const peer = state.peers.find(item => item.id === id);
    if (!peer) return;
    if (event.event === 'client_paired') {
      peer.status = '已连接';
      peer.sessionId = String(event.sessionId || '');
    }
    if (event.event === 'client_unpaired') {
      peer.status = '等待新配对码';
      peer.sessionId = '';
    }
  }
  emitState();
}

function handleRelayLine(line) {
  if (line.includes('[relay] listening')) {
    state.status = 'running';
    state.message = '';
    emitState();
    return;
  }
  try {
    const event = JSON.parse(line);
    if (typeof event.event === 'string' && event.event.startsWith('client_')) updatePeer(event);
  } catch {
    // Human-readable relay messages are not peer events.
  }
}

async function startRelay() {
  if (relayProcess || state.status === 'starting') return snapshot();
  const generation = ++startGeneration;
  state.addresses = localAddresses();
  state.peers = [];
  state.status = 'starting';
  state.message = '';
  lastRelayError = '';
  emitState();

  const probeAddresses = ['127.0.0.1', ...state.addresses.map(item => item.ip)];
  const occupied = await Promise.all(probeAddresses.map(portAcceptsConnection));
  if (generation !== startGeneration) return snapshot();
  if (occupied.some(Boolean)) {
    state.status = 'error';
    state.message = `端口 ${port} 已被其他服务占用，请先关闭旧中继。`;
    emitState();
    return snapshot();
  }

  let child;
  try {
    child = spawn(process.execPath, [relayPath], {
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '1',
        RELAY_HOST: '0.0.0.0',
        RELAY_PORT: String(port),
        ADMIN_TOKEN: getOperatorToken()
      },
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (error) {
    state.status = 'error';
    state.message = `服务启动失败：${error.message}`;
    emitState();
    return snapshot();
  }

  relayProcess = child;
  let stdoutBuffer = '';
  child.stdout.on('data', chunk => {
    if (relayProcess !== child) return;
    stdoutBuffer += chunk.toString('utf8');
    const lines = stdoutBuffer.split(/\r?\n/);
    stdoutBuffer = lines.pop() || '';
    for (const line of lines) handleRelayLine(line);
  });
  child.stderr.on('data', chunk => {
    lastRelayError = (lastRelayError + chunk.toString('utf8')).slice(-4000);
  });
  child.on('error', error => {
    if (relayProcess !== child) return;
    state.status = 'error';
    state.message = `服务启动失败：${error.message}`;
    emitState();
  });
  child.on('exit', () => {
    if (relayProcess !== child) return;
    relayProcess = null;
    state.peers = [];
    state.status = 'error';
    state.message = /EADDRINUSE/.test(lastRelayError)
      ? `端口 ${port} 已被占用，请先关闭旧中继。`
      : '本机服务已停止，请点击重新启动。';
    emitState();
  });
  return snapshot();
}

function stopRelay() {
  ++startGeneration;
  if (operatorLink) operatorLink.disconnectAll();
  if (relayProcess) {
    const child = relayProcess;
    relayProcess = null;
    child.kill();
  }
  state.peers = [];
  state.sessions = [];
  state.session = { status: 'idle', pin: '', sessionId: '', message: '' };
  state.status = 'stopped';
  state.message = '';
  emitState();
  return snapshot();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    icon: appIcon,
    width: 680,
    height: 760,
    minWidth: 540,
    minHeight: 580,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.on('close', event => {
    if (quitting || previewMode) return;
    const choice = closeChoice();
    if (choice === 0) return;
    event.preventDefault();
    if (choice === 1) app.quit();
  });
  mainWindow.on('closed', () => { mainWindow = null; if (previewMode) app.quit(); });
}

function openWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) createWindow();
  else {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
  if (state.status === 'stopped' || state.status === 'error') void startRelay();
}

if (ownsInstance) app.on('second-instance', (_event, commandLine) => {
  if (commandLine.includes('--background')) return;
  openWindow();
});
else app.quit();

if (ownsInstance) app.whenReady().then(() => {
  const token = getOperatorToken();
  operatorLink = createOperatorManager({
    port,
    token,
    onState: (session, sessions) => { state.session = session; state.sessions = sessions; emitState(); },
    onEvent: recordAgentEvent
  });
  const controlPath = process.env.YCLJ_HOST_CONTROL_FILE || path.join(app.getPath('userData'), 'agent-control.json');
  localControl = startLocalControl({
    manifestPath: controlPath,
    token,
    getStatus: () => snapshot(),
    getEvents: agentEventsSince,
    pair: pairWithPin,
    send: message => {
      const peer = state.peers.find(item => item.id === message.peerId);
      operatorLink.send({ ...message, sessionId: peer ? peer.sessionId : message.sessionId });
    },
    run: message => {
      const peer = state.peers.find(item => item.id === message.peerId);
      if (message.peerId && !peer?.sessionId) throw new Error('该同事的连接已断开');
      return operatorLink.run(peer ? peer.sessionId : message.sessionId, message.script);
    },
    disconnect: peerId => {
      const peer = state.peers.find(item => item.id === peerId);
      return operatorLink.disconnect(peer ? peer.sessionId : peerId);
    },
    start: startRelay,
    stop: stopRelay,
    shutdown: () => app.quit()
  });
  tray = new Tray(appIcon);
  tray.on('double-click', openWindow);
  updateTray();
  ipcMain.handle('host:get-state', () => snapshot());
  ipcMain.handle('host:start', () => startRelay());
  ipcMain.handle('host:stop', () => stopRelay());
  ipcMain.handle('host:refresh-addresses', () => {
    state.addresses = localAddresses();
    emitState();
    return snapshot();
  });
  ipcMain.handle('host:copy-address', async (_event, ip) => {
    const address = state.addresses.find(item => item.ip === ip);
    if (!address) throw new Error('连接地址已变化，请刷新后重试');
    await clipboard.writeText(address.url);
    return true;
  });
  ipcMain.handle('host:copy-peer-ip', async (_event, id) => {
    const peer = state.peers.find(item => item.id === id);
    if (!peer) throw new Error('该同事已断开');
    await clipboard.writeText(peer.ip);
    return true;
  });
  ipcMain.handle('host:pair', async (_event, pin) => {
    try {
      await pairWithPin(String(pin || ''));
      return { ok: true, state: snapshot() };
    } catch (error) {
      return { ok: false, error: error.message, state: snapshot() };
    }
  });
  ipcMain.handle('host:disconnect-pair', (_event, id) => {
    const peer = state.peers.find(item => item.id === id);
    if (!peer || !peer.sessionId || !state.sessions.some(session => session.sessionId === peer.sessionId)) {
      throw new Error('该同事的连接已变化，请刷新后重试');
    }
    operatorLink.disconnect(peer.sessionId);
    return snapshot();
  });
  if (!backgroundMode) createWindow();
  startRelay();
  app.on('activate', () => {
    openWindow();
  });
});

app.on('before-quit', () => {
  quitting = true;
  stopRelay();
  if (localControl) localControl.close();
});
app.on('window-all-closed', () => {
  // Keep the relay and local agent control alive until the user explicitly exits.
});
