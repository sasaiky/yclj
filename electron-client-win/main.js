const { app, BrowserWindow, ipcMain, clipboard, shell, desktopCapturer, screen } = require('electron');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const { stripVTControlCharacters } = require('node:util');
const WebSocket = require('ws');
const { createTerminalDisplay } = require('./terminal-display');
const { openSessionLog } = require('./session-log');
const { getIdentity, createPinOffer, signalUrl, isPublicAddress, lanRelayOptions, idPattern } = require('../public-assist/protocol');
const { connectPeer } = require('../public-assist/peer');

let pty = null;
try {
  pty = require('node-pty');
} catch {
  pty = null;
}

const appConfig = require('../package.json');
const DEFAULT_RELAY_URL = process.env.RELAY_URL || appConfig.ycljLanUrl || 'ws://127.0.0.1:18081';
const fixedPublicUrl = appConfig.ycljPublicUrl ? signalUrl(appConfig.ycljPublicUrl) : '';
const trustedOperatorIds = fixedPublicUrl ? appConfig.ycljTrustedOperators : process.env.YCLJ_ASSIST_TRUSTED_OPERATORS;
const trustedOperators = new Set((trustedOperatorIds || '')
  .split(',').map(item => item.trim()).filter(Boolean));
const APP_ICON = path.join(__dirname, '..', 'build-assets', 'kunkunxin4.ico');
const DEFAULT_SHELL = process.env.YCLJ_WIN_SHELL || 'powershell.exe';
const MAX_LOGS = 300;

const state = {
  relayUrl: fixedPublicUrl || process.env.YCLJ_PUBLIC_URL || DEFAULT_RELAY_URL,
  route: null,
  assistStatus: '',
  shell: DEFAULT_SHELL,
  connection: 'idle',
  authed: false,
  pin: null,
  peerIp: '',
  sessionId: null,
  screenSharing: false,
  screenShareBusy: false,
  terminalMode: 'none',
  lastUiStatus: '',
  lastUiPlan: [],
  logs: [],
  logNotice: null
};

let mainWindow = null;
let ws = null;
let assist = null;
let ptyProc = null;
let rawProc = null;
let sessionLog = null;
let logNoticeId = 0;
const terminalDisplay = createTerminalDisplay(recordTerminal);

function pinConsumed() {
  return Boolean(assist && state.connection === 'paired');
}

function getStateSnapshot() {
  return {
    addressEditable: !fixedPublicUrl,
    relayUrl: fixedPublicUrl ? '' : state.relayUrl,
    route: state.route,
    assistStatus: state.assistStatus,
    shell: state.shell,
    connection: state.connection,
    authed: state.authed,
    pin: state.pin,
    pinConsumed: pinConsumed(),
    peerIp: state.peerIp,
    sessionId: state.sessionId,
    screenShareAvailable: Boolean(assist?.canShareScreen()),
    screenSharing: state.screenSharing,
    screenShareBusy: state.screenShareBusy,
    terminalMode: state.terminalMode,
    lastUiStatus: state.lastUiStatus,
    lastUiPlan: [...state.lastUiPlan],
    logs: [...state.logs],
    logNotice: state.logNotice
  };
}

function emitState() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('client:state', getStateSnapshot());
  }
}

function appendLog(kind, text, detail = false) {
  const entry = {
    ts: new Date().toISOString(),
    kind,
    text: String(text || ''),
    detail
  };

  sessionLog?.append(entry);
  state.logs.push(entry);
  if (state.logs.length > MAX_LOGS) {
    const oldestDetail = state.logs.findIndex((item) => item.detail);
    state.logs.splice(oldestDetail === -1 ? 0 : oldestDetail, 1);
  }

  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('client:log', entry);
  }
}

function startSessionLog() {
  if (sessionLog) return;
  state.logNotice = null;
  try {
    sessionLog = openSessionLog(app.getPath('userData'), state.relayUrl);
  } catch {
    state.logNotice = { id: ++logNoticeId, message: '无法创建会话日志', warning: true };
  }
}

