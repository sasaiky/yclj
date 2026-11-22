const { randomBytes } = require('node:crypto');
const { terminalText } = require('./terminal-text');

const READY_TIMEOUT = 30_000;
const publisherPrompt = /\[V\][^\[]*\[D\][^\[]*\[R\][^\[]*\[A\][^\[]*\[\?\][^\n]*:\s*$/;
const powerShellPrompt = /(?:^|\n)PS [^\n>]+> *$/;

function waitForPowerShell(send, timeout = READY_TIMEOUT) {
  let tail = '';
  let marker;
  let settle;
  const ready = new Promise(resolve => { settle = resolve; });
  const timer = setTimeout(() => stop('powershell_ready_timeout'), timeout);

  function stop(reason) {
    if (!settle) return;
    clearTimeout(timer);
    const finish = settle;
    settle = null;
    finish(reason);
  }

  function handle(message) {
    if (!settle || message.type !== 'exec' || message.stream !== 'stdout' || typeof message.payload !== 'string') return;
    tail = (tail + message.payload).slice(-4096);
    const text = terminalText(tail);
    // ConPTY can position the output with a cursor escape instead of a newline.
    // The echoed probe keeps the prefix and random token in separate strings.
    if (marker && text.includes(marker)) {
      stop();
      return;
    }

    try {
      if (publisherPrompt.test(text)) {
        tail = '';
        marker = undefined;
        // Skip this invocation of the profile script without changing publisher trust.
        send('D\r');
      } else if (!marker && powerShellPrompt.test(text)) {
        const token = randomBytes(12).toString('hex');
        marker = 'YCLJ-READY-' + token;
        send(`[Console]::WriteLine('YCLJ-READY-' + '${token}')\r`);
      }
    } catch {
      stop('disconnected');
    }
  }

  return { ready, handle, stop };
}

module.exports = { waitForPowerShell };
