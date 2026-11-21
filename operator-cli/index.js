#!/usr/bin/env node

const WebSocket = require('ws');
const readline = require('readline');
const chalk = require('chalk');
const fs = require('node:fs');
const { getIdentity, isPublicAddress, lanRelayOptions, pinPattern, signalUrl } = require('../public-assist/protocol');
const { openPublic } = require('./public-connection');
const { deviceDirectory, configFile, lanConfigFile, loadConfiguredUrl, getLanToken, readConfig } = require('./settings');
const { askPassphrase } = require('./device-transfer');
const { createScriptRunner } = require('../electron-host-win/script-runner');
const { terminalText } = require('./terminal-text');

const args = process.argv.slice(2);
const showHelp = args.includes('--help') || args.includes('-h');
const legacyInvite = args[0] === '--invite';
let adminToken = process.env.ADMIN_TOKEN || process.env.YCLJ_ADMIN_TOKEN;

const setupHint = [
  '有旧电脑的迁移文件：node tools/assist-config.js import-device 文件.yclj-device',
  '首次配置公网：node tools/assist-config.js init wss://你的服务器/assist',
  '首次配置局域网：node tools/assist-config.js init-lan ws://你的局域网IP:18081'
].join('\n');

function usage() {
  console.log('Usage: yclj <PIN> [--url <connection address>] [--lan]');
  console.log('       yclj --device-id');
  console.log('Options for the public server: --run <script.ps1>, --relay-only');
  console.log('For an account with an extra server password: --ask-password');
  console.log('LAN uses the local operator token or ADMIN_TOKEN. The public server requires a registered device ID.');
  console.log(setupHint);
}

if (showHelp || !args.length) {
  usage();
  process.exit(0);
}

if (args.length === 1 && args[0] === '--device-id') {
  try { console.log(getIdentity(deviceDirectory).id); } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
  return;
}

if (!legacyInvite && !pinPattern.test(args[0] || '')) {
  usage();
  process.exit(1);
}

const targetPin = args[0];
let relayUrl;
let script;
let relayOnly = false;
let useLan = false;
let askPassword = false;
for (let i = legacyInvite ? 2 : 1; i < args.length; i += 1) {
  if (args[i] === '--url' && args[i + 1] && !legacyInvite) relayUrl = args[++i];
  else if (args[i] === '--lan' && !legacyInvite) useLan = true;
  else if (args[i] === '--ask-password' && !legacyInvite) askPassword = true;
  else if (args[i] === '--relay-only') relayOnly = true;
  else if (args[i] === '--run' && args[i + 1] && !script) {
    try { script = { content: fs.readFileSync(args[++i], 'utf8').replace(/^\uFEFF/, '') }; } catch (error) {
      console.error(error.message);
      process.exit(1);
    }
  } else {
    usage();
    process.exit(1);
  }
}

if (!legacyInvite && !relayUrl) {
  try {
    if (useLan) relayUrl = loadConfiguredUrl(lanConfigFile);
    else relayUrl = process.env.RELAY_URL || process.env.YCLJ_PUBLIC_URL ||
      (adminToken ? 'ws://127.0.0.1:8080' : loadConfiguredUrl(configFile) || loadConfiguredUrl(lanConfigFile));
  } catch (error) {
    console.error(error.message);
    console.error(setupHint);
    process.exit(1);
  }
  if (!relayUrl) {
    console.error(useLan
      ? '请先运行 node tools/assist-config.js init-lan 设置局域网地址。'
      : `还没有默认连接地址。\n${setupHint}`);
    process.exit(1);
  }
}

