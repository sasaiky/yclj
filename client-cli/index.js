#!/usr/bin/env node

const WebSocket = require('ws');
const chalk = require('chalk');
const ora = require('ora');
const os = require('os');
const { spawn } = require('child_process');
const { lanRelayOptions } = require('../public-assist/protocol');

let pty = null;
try {
  pty = require('node-pty');
} catch {
  pty = null;
}

const args = process.argv.slice(2);
const showHelp = args.includes('--help') || args.includes('-h');

if (showHelp) {
  console.log('Usage: yclj-client [--url ws://host:port] [--shell /bin/bash]');
  console.log('Env: RELAY_URL, YCLJ_SHELL');
  process.exit(0);
}

let relayUrl = process.env.RELAY_URL || 'ws://127.0.0.1:8080';
let forcedShell = process.env.YCLJ_SHELL || '';

for (let i = 0; i < args.length; i += 1) {
  if (args[i] === '--url') {
    relayUrl = args[i + 1] || relayUrl;
    i += 1;
  } else if (args[i] === '--shell') {
    forcedShell = args[i + 1] || forcedShell;
    i += 1;
  }
}

const defaultShell = process.platform === 'win32'
  ? (process.env.ComSpec || 'cmd.exe')
  : (process.env.SHELL || '/bin/bash');
const shellCommand = forcedShell || defaultShell;

let ws;
try {
  ws = new WebSocket(relayUrl, lanRelayOptions(relayUrl));
} catch (error) {
  console.error(error.message);
  process.exit(1);
}

let sessionId = null;
let spinner = null;
let nodePtyProcess = null;
let rawProcess = null;
let shuttingDown = false;

function print(text) {
  process.stdout.write(`${text}\n`);
}

function ensureSpinnerStart(text) {
  if (!spinner) {
    spinner = ora(text).start();
    return;
  }
  spinner.text = text;
  if (!spinner.isSpinning) {
    spinner.start();
  }
}

function stopSpinnerSuccess(text) {
  if (spinner) {
    spinner.succeed(text);
    spinner = null;
  } else {
    print(chalk.green(text));
  }
}

function stopSpinnerFail(text) {
  if (spinner) {
    spinner.fail(text);
    spinner = null;
  } else {
    print(chalk.red(text));
  }
}

function stopSpinner() {
  if (spinner) {
    spinner.stop();
    spinner = null;
  }
}

function sendObject(message) {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(message));
}

function sendExec(stream, payload) {
  if (!sessionId) {
    return;
  }
  sendObject({
    type: 'exec',
    stream,
    payload,
    session_id: sessionId
  });
}

function writeToShell(payload) {
  if (typeof payload !== 'string') {
    return;
  }

  if (nodePtyProcess) {
    nodePtyProcess.write(payload);
    return;
  }

  if (rawProcess && rawProcess.stdin && !rawProcess.stdin.destroyed) {
    rawProcess.stdin.write(payload);
  }
}

function stopTerminal() {
  if (nodePtyProcess) {
    try {
      nodePtyProcess.kill();
    } catch {
      // no-op
    }
    nodePtyProcess = null;
  }

  if (rawProcess) {
    try {
      rawProcess.kill();
    } catch {
      // no-op
    }
    rawProcess = null;
  }
}

function startTerminal() {
  if (nodePtyProcess || rawProcess) {
    return;
  }

  if (pty) {
    nodePtyProcess = pty.spawn(shellCommand, [], {
      name: 'xterm-color',
      cols: 120,
      rows: 30,
      cwd: process.cwd(),
      env: process.env
    });

    nodePtyProcess.onData((data) => {
      sendExec('stdout', data);
    });

    nodePtyProcess.onExit(({ exitCode, signal }) => {
      sendObject({
        type: 'session',
        action: 'shell_exit',
        session_id: sessionId,
        code: exitCode,
        signal
      });
      nodePtyProcess = null;
    });

    print(chalk.green(`[client] shell started with node-pty: ${shellCommand}`));
    return;
  }

  rawProcess = spawn(shellCommand, [], {
    cwd: process.cwd(),
    env: process.env,
    stdio: ['pipe', 'pipe', 'pipe']
  });

  rawProcess.stdout.on('data', (buf) => sendExec('stdout', buf.toString('utf8')));
  rawProcess.stderr.on('data', (buf) => sendExec('stderr', buf.toString('utf8')));

  rawProcess.on('close', (code, signal) => {
    sendObject({
      type: 'session',
      action: 'shell_exit',
      session_id: sessionId,
      code,
      signal
    });
    rawProcess = null;
  });

  print(chalk.yellow('[client] node-pty unavailable, using child_process fallback'));
}

