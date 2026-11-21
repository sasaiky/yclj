const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const directory = fs.mkdtempSync(path.resolve(os.tmpdir(), 'yclj-assist-test-'));
try {
  const env = { ...process.env, YCLJ_ASSIST_TEST_TEMP: directory };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [path.join(__dirname, 'public-assist.js')], { env, stdio: 'inherit' });
  if (result.error) throw result.error;
  process.exitCode = result.status ?? 1;
} finally {
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 3 });
}