let publicMode;
try { publicMode = legacyInvite || isPublicAddress(relayUrl); } catch {
  console.error('无效的连接地址');
  process.exit(1);
}
if (!publicMode) {
  try {
    adminToken ||= getLanToken();
    if (!adminToken) throw new Error('未找到局域网操作密钥。请先用配置 CLI 启动局域网服务，或设置 ADMIN_TOKEN。');
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
if (!publicMode && (script || relayOnly || askPassword)) {
  usage();
  process.exit(1);
}

const isTTY = Boolean(process.stdout.isTTY);
let sessionId = null;
let askedJoin = false;
let terminated = false;
let paired = false;

let ws;
let rl;
const runner = script && createScriptRunner(message => {
  if (!sessionId || ws.readyState !== WebSocket.OPEN) throw new Error('协助会话已断开');
  sendObject({ ...message, session_id: sessionId });
});

function writeLine(text) {
  process.stdout.write(`${text}\n`);
}

function writeJson(message) {
  writeLine(JSON.stringify(message).replace(/[\x7f-\x9f]/g, char =>
    `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`));
}

function prettyInfo(text) {
  text = terminalText(text);
  if (isTTY) {
    writeLine(chalk.cyan(text));
  } else {
    writeLine(text);
  }
}

function prettyWarn(text) {
  text = terminalText(text);
  if (isTTY) {
    writeLine(chalk.yellow(text));
  } else {
    writeLine(text);
  }
}

function prettyError(text) {
  text = terminalText(text);
  if (isTTY) {
    writeLine(chalk.red(text));
  } else {
    writeLine(text);
  }
}

function renderPrompt() {
  if (rl && process.stdin.isTTY) {
    rl.setPrompt('yclj> ');
    rl.prompt();
  }
}

function sendObject(message) {
  if (ws.readyState !== WebSocket.OPEN) {
    prettyWarn('[operator] relay not connected, message dropped');
    return;
  }
  if (publicMode && !sessionId) {
    prettyWarn('[operator] 等待协助连接');
    return;
  }
  ws.send(JSON.stringify(message));
}

function ensureSessionForInteractive() {
  if (sessionId) {
    return true;
  }
  prettyWarn('[operator] waiting for paired session; command ignored');
  return false;
}

function toPlanItems(value) {
  return String(value || '')
    .split(/[\uFF0C,]/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function handleMacro(line) {
  const [macro, ...restParts] = line.trim().split(/\s+/);
  const restText = restParts.join(' ').trim();

  if (macro === '/exit') {
    terminated = true;
    ws.close(1000, 'operator_exit');
    return;
  }

  if (macro === '/help') {
    prettyInfo('Macros: /ui <text>, /lb <a,b>, /clear, /exit');
    return;
  }

  if (!ensureSessionForInteractive()) {
    return;
  }

  if (macro === '/ui') {
    sendObject({
      type: 'ui',
      action: 'status',
      data: restText,
      session_id: sessionId
    });
    return;
  }

  if (macro === '/lb') {
    sendObject({
      type: 'ui',
      action: 'plan',
      data: toPlanItems(restText),
      session_id: sessionId
    });
    return;
  }

  if (macro === '/clear') {
    sendObject({
      type: 'ui',
      action: 'clear',
      session_id: sessionId
    });
    return;
  }

  prettyWarn(`[operator] unknown macro: ${macro}`);
}

function handleInputLine(line) {
  const raw = line || '';
  const trimmed = raw.trim();

  if (!trimmed) {
    renderPrompt();
    return;
  }

  if (trimmed.startsWith('{')) {
    try {
      const json = JSON.parse(trimmed);
      if (!json.session_id && sessionId && (json.type === 'ui' || json.type === 'exec')) {
        json.session_id = sessionId;
        sendObject(json);
      } else {
        sendObject(json);
      }
      renderPrompt();
      return;
    } catch {
      // fall through to command route
    }
  }

  if (trimmed.startsWith('/')) {
    handleMacro(trimmed);
    renderPrompt();
    return;
  }

  if (!ensureSessionForInteractive()) {
    renderPrompt();
    return;
  }

  sendObject({
    type: 'exec',
    stream: 'stdin',
    payload: `${raw}\r`,
    session_id: sessionId
  });

  renderPrompt();
}

function outputMessage(message) {
  if (message.type === 'session' && message.action === 'paired') {
    sessionId = message.session_id;
    paired = true;
    if (runner) {
      Promise.resolve().then(() => runner.start(script.content)).then(result => {
        writeJson(result);
        if (result.status !== 'finished' || result.exitCode !== 0) process.exitCode = 1;
      }).catch(error => {
        console.error(error.message);
        process.exitCode = 1;
      }).finally(() => {
        terminated = true;
        ws.close(1000, 'script_done');
      });
      return;
    }
  }
  if (message.type === 'session' && message.action === 'peer_disconnected') sessionId = null;
  if (runner && message.type === 'exec') return runner.handle(message);
  if (runner) {
    if (message.type === 'error') console.error(terminalText(message.message));
    if (message.type === 'session' && message.action === 'route') console.error(`[session] path=${message.route}`);
    return;
  }
  if (!isTTY) {
    writeJson(message);
    return;
  }

  if (message.type === 'exec') {
    const payload = typeof message.payload === 'string' ? terminalText(message.payload) : '';
    if (message.stream === 'stderr') {
      process.stdout.write(chalk.red(payload));
    } else {
      process.stdout.write(chalk.white(payload));
    }
    return;
  }

  if (message.type === 'error') {
    prettyError(`[relay:${message.code || 'error'}] ${message.message || ''}`);
    return;
  }

  if (message.type === 'session') {
    if (message.action === 'paired') {
      prettyInfo(publicMode ? '[session] 本次协助已连接' : `[session] paired with PIN ${message.pin}, session=${sessionId}`);
      prettyInfo('[session] input is now active (/help for macros)');
      return;
    }

    if (message.action === 'peer_disconnected') {
      prettyWarn('[session] peer disconnected, waiting for next join');
      return;
    }
    if (message.action === 'route') {
      prettyInfo(`[session] ${{ direct: '直连', relay: '中继', recovering: '正在恢复连接' }[message.route]}`);
      return;
    }
    if (message.action === 'awaiting_approval') {
      prettyInfo(`[session] 等待设备 ${message.device} 确认`);
      return;
    }
    if (message.action === 'connecting') {
      prettyInfo('[session] 验证码已匹配，正在建立加密连接');
      return;
    }

    prettyInfo(`[session] ${message.action}`);
    return;
  }

  if (message.type === 'auth') {
    prettyInfo(`[auth] ${message.status}`);
    return;
  }

  if (message.type === 'ui') {
    prettyInfo(`[ui] action=${message.action || 'unknown'}`);
    return;
  }

  prettyInfo(JSON.stringify(message));
}

function onOpen() {
  if (publicMode) return;
  sendObject({
    type: 'auth',
    role: 'operator',
    token: adminToken
  });
}

function onMessage(raw) {
  let message = null;
  try {
    message = JSON.parse(raw.toString('utf8'));
  } catch {
    prettyError('[operator] invalid JSON from relay');
    return;
  }

  if (!publicMode && !askedJoin && message.type === 'auth' && message.status === 'ok') {
    askedJoin = true;
    sendObject({
      type: 'session',
      action: 'join',
      pin: targetPin
    });
  }

  outputMessage(message);
  renderPrompt();
}

function onClose(code, reasonBuffer) {
  sessionId = null;
  runner?.disconnect();
  if (publicMode && !paired && !terminated) process.exitCode = 1;
  if (!terminated) {
    const reason = reasonBuffer ? reasonBuffer.toString() : '';
    const description = `[operator] ${publicMode ? '协助连接已结束' : 'relay closed'} (${code}) ${reason}`.trim();
    if (script) console.error(terminalText(description));
    else prettyWarn(description);
  }

  rl?.close();
}

async function start() {
  if (publicMode) {
    const config = legacyInvite ? { invitation: args[1] } : { pin: targetPin, url: signalUrl(relayUrl) };
    if (!legacyInvite) {
      if (fs.existsSync(configFile)) {
        const saved = readConfig(configFile);
        askPassword ||= saved.requirePassword === true && saved.serverUrl === config.url;
      }
      if (askPassword) config.operatorPassword = await askPassphrase('协助口令：');
    }
    ws = openPublic(config, relayOnly);
  } else {
    ws = new WebSocket(relayUrl, lanRelayOptions(relayUrl));
  }
  rl = script ? null : readline.createInterface({
    input: process.stdin,
    crlfDelay: Infinity,
    terminal: Boolean(process.stdin.isTTY)
  });

  ws.on('open', onOpen);
  ws.on('message', onMessage);
  ws.on('close', onClose);
  ws.on('error', error => prettyError(`[operator] websocket error: ${error.message}`));
  rl?.on('line', handleInputLine);
  rl?.on('close', () => {
    if (!terminated && (ws.readyState === WebSocket.OPEN || (publicMode && ws.readyState === WebSocket.CONNECTING))) {
      ws.close(1000, 'stdin_closed');
    }
  });

  process.on('SIGINT', () => {
    terminated = true;
    ws.close(1000, 'sigint');
  });

  if (isTTY && !script) {
    prettyInfo(publicMode ? '[operator] 正在连接协助服务器' : `[operator] connecting to ${relayUrl}`);
    renderPrompt();
  }
}

start().catch(error => {
  console.error(terminalText(error.message));
  process.exitCode = 1;
});