function finishSessionLog(reason) {
  if (!sessionLog) return;
  appendLog('info', `[session] closed (${reason})`);
  const notice = sessionLog.finish(() => app.getPath('desktop'));
  sessionLog = null;
  state.logNotice = { ...notice, id: ++logNoticeId };
}

function recordTerminal(kind, payload) {
  if (typeof payload !== 'string' || !payload) return;
  const text = stripVTControlCharacters(payload)
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  if (!text.trim()) return;
  for (let offset = 0; offset < text.length; offset += 4000) {
    appendLog(kind, text.slice(offset, offset + 4000), true);
  }
}

function emitUi(message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('client:ui', message);
  }
}

function sendJson(payload) {
  if (assist) {
    assist.send(payload);
    return;
  }
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    return;
  }

  ws.send(JSON.stringify(payload));
}

function updateConnection(next) {
  state.connection = next;
  emitState();
}

function resetSessionState() {
  state.pin = null;
  state.peerIp = '';
  state.sessionId = null;
  state.screenSharing = false;
  state.screenShareBusy = false;
  state.lastUiStatus = '';
  state.lastUiPlan = [];
  state.terminalMode = 'none';
  state.route = null;
}

function stopTerminal() {
  terminalDisplay.reset();
  if (ptyProc) {
    try {
      ptyProc.kill();
    } catch {
      // no-op
    }
    ptyProc = null;
  }

  if (rawProc) {
    try {
      rawProc.kill();
    } catch {
      // no-op
    }
    rawProc = null;
  }

  state.terminalMode = 'none';
}

function sendExec(stream, payload) {
  if (!state.sessionId) {
    return;
  }

  terminalDisplay.output(stream, payload);

  if (assist && payload.length > 8192) {
    for (const part of payload.match(/[\s\S]{1,8192}/gu)) {
      sendJson({ type: 'exec', stream, payload: part, session_id: state.sessionId });
    }
    return;
  }
  sendJson({
    type: 'exec',
    stream,
    payload,
    session_id: state.sessionId
  });
}

function writeShell(payload) {
  if (typeof payload !== 'string') {
    return;
  }

  if (ptyProc) {
    ptyProc.write(payload);
    return;
  }

  if (rawProc && rawProc.stdin && !rawProc.stdin.destroyed) {
    rawProc.stdin.write(assist && process.platform === 'win32' && payload.endsWith('\r') ? `${payload}\n` : payload);
  }
}

function startTerminal() {
  if (ptyProc || rawProc) {
    return;
  }

  if (pty) {
    try {
      ptyProc = pty.spawn(state.shell, [], {
        name: 'xterm-color',
        cols: 120,
        rows: 30,
        cwd: process.cwd(),
        env: process.env,
        useConptyDll: Boolean(assist) && process.platform === 'win32'
      });

      state.terminalMode = 'node-pty';
      appendLog('info', `[shell] started with node-pty: ${state.shell}`);
      emitState();

      const terminal = ptyProc;
      terminal.onData((data) => {
        if (ptyProc === terminal) sendExec('stdout', data);
      });

      terminal.onExit(({ exitCode, signal }) => {
        if (ptyProc !== terminal) return;
        appendLog('warn', `[shell] exited code=${exitCode} signal=${signal || ''}`.trim());
        sendJson({
          type: 'session',
          action: 'shell_exit',
          session_id: state.sessionId,
          code: exitCode,
          signal
        });
        ptyProc = null;
        state.terminalMode = 'none';
        emitState();
      });
      return;
    } catch (error) {
      appendLog('error', `[shell] node-pty failed, fallback to child_process: ${error.message}`);
      ptyProc = null;
      state.terminalMode = 'none';
    }
  }

  try {
    rawProc = spawn(state.shell, [], {
      cwd: process.cwd(),
      env: process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    });

    state.terminalMode = 'child_process';
    appendLog('warn', `[shell] started with child_process fallback: ${state.shell}`);
    emitState();

    const terminal = rawProc;
    terminal.stdout.setEncoding('utf8').on('data', data => {
      if (rawProc === terminal) sendExec('stdout', data);
    });

    terminal.stderr.setEncoding('utf8').on('data', data => {
      if (rawProc === terminal) sendExec('stderr', data);
    });

    terminal.on('error', error => {
      if (rawProc === terminal) appendLog('error', `[shell] ${error.message}`);
    });

    terminal.on('close', (code, signal) => {
      if (rawProc !== terminal) return;
      appendLog('warn', `[shell] exited code=${code} signal=${signal || ''}`.trim());
      sendJson({
        type: 'session',
        action: 'shell_exit',
        session_id: state.sessionId,
        code,
        signal
      });
      rawProc = null;
      state.terminalMode = 'none';
      emitState();
    });
  } catch (error) {
    appendLog('error', `[shell] failed to start shell: ${error.message}`);
    state.terminalMode = 'none';
    emitState();
  }
}

