const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function buildWebKit() {
  const source = path.join(__dirname, 'rtc-webkit.swift');
  const key = createHash('sha256').update(fs.readFileSync(source)).update(fs.readFileSync(__filename))
    .update(process.arch).digest('hex').slice(0, 16);
  const cache = path.join(os.homedir(), 'Library', 'Caches', 'com.yclj.operator');
  fs.mkdirSync(cache, { recursive: true, mode: 0o700 });
  const app = path.join(cache, key, 'YCLJ Viewer.app');
  const binary = path.join(app, 'Contents', 'MacOS', 'YCLJViewer');
  if (fs.existsSync(binary)) return binary;

  const build = fs.mkdtempSync(path.join(cache, 'build-'));
  try {
    const env = { ...process.env };
    const clt = '/Library/Developer/CommandLineTools';
    if (!env.DEVELOPER_DIR && fs.existsSync(path.join(clt, 'usr/bin/swiftc'))) env.DEVELOPER_DIR = clt;
    const bundle = path.join(build, 'YCLJ Viewer.app');
    const output = path.join(bundle, 'Contents', 'MacOS', 'YCLJViewer');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'Contents', 'Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.yclj.operator.viewer</string>
<key>CFBundleName</key><string>YCLJ Viewer</string>
<key>CFBundleDisplayName</key><string>YCLJ 屏幕共享</string>
<key>CFBundleExecutable</key><string>YCLJViewer</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>`);
    const result = spawnSync('/usr/bin/xcrun', ['swiftc', '-O', source, '-o', output], { env, encoding: 'utf8' });
    if (result.error || result.status !== 0) {
      throw result.error || new Error(result.stderr?.trim() || '无法编译 WebKit 观看端');
    }
    fs.mkdirSync(path.dirname(app), { recursive: true });
    try { fs.renameSync(bundle, app); } catch (error) {
      if (!fs.existsSync(binary)) throw error;
    }
    return binary;
  } finally {
    fs.rmSync(build, { recursive: true, force: true });
  }
}

module.exports = { buildWebKit };
