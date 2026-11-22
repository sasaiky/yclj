const { execFileSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const windows = process.platform === 'win32';
const mac = process.platform === 'darwin';
if (!(windows && process.arch === 'x64') && !(mac && ['arm64', 'x64'].includes(process.arch))) {
  throw new Error('请在 Windows x64、Apple Silicon Mac 或 Intel Mac 上构建对应的控制端。');
}

const root = path.resolve(__dirname, '..');
const out = path.resolve(process.argv[2] || path.join(root, 'release-operator'));
const name = `YCLJ-Operator-${mac ? 'mac' : 'win'}-${process.arch}`;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'yclj-operator-build-'));
const bundle = path.join(work, name);
const app = path.join(bundle, 'app');
const runtime = path.join(bundle, 'runtime');
const viewer = path.join(app, 'viewer');

function run(executable, args, cwd = work) {
  execFileSync(executable, args, { cwd, stdio: 'inherit', windowsHide: true });
}

function download(url, filename) {
  const file = path.join(work, filename);
  run(windows ? 'curl.exe' : 'curl', ['-fLsS', '--retry', '2', '--max-time', '120', url, '-o', file]);
  return file;
}

function verify(file, expected) {
  if (!expected || createHash('sha256').update(fs.readFileSync(file)).digest('hex') !== expected) {
    throw new Error(`SHA-256 校验失败 ${path.basename(file)}`);
  }
}

function includeRuntime() {
  const release = 'v22.23.5';
  const base = `https://nodejs.org/dist/${release}`;
  const prefix = `node-${release}-${mac ? 'darwin' : 'win'}-${process.arch}`;
  const filename = `${prefix}.${mac ? 'tar.gz' : 'zip'}`;
  const checksums = fs.readFileSync(download(`${base}/SHASUMS256.txt`, 'SHASUMS256.txt'), 'utf8');
  const published = checksums.split(/\r?\n/).map(line => line.trim().split(/\s+/)).find(([, file]) => file === filename);
  const archive = download(`${base}/${filename}`, filename);
  verify(archive, published?.[0]);
  const executable = mac ? 'bin/node' : 'node.exe';
  run('tar', ['-xf', archive, `${prefix}/${executable}`, `${prefix}/LICENSE`]);
  fs.copyFileSync(path.join(work, prefix, executable), path.join(runtime, path.basename(executable)));
  fs.copyFileSync(path.join(work, prefix, 'LICENSE'), path.join(runtime, 'LICENSE'));
}

function includeWebView2() {
  const sdk = 'microsoft.web.webview2';
  const version = '1.0.2903.40';
  const filename = `${sdk}.${version}.nupkg`;
  const archive = download(`https://api.nuget.org/v3-flatcontainer/${sdk}/${version}/${filename}`, filename);
  verify(archive, 'ef128016dd1e51c59178c827ed5b8aa3322c57afa8675d930f8109505542ad74');
  const core = 'lib/net462/Microsoft.Web.WebView2.Core.dll';
  const forms = 'lib/net462/Microsoft.Web.WebView2.WinForms.dll';
  const sdkFiles = [core, forms, 'runtimes/win-x64/native/WebView2Loader.dll', 'LICENSE.txt', 'NOTICE.txt'];
  run('tar', ['-xf', archive, ...sdkFiles]);
  sdkFiles.forEach(file => fs.copyFileSync(path.join(work, file), path.join(viewer, path.basename(file))));
  const compiler = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  run(compiler, ['/nologo', '/optimize+', '/platform:x64', '/target:exe', '/r:System.Drawing.dll',
    '/r:System.Windows.Forms.dll', '/r:System.Web.Extensions.dll', `/r:${path.join(work, core)}`,
    `/r:${path.join(work, forms)}`, `/out:${path.join(viewer, 'YCLJViewer.exe')}`,
    path.join(root, 'public-assist', 'rtc-webview2.cs')]);
}