function handleUiMessage(message) {
  const action = message.action;
  const data = message.data;

  if (action === 'status' || action === 'update_status') {
    if (typeof data === 'string') {
      state.lastUiStatus = data;
    } else if (data && typeof data === 'object') {
      state.lastUiStatus = String(data.text || data.message || '');
    }
  }

  if (action === 'plan') {
    state.lastUiPlan = Array.isArray(data)
      ? data.map((item) => String(item))
      : [];
  }

  if (action === 'clear') {
    state.lastUiStatus = '';
    state.lastUiPlan = [];
  }

  emitUi(message);
  emitState();
}

function handleRelayMessage(raw) {
  let message = null;
  try {
    message = JSON.parse(raw.toString('utf8'));
  } catch {
    appendLog('error', '[relay] invalid JSON received');
    return;
  }

  if (message.type === 'auth') {
    if (message.status === 'ok') {
      state.authed = true;
      updateConnection('connected');
      appendLog('ok', '[auth] client authenticated');
    } else {
      state.authed = false;
      appendLog('error', `[auth] failed: ${JSON.stringify(message)}`);
    }
    emitState();
    return;
  }

  if (message.type === 'session' && message.action === 'pin_generated') {
    state.pin = String(message.pin || '------');
    state.peerIp = String(message.ip || ws?._socket?.localAddress || '').replace(/^::ffff:/, '');
    appendLog('ok', `[session] PIN generated: ${state.pin}`);
    emitState();
    return;
  }

  if (message.type === 'session' && message.action === 'paired') {
    state.sessionId = message.session_id || null;
    state.pin = String(message.pin || state.pin || '');
    startSessionLog();
    updateConnection('paired');
    appendLog('ok', `[session] paired. session=${state.sessionId}`);
    startTerminal();
    emitState();
    return;
  }

  if (message.type === 'session' && message.action === 'peer_disconnected') {
    appendLog('warn', '[session] operator disconnected; generating a new PIN');
    connectRelay({ relayUrl: state.relayUrl, shell: state.shell }, 'peer_disconnected');
    return;
  }

  if (message.type === 'exec') {
    if (!state.sessionId || message.session_id !== state.sessionId) {
      return;
    }

    if (message.stream === 'stdin') {
      terminalDisplay.command(message.payload);
      writeShell(message.payload);
    }
    return;
  }

  if (message.type === 'ui') {
    if (!state.sessionId || message.session_id !== state.sessionId) {
      return;
    }

    handleUiMessage(message);
    return;
  }

  if (message.type === 'error') {
    appendLog('error', `[relay:${message.code || 'error'}] ${message.message || ''}`);
    return;
  }

  appendLog('info', `[relay] ${JSON.stringify(message)}`);
}