function renderPlan(data) {
  const list = Array.isArray(data) ? data : [];
  if (list.length === 0) {
    print(chalk.gray('[plan] (empty)'));
    return;
  }

  for (const item of list) {
    print(chalk.green(`[x] ${item}`));
  }
}

function handleUiMessage(message) {
  const action = message.action;
  const data = message.data;

  if (action === 'clear') {
    process.stdout.write('\x1Bc');
    return;
  }

  if (action === 'plan') {
    renderPlan(data);
    return;
  }

  if (action === 'status' || action === 'update_status') {
    if (typeof data === 'string') {
      ensureSpinnerStart(data);
      return;
    }

    if (data && typeof data === 'object') {
      const text = String(data.text || data.message || 'working...');
      if (data.error) {
        stopSpinnerFail(text);
      } else if (data.done) {
        stopSpinnerSuccess(text);
      } else {
        ensureSpinnerStart(text);
      }
      return;
    }
  }

  print(chalk.cyan(`[ui] ${action || 'unknown'} ${JSON.stringify(data || {})}`));
}

function gracefulExit(reason) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;

  stopSpinner();
  stopTerminal();

  if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
    ws.close(1000, reason || 'client_exit');
  }

  setTimeout(() => process.exit(0), 120);
}

ws.on('open', () => {
  print(chalk.cyan(`[client] connected to relay ${relayUrl}`));
  sendObject({
    type: 'auth',
    role: 'client',
    client_name: os.hostname(),
    platform: process.platform
  });
});

ws.on('message', (raw) => {
  let message = null;
  try {
    message = JSON.parse(raw.toString('utf8'));
  } catch {
    print(chalk.red('[client] invalid JSON from relay'));
    return;
  }

  if (message.type === 'session' && message.action === 'pin_generated') {
    const pin = String(message.pin || '------');
    print(chalk.bold.cyan('================================'));
    print(chalk.bold.cyan(`         PIN: ${pin}         `));
    print(chalk.bold.cyan('================================'));
    print(chalk.gray('[client] send this PIN to operator'));
    return;
  }

  if (message.type === 'session' && message.action === 'paired') {
    sessionId = message.session_id;
    print(chalk.green(`[client] paired, session=${sessionId}`));
    startTerminal();
    return;
  }

  if (message.type === 'session' && message.action === 'peer_disconnected') {
    stopSpinner();
    stopTerminal();
    sessionId = null;
    print(chalk.yellow('[client] operator disconnected'));
    return;
  }

  if (message.type === 'exec') {
    if (!sessionId || message.session_id !== sessionId) {
      return;
    }

    if (message.stream === 'stdin') {
      writeToShell(message.payload);
    }
    return;
  }

  if (message.type === 'ui') {
    if (!sessionId || message.session_id !== sessionId) {
      return;
    }
    handleUiMessage(message);
    return;
  }

  if (message.type === 'error') {
    print(chalk.red(`[relay:${message.code || 'error'}] ${message.message || ''}`));
    return;
  }

  if (message.type === 'auth') {
    print(chalk.cyan(`[auth] ${message.status}`));
    return;
  }

  print(chalk.gray(`[client] ${JSON.stringify(message)}`));
});

ws.on('close', (code, reasonBuffer) => {
  const reason = reasonBuffer ? reasonBuffer.toString() : '';
  if (!shuttingDown) {
    print(chalk.yellow(`[client] relay closed (${code}) ${reason}`.trim()));
  }
  gracefulExit('relay_closed');
});

ws.on('error', (err) => {
  print(chalk.red(`[client] websocket error: ${err.message}`));
});

process.on('SIGINT', () => {
  print(chalk.yellow('\n[client] SIGINT received, shutting down...'));
  gracefulExit('sigint');
});

process.on('SIGTERM', () => {
  gracefulExit('sigterm');
});
