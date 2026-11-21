#!/usr/bin/env node

const fs = require('fs');
const os = require('os');
const path = require('path');

const dataDir = process.env.YCLJ_HOST_DATA_DIR || path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'yclj-host-win');
const manifestPath = process.env.YCLJ_HOST_CONTROL_FILE || path.join(dataDir, 'agent-control.json');
const tokenPath = process.env.YCLJ_OPERATOR_TOKEN_FILE || path.join(dataDir, 'operator-token');

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!['status', 'start', 'stop', 'pair', 'send', 'run', 'events', 'disconnect', 'shutdown'].includes(command)) {
    console.log('Usage: node operator-cli/host-control.js status|start|stop|pair <PIN>|send [--peer <peerId>] <command>|run [--peer <peerId>] <script.ps1>|events [cursor]|disconnect [peerId]|shutdown');
    process.exitCode = 1;
    return;
  }
  const { port } = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const supplied = process.env.ADMIN_TOKEN || process.env.YCLJ_ADMIN_TOKEN;
  const token = supplied && supplied.length >= 32 ? supplied : fs.readFileSync(tokenPath, 'utf8').trim();
  const endpoint = command === 'events' ? `/events?after=${Number(args[0] || 0)}` : command === 'status' ? '/status' : `/${command}`;
  let body = command === 'pair' ? { pin: args[0] } : command === 'send'
    ? { type: 'exec', stream: 'stdin', payload: `${(args[0] === '--peer' ? args.slice(2) : args).join(' ')}\r`, ...(args[0] === '--peer' ? { peerId: args[1] } : {}) }
    : command === 'disconnect' && args[0] ? { peerId: args[0] } : {};
  if (command === 'run') {
    const [first, peerId, scriptPath] = args;
    const targeted = first === '--peer';
    const file = targeted ? scriptPath : first;
    if (!file || (targeted && !peerId) || args.length !== (targeted ? 3 : 1)) {
      throw new Error('Usage: node operator-cli/host-control.js run [--peer <peerId>] <script.ps1>');
    }
    body = { script: fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''), ...(targeted ? { peerId } : {}) };
  }
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    method: ['status', 'events'].includes(command) ? 'GET' : 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    ...(['status', 'events'].includes(command) ? {} : { body: JSON.stringify(body) })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `HTTP ${response.status}`);
  console.log(JSON.stringify(result, null, 2));
  if (command === 'run' && (result.status !== 'finished' || result.exitCode !== 0)) process.exitCode = 1;
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
