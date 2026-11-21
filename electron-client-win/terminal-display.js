const { createHash } = require('node:crypto');
const { stripVTControlCharacters } = require('node:util');

const SCRIPT_CHUNK = /^\$global:ycljScript_([a-f0-9]{24}) (\+?=) '([A-Za-z0-9+/=]{1,768})'$/;
const RESULT_BOUNDARY = /^(YCLJ-[a-f0-9]{24}):(BEGIN|END)$/;
const BASE64 = /^[A-Za-z0-9+/=]+$/;
const MAX_ENCODED_SCRIPT = 10924;
const MAX_ENCODED_RESULT = 32768 * 18;
// Match only the existing host's runner. Unknown terminal commands remain visible.
const RUNNER_HASH = '83035a8812e0ce27ffaf512f30a23e5304825562f070ef2a1fceab658bb933da';

function createTerminalDisplay(record) {
  let upload = null;
  let result = null;
  let replay = null;
  const completedResults = new Map();

  function resetInput() {
    if (upload) {
      for (const packet of upload.packets) record('terminal-command', packet);
      record('terminal-output', upload.echo);
    }
    upload = null;
    result = null;
    replay = null;
  }

  function command(payload) {
    if (typeof payload !== 'string') return;
    const text = payload.trimEnd();
    const match = text.match(SCRIPT_CHUNK);
    if (match) {
      const [, id, assignment, chunk] = match;
      if (assignment === '=') {
        resetInput();
        upload = { id, encoded: '', packets: [], echo: '' };
      }
      if (upload?.id === id && upload.encoded.length + chunk.length <= MAX_ENCODED_SCRIPT) {
        upload.encoded += chunk;
        upload.packets.push(payload);
        return;
      }
    }

    if (upload && text.startsWith('& {')) {
      const canonical = text.replaceAll(upload.id, '<id>');
      if (createHash('sha256').update(canonical).digest('hex') === RUNNER_HASH) {
        const id = upload.id;
        const script = Buffer.from(upload.encoded, 'base64');
        if (script.toString('base64') === upload.encoded) {
          upload = null;
          result = { marker: `YCLJ-${id}`, tail: '', encoded: null, done: false };
          record('terminal-command', script.toString('utf8'));
          return;
        }
      }
    }

    resetInput();
    record('terminal-command', payload);
  }

  function recordOutput(payload) {
    if (!completedResults.size) {
      record('terminal-output', payload);
      return;
    }

    // ConPTY can redraw an earlier runner response after the next command starts.
    const lines = stripVTControlCharacters(payload).split('\n').filter(raw => {
      const line = raw.trim();
      const boundary = line.match(RESULT_BOUNDARY);
      if (boundary && completedResults.has(boundary[1])) {
        replay = boundary[2] === 'BEGIN' ? completedResults.get(boundary[1]) : null;
        return false;
      }
      if (replay !== null && (!line || (BASE64.test(line) && replay.includes(line)))) return false;
      replay = null;
      return true;
    });
    record('terminal-output', lines.join('\n'));
  }

  function output(stream, payload) {
    if (stream === 'stderr') {
      record('terminal-error', payload);
      return;
    }
    if (upload) {
      upload.echo = (upload.echo + payload).slice(-32768);
      return;
    }
    if (!result) {
      recordOutput(payload);
      return;
    }
    if (result.done) return;

    const lines = (result.tail + payload).split('\n');
    result.tail = lines.pop().slice(-256);
    for (const raw of lines) {
      const line = stripVTControlCharacters(raw).trim();
      if (line === `${result.marker}:BEGIN`) {
        result.encoded = '';
      } else if (result.encoded !== null && line === `${result.marker}:END`) {
        try {
          const response = JSON.parse(Buffer.from(result.encoded, 'base64').toString('utf8'));
          record('terminal-output', response.stdout);
          record('terminal-error', response.stderr);
          completedResults.set(result.marker, result.encoded);
          if (completedResults.size > 2) completedResults.delete(completedResults.keys().next().value);
          result.done = true;
          result.encoded = null;
          return;
        } catch {
          result.encoded = null;
        }
      } else if (result.encoded !== null && line) {
        if (BASE64.test(line) && result.encoded.length + line.length <= MAX_ENCODED_RESULT) {
          result.encoded += line;
        } else {
          result.encoded = null;
        }
      }
    }
  }

  return {
    command,
    output,
    reset() {
      resetInput();
      completedResults.clear();
    }
  };
}

module.exports = { createTerminalDisplay };
