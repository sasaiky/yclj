const { spawn } = require('node:child_process');
const path = require('node:path');
const readline = require('node:readline');

function createRtcFactory(binary, profile) {
  const args = ['rtc.html', 'rtc-preload.js'].map(file => path.join(__dirname, file));
  if (process.platform === 'win32') args.push(profile);
  return (options, onEvent) => {
    const child = spawn(binary, args, {
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true
    });
    const output = readline.createInterface({ input: child.stdout, crlfDelay: Infinity });
    let closed = false;
    const fail = () => { if (!closed) onEvent({ event: 'fatal' }); };
    child.once('error', fail);
    child.once('close', fail);
    child.stdin.on('error', fail);
    output.on('line', line => {
      if (closed) return;
      let message;
      try { message = JSON.parse(line); } catch { return fail(); }
      onEvent(message);
    });
    const send = message => {
      if (!closed && child.stdin.writable) child.stdin.write(`${JSON.stringify(message)}\n`);
    };
    send({ op: 'init', options });
    return {
      send,
      close: () => {
        if (closed) return;
        closed = true;
        output.close();
        child.stdin.destroy();
        child.kill();
      }
    };
  };
}

module.exports = { createRtcFactory };