function disconnectRelay(reason) {
  if (assist) {
    const peer = assist;
    assist = null;
    peer.close();
  }
  stopTerminal();
  finishSessionLog(reason);

  if (ws) {
    const instance = ws;
    ws = null;

    if (instance.readyState === WebSocket.OPEN || instance.readyState === WebSocket.CONNECTING) {
      try {
        instance.close(1000, reason || 'manual_disconnect');
      } catch {
        // no-op
      }
    }
  }

  state.authed = false;
  state.assistStatus = '';
  resetSessionState();
  updateConnection('idle');
}

function connectRelay({ relayUrl, shell }, closeReason = 'reconnect') {
  const options = lanRelayOptions(relayUrl || state.relayUrl);
  if (relayUrl) {
    state.relayUrl = relayUrl;
  }

  if (shell) {
    state.shell = shell;
  }

  disconnectRelay(closeReason);

  appendLog('info', `[relay] connecting -> ${state.relayUrl}`);
  updateConnection('connecting');

  const socket = new WebSocket(state.relayUrl, options);
  ws = socket;

  socket.on('open', () => {
    if (ws !== socket) return;
    appendLog('ok', '[relay] websocket connected');
    sendJson({
      type: 'auth',
      role: 'client',
      client_name: os.hostname(),
      platform: process.platform
    });
  });

  socket.on('message', (raw) => {
    if (ws === socket) handleRelayMessage(raw);
  });

  socket.on('close', (code, reasonBuf) => {
    if (ws !== socket) return;
    ws = null;
    const reason = reasonBuf ? reasonBuf.toString() : '';
    appendLog('warn', `[relay] closed code=${code} reason=${reason}`.trim());
    stopTerminal();
    finishSessionLog('connection_closed');
    state.authed = false;
    resetSessionState();
    state.connection = 'disconnected';
    emitState();
  });

  socket.on('error', (error) => {
    if (ws !== socket) return;
    state.assistStatus = error.message;
    appendLog('error', `[relay] websocket error: ${error.message}`);
    emitState();
  });
}

