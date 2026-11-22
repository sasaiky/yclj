const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const readline = require('node:readline');

const keys = {
  Escape: 'ESCAPE', Backspace: 'BACK', Tab: 'TAB', Enter: 'RETURN', Space: 'SPACE',
  ArrowUp: 'UP', ArrowDown: 'DOWN', ArrowLeft: 'LEFT', ArrowRight: 'RIGHT',
  Home: 'HOME', End: 'END', PageUp: 'PRIOR', PageDown: 'NEXT', Insert: 'INSERT', Delete: 'DELETE',
  ControlLeft: 'CONTROL', ControlRight: 'RCONTROL', MetaLeft: 'CONTROL', MetaRight: 'RCONTROL',
  AltLeft: 'MENU', AltRight: 'RMENU', ShiftLeft: 'SHIFT', ShiftRight: 'RSHIFT',
  CapsLock: 'CAPITAL', NumLock: 'NUMLOCK', PrintScreen: 'SNAPSHOT',
  Minus: 'OEM_MINUS', Equal: 'OEM_PLUS', BracketLeft: 'OEM_4', BracketRight: 'OEM_6', Backslash: 'OEM_5',
  Semicolon: 'OEM_1', Quote: 'OEM_7', Backquote: 'OEM_3', Comma: 'OEM_COMMA', Period: 'OEM_PERIOD', Slash: 'OEM_2',
  NumpadEnter: 'RETURN', NumpadAdd: 'ADD', NumpadSubtract: 'SUBTRACT', NumpadMultiply: 'MULTIPLY',
  NumpadDivide: 'DIVIDE', NumpadDecimal: 'DECIMAL'
};

function inputKey(code) {
  if (Object.hasOwn(keys, code)) return keys[code];
  if (/^(Key[A-Z]|Digit\d)$/.test(code)) return `VK_${code.at(-1)}`;
  if (/^F(?:[1-9]|1[0-2])$/.test(code)) return code;
  if (/^Numpad\d$/.test(code)) return `NUMPAD${code.at(-1)}`;
}

function createRemoteInput(onError = () => {}) {
  if (process.platform !== 'win32') return null;
  const directory = path.join(__dirname, 'input');
  const assembly = path.join(directory, 'WindowsInput.dll').replace(/([\\/])app\.asar([\\/])/, '$1app.asar.unpacked$2');
  const shell = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const script = path.join(directory, 'worker.ps1');
  if (![assembly, shell, script].every(file => fs.existsSync(file))) return null;
  const encodedScript = Buffer.from(fs.readFileSync(script, 'utf8'), 'utf16le').toString('base64');
  let worker = null;

  function release() {
    if (!worker) return;
    const { child, queue } = worker;
    worker = null;
    queue.length = 0;
    child.stdin.end();
  }

  function start() {
    const child = spawn(shell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', encodedScript], {
      env: { ...process.env, YCLJ_INPUT_ASSEMBLY: assembly },
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true
    });
    const current = { child, queue: [], waiting: true };
    worker = current;
    function failed() {
      if (worker !== current) return;
      release();
      onError();
    }
    child.on('error', failed);
    child.on('close', failed);
    child.stdin.on('error', failed);
    readline.createInterface({ input: child.stdout }).on('line', line => {
      if (worker !== current) return;
      if (line !== 'ok') return failed();
      current.waiting = false;
      flush();
    });
    return current;
  }

  function flush() {
    if (!worker || worker.waiting || !worker.queue.length) return;
    worker.waiting = true;
    worker.child.stdin.write(`${JSON.stringify(worker.queue.shift())}\n`);
  }

  return {
    release,
    apply: event => {
      if (event.action === 'release') return release();
      if (event.action === 'key') {
        const key = inputKey(event.code);
        if (!key) return;
        event = { ...event, key };
      }
      const { queue } = worker || start();
      if (event.action === 'move' && queue.at(-1)?.action === 'move') queue[queue.length - 1] = event;
      else if (queue.length < 64) queue.push(event);
      else if (event.action !== 'move') {
        release();
        onError();
      }
      flush();
    }
  };
}

module.exports = { createRemoteInput };