function includeApp() {
  for (const dir of ['operator-cli', 'public-assist', 'tools', 'electron-host-win']) {
    fs.mkdirSync(path.join(app, dir), { recursive: true });
  }
  const files = ['index', 'device-transfer', 'launch', 'powershell-ready', 'public-connection', 'settings', 'terminal-text']
    .map(file => `operator-cli/${file}.js`);
  files.push(...['operator-password', 'operator-sidecar', 'peer', 'protocol', 'rtc', 'rtc-native', 'rtc-preload']
    .map(file => `public-assist/${file}.js`), 'public-assist/rtc.html', 'tools/assist-config.js', 'electron-host-win/script-runner.js');
  files.forEach(file => fs.copyFileSync(path.join(root, file), path.join(app, file)));

  const lock = require('../package-lock.json');
  const packageNames = ['chalk', 'ws', 'ansi-styles', 'color-convert', 'color-name', 'supports-color', 'has-flag'];
  const manifest = { name: 'yclj-operator', version: lock.version, private: true,
    dependencies: { chalk: lock.packages[''].dependencies.chalk, ws: lock.packages[''].dependencies.ws } };
  const packages = { '': manifest };
  for (const name of packageNames) packages[`node_modules/${name}`] = lock.packages[`node_modules/${name}`];
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(app, 'package-lock.json'), JSON.stringify({ ...lock, ...manifest, packages }));
  const args = ['ci', '--ignore-scripts', '--omit=dev', '--no-audit', '--no-fund'];
  if (windows) run('cmd.exe', ['/d', '/c', 'npm.cmd', ...args], app);
  else run('npm', args, app);
}

try {
  fs.mkdirSync(runtime, { recursive: true });
  fs.mkdirSync(viewer, { recursive: true });
  includeApp();
  includeRuntime();
  if (windows) {
    includeWebView2();
    fs.writeFileSync(path.join(bundle, 'YCLJ.cmd'), [
      '@echo off',
      'setlocal',
      'chcp 65001 >nul',
      '"%~dp0runtime\\node.exe" "%~dp0app\\operator-cli\\launch.js" %*',
      'set "yclj_status=%errorlevel%"',
      'if "%~1"=="" if not "%yclj_status%"=="0" pause',
      'exit /b %yclj_status%',
      ''
    ].join('\r\n'));
  } else {
    const buildWebKit = require('../public-assist/rtc-webkit').buildWebKit;
    const nativeBundle = path.resolve(buildWebKit(), '../../..');
    fs.cpSync(nativeBundle, path.join(viewer, path.basename(nativeBundle)), { recursive: true });
    fs.writeFileSync(path.join(bundle, 'YCLJ.command'), `#!/bin/sh\nfolder="$(dirname "$0")"\nexec "$folder/runtime/node" "$folder/app/operator-cli/launch.js" "$@"\n`, { mode: 0o755 });
  }
  const launcher = windows ? '.\\YCLJ.cmd' : './YCLJ.command';
  fs.writeFileSync(path.join(bundle, '使用说明.txt'), [
    '解压整个文件夹，双击启动文件，输入对方的六位验证码。',
    '已有本机 YCLJ 控制身份和配置会自动沿用。换电脑先在终端进入解压目录，再执行：',
    `${launcher} config import-device "迁移文件的完整路径"`,
    `也可以直接运行 ${launcher} 123456，更多参数用 ${launcher} --help。`,
    windows ? 'Windows 需要 Microsoft Edge WebView2 Runtime。下载：https://developer.microsoft.com/microsoft-edge/webview2/' : 'Mac 的观看窗口使用系统 WebKit。'
  ].join('\n') + '\n');

  fs.mkdirSync(out, { recursive: true });
  const archive = path.join(out, `${name}.zip`);
  if (windows) {
    const script = 'Compress-Archive -LiteralPath $env:YCLJ_OPERATOR_BUNDLE -DestinationPath $env:YCLJ_OPERATOR_ARCHIVE -Force';
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      env: { ...process.env, YCLJ_OPERATOR_BUNDLE: bundle, YCLJ_OPERATOR_ARCHIVE: archive }, stdio: 'inherit'
    });
  } else {
    run('/usr/bin/ditto', ['-c', '-k', '--keepParent', bundle, archive]);
  }
  console.log(archive);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
