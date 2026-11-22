const assert = require('node:assert/strict');
const test = require('node:test');
const { waitForPowerShell } = require('../operator-cli/powershell-ready');

function stdout(handle, payload) {
  handle({ type: 'exec', stream: 'stdout', payload });
}

test('declines the publisher prompt and confirms PowerShell with a fresh marker', async () => {
  const sent = [];
  const { ready, handle, stop } = waitForPowerShell(payload => sent.push(payload));
  try {
    stdout(handle, 'Windows PowerShell\r\n');
    stdout(handle, '[V] Never run [D] Do not run [R]');
    assert.deepEqual(sent, []);
    stdout(handle, ' Run once [A] Always run [?] Help (default is "D"): ');
    assert.deepEqual(sent, ['D\r']);

    stdout(handle, '\r\n\x1b[32mPS C:\\Users\\');
    assert.deepEqual(sent, ['D\r']);
    stdout(handle, 'test> \x1b[0m');
    assert.equal(sent.length, 2);
    const token = sent[1].match(/'([0-9a-f]{24})'\)\r$/)[1];

    let finished = false;
    ready.then(() => { finished = true; });
    stdout(handle, sent[1] + '\n');
    await Promise.resolve();
    assert.equal(finished, false);

    stdout(handle, '\x1b[6;106H\x1b[?25h\x1b[7;1HYCLJ-READY-');
    stdout(handle, token + '\r\n');
    assert.equal(await ready, undefined);
  } finally {
    stop('test_done');
  }
});

test('returns a startup timeout without sending anything to a shell that never becomes ready', async () => {
  const sent = [];
  const { ready, handle } = waitForPowerShell(payload => sent.push(payload), 20);
  stdout(handle, 'Windows PowerShell\r\n');
  assert.equal(await ready, 'powershell_ready_timeout');
  assert.deepEqual(sent, []);
});

test('stops waiting immediately when the session closes', async () => {
  const sent = [];
  const { ready, handle, stop } = waitForPowerShell(payload => sent.push(payload));
  stop('disconnected');
  stdout(handle, 'PS C:\\Users\\test> ');
  assert.equal(await ready, 'disconnected');
  assert.deepEqual(sent, []);
});