function startPublic(relayUrl, shell, closeReason = 'reconnect') {
  if (!trustedOperators.size || [...trustedOperators].some(id => !idPattern.test(id))) {
    throw new Error('客户端尚未配置可信协助设备');
  }
  const identity = getIdentity(app.getPath('userData'));
  const invite = createPinOffer(relayUrl, identity.id, state.pin);
  disconnectRelay(closeReason);
  if (shell) state.shell = shell;
  state.relayUrl = invite.url;
  if (['invite_expired', 'pin_conflict'].includes(closeReason)) state.assistStatus = '正在生成新验证码…';
  updateConnection('connecting');

  const peer = connectPeer({ identity, invite, operator: false, trustedOperators });
  assist = peer;
  peer.on('invitation', pin => {
    state.pin = pin;
    state.authed = true;
    state.assistStatus = '';
    updateConnection('connected');
  });
  peer.on('pairing', () => {
    updateConnection('connecting');
  });
  peer.on('ready', session => {
    state.sessionId = session;
    state.assistStatus = '';
    startSessionLog();
    updateConnection('paired');
    startTerminal();
  });
  peer.on('route', route => {
    state.route = route;
    emitState();
  });
  peer.on('screen', result => {
    if (assist !== peer) return;
    if (result) {
      state.screenSharing = result.active;
      state.screenShareBusy = false;
      state.assistStatus = result.error || '';
    }
    emitState();
  });
  peer.on('message', message => {
    if (assist !== peer || message.session_id !== state.sessionId) return;
    if (message.type === 'exec') {
      terminalDisplay.command(message.payload);
      writeShell(message.payload);
    } else {
      handleUiMessage(message);
    }
  });
  peer.on('close', (code, message) => {
    if (assist !== peer) return;
    const expiredWhileWaiting = code === 'invite_expired' && state.connection !== 'paired';
    const retryCollision = code === 'pin_conflict' && closeReason !== 'pin_conflict';
    if (expiredWhileWaiting || retryCollision) {
      try {
        startPublic(state.relayUrl, undefined, code);
        return;
      } catch (error) {
        message = `生成新验证码失败，${error.message}`;
      }
    }
    disconnectRelay(code);
    state.assistStatus = message;
    appendLog('info', `[assist] ${message}`);
    updateConnection('disconnected');
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    icon: APP_ICON,
    width: 460,
    height: 668,
    useContentSize: true,
    minWidth: 460,
    minHeight: 650,
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  mainWindow.on('close', () => { if (assist) disconnectRelay('app_exit'); });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(() => {
  createWindow();

  ipcMain.handle('client:get-state', () => getStateSnapshot());

  ipcMain.handle('client:start', (_event, config = {}) => {
    const relayUrl = fixedPublicUrl || config.relayUrl || state.relayUrl;
    if (isPublicAddress(relayUrl)) startPublic(relayUrl, config.shell);
    else connectRelay({ ...config, relayUrl });
    return getStateSnapshot();
  });

  ipcMain.handle('client:disconnect', () => {
    disconnectRelay('manual_disconnect');
    return getStateSnapshot();
  });

  ipcMain.handle('client:toggle-screen-share', async event => {
    const peer = assist;
    if (event.sender !== mainWindow?.webContents || event.senderFrame !== event.sender.mainFrame ||
        !peer?.canShareScreen() || state.screenShareBusy) return getStateSnapshot();

    state.screenShareBusy = true;
    state.assistStatus = '';
    emitState();
    try {
      let sourceId;
      if (!state.screenSharing) {
        const primaryId = String(screen.getPrimaryDisplay().id);
        const sources = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: { width: 0, height: 0 } });
        const primary = sources.find(source => source.display_id === primaryId) || (sources.length === 1 ? sources[0] : null);
        if (!primary) throw new Error('找不到主屏幕');
        sourceId = primary.id;
      }
      if (assist === peer && !peer.shareScreen(sourceId)) throw new Error('屏幕共享不可用');
    } catch (error) {
      if (assist === peer) {
        state.screenShareBusy = false;
        state.assistStatus = error.message;
      }
    }
    return getStateSnapshot();
  });

  ipcMain.handle('client:open-log', async () => {
    const file = state.logNotice?.path;
    if (!file) return;
    const error = await shell.openPath(file);
    if (error) throw new Error(error);
  });

  ipcMain.handle('client:copy-pin', async () => {
    if (pinConsumed() || !/^\d{6}$/.test(state.pin || '') || !['connected', 'paired'].includes(state.connection)) {
      throw new Error('当前没有可复制的配对码');
    }
    if (assist) {
      await clipboard.writeText(fixedPublicUrl ? state.pin : `验证码：${state.pin}\n连接地址：${state.relayUrl}`);
      return { copiedAddress: !fixedPublicUrl };
    }
    await clipboard.writeText(`验证码：${state.pin}${state.peerIp ? `\nIP：${state.peerIp}` : ''}`);
    return { copiedIp: Boolean(state.peerIp) };
  });

  ipcMain.handle('client:refresh-pin', () => {
    if (assist && state.connection === 'connected') {
      startPublic(state.relayUrl);
      return getStateSnapshot();
    }
    if (state.connection !== 'connected' || !state.authed || !/^\d{6}$/.test(state.pin || '')) {
      throw new Error('只有等待配对时才能刷新配对码');
    }
    appendLog('info', '[session] refreshing PIN');
    connectRelay({ relayUrl: state.relayUrl, shell: state.shell });
    return getStateSnapshot();
  });

  ipcMain.handle('client:clear-logs', () => {
    state.logs = [];
    emitState();
    return true;
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  disconnectRelay('app_exit');
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('before-quit', () => {
  if (ws || assist || sessionLog) disconnectRelay('app_exit');
});
