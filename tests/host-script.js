const assert = require('node:assert/strict');
const { execFile, spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { setTimeout: delay } = require('node:timers/promises');
const { promisify, stripVTControlCharacters } = require('node:util');
if (!process.versions.electron) {
  const parent = fs.realpathSync(os.tmpdir());
  const scratch = fs.mkdtempSync(path.join(parent, 'yclj-script-test-'));
  assert.equal(path.dirname(fs.realpathSync(scratch)), parent);
  try {
    const child = spawnSync(require('electron'), [__filename], {
      env: { ...process.env, YCLJ_SCRIPT_TEST_DIR: scratch },
      stdio: 'inherit',
      timeout: 60000
    });
    if (child.error) throw child.error;
    process.exitCode = child.status ?? 1;
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true, maxRetries: 5 });
  }
  return;
}

const { app, BrowserWindow, nativeImage } = require('electron');

const exec = promisify(execFile);
const root = path.join(__dirname, '..');
const clientArchive = process.env.YCLJ_CLIENT_ARCHIVE
  || path.join(root, 'release-win-client', 'win-unpacked', 'resources', 'app.asar');
const scratch = process.env.YCLJ_SCRIPT_TEST_DIR;
if (!scratch) {
  console.error('Run this test with node tests/host-script.js.');
  app.exit(1);
  return;
}
const clientProfile = path.join(scratch, 'client');
const hostProfile = path.join(scratch, 'host');
const desktop = path.join(scratch, 'desktop');
const token = 'host-script-integration-test-token';
fs.mkdirSync(desktop);
app.setPath('userData', clientProfile);
app.setPath('desktop', desktop);

async function waitFor(test, label) {
  const end = Date.now() + 10000;
  while (Date.now() < end) {
    const result = await test();
    if (result) return result;
    await delay(60);
  }
  throw new Error(`timeout: ${label}`);
}

async function main() {
  const server = net.createServer();
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  await new Promise(resolve => server.close(resolve));
  const relayUrl = `ws://127.0.0.1:${port}`;
  const manifest = path.join(hostProfile, 'control.json');
  const cliEnv = { ...process.env, ADMIN_TOKEN: token, YCLJ_HOST_CONTROL_FILE: manifest };
  const host = spawn(process.execPath, [
    path.join(root, 'electron-host-win', 'main.js'), '--background', `--user-data-dir=${hostProfile}`
  ], {
    cwd: root,
    env: { ...cliEnv, YCLJ_HOST_PORT: String(port) },
    stdio: 'inherit',
    windowsHide: true
  });
  const exited = new Promise(resolve => host.once('exit', resolve));
  const cli = async (...args) => JSON.parse((await exec('node', [
    path.join(root, 'operator-cli', 'host-control.js'), ...args
  ], { env: cliEnv, timeout: 15000 })).stdout);
  const outputSince = async cursor => stripVTControlCharacters((await cli('events', String(cursor))).events
    .filter(event => event.type === 'exec' && event.stream === 'stdout')
    .map(event => event.payload).join(''));
  try {
    await waitFor(async () => fs.existsSync(manifest) && (await cli('status')).status === 'running', 'host service');
    const { version } = require(path.join(clientArchive, 'package.json'));
    const terminalView = version !== '0.1.10';
    const retroTerminal = !['0.1.10', '0.1.11'].includes(version);
    const startShowsStatus = retroTerminal && version !== '0.1.12';
    const compactTerminal = startShowsStatus && version !== '0.1.13';
    const sizedTerminal = compactTerminal && version !== '0.1.14';
    const brighterPin = sizedTerminal && !['0.1.15', '0.1.16', '0.1.17'].includes(version);
    const fillingButton = Number(version.split('.')[2]) >= 21;
    // Keep the client environment equivalent to launching it from Explorer.
    delete process.env.PSModulePath;
    process.env.RELAY_URL = relayUrl;
    require(path.join(clientArchive, 'electron-client-win', 'main.js'));
    const win = await waitFor(() => BrowserWindow.getAllWindows()[0], 'client window');
    win.webContents.setBackgroundThrottling(false);
    const evaluate = code => win.webContents.executeJavaScript(code);
    await waitFor(() => evaluate('Boolean(window.ycljClient)').catch(() => false), 'legacy preload');
    if (compactTerminal) {
      assert.deepEqual(await evaluate(`[
        document.querySelector('#mode-brief').checked,
        document.querySelector('#mode-detailed').checked,
        document.querySelector('#log-box').dataset.mode
      ]`), [true, false, 'brief']);
    }
    if (sizedTerminal) {
      const size = await evaluate(`{
        const terminal = document.querySelector('#log-box').getBoundingClientRect();
        ({ width: terminal.width, height: terminal.height, viewport: innerHeight });
      }`);
      const aspect = version === '0.1.15' ? 1 : 4 / 3;
      assert.ok(Math.abs(size.width / aspect - size.height) <= 2, `unexpected terminal size: ${JSON.stringify(size)}`);
      assert.ok(size.viewport < (aspect === 1 ? 800 : 700), `default window is too tall: ${size.viewport}`);
      console.log(`[client] default terminal ${Math.round(size.width)} × ${Math.round(size.height)}`);
    }
    if (startShowsStatus) {
      await waitFor(() => evaluate(`document.querySelector('#relay-url').value === ${JSON.stringify(relayUrl)}`), 'relay URL');
      assert.deepEqual(await evaluate(`[...document.querySelectorAll('.buttons button')]
        .filter(button => !button.hidden && !button.closest('[hidden]'))
        .map(button => button.textContent.trim())`), ['开始', '断开']);
      if (fillingButton) {
        assert.deepEqual(await evaluate(`['#btn-connect', '#btn-disconnect'].map(selector =>
          getComputedStyle(document.querySelector(selector)).backgroundColor)`), ['rgb(255, 255, 255)', 'rgb(255, 255, 255)']);
      }
      await evaluate("document.querySelector('#btn-connect').click()");
    } else {
      await evaluate(`window.ycljClient.start({ relayUrl: ${JSON.stringify(relayUrl)} })`);
    }
    const pin = await waitFor(async () => (await evaluate('window.ycljClient.getState()')).pin, 'legacy PIN');
    if (startShowsStatus) {
      await waitFor(() => evaluate(`{
        const start = document.querySelector('#btn-connect');
        const disconnect = document.querySelector('#btn-disconnect');
        const motion = matchMedia('(prefers-reduced-motion: reduce)').matches;
        start.disabled && start.textContent.trim() === '未连接' && !disconnect.disabled &&
          disconnect.textContent.trim() === '断开' &&
          getComputedStyle(start).animationName === (motion ? 'none' : 'connection-waiting') &&
          getComputedStyle(disconnect).animationName === 'none';
      }`), 'left start button shows waiting status');
      if (fillingButton) {
        const breathColors = await evaluate(`(() => {
          const start = document.querySelector('#btn-connect');
          const breath = start.getAnimations().find(animation => animation.animationName === 'connection-waiting');
          if (!breath) return null;
          const previousTime = breath.currentTime;
          breath.pause();
          breath.currentTime = 0;
          const from = getComputedStyle(start).backgroundColor;
          breath.currentTime = breath.effect.getTiming().duration;
          const to = getComputedStyle(start).backgroundColor;
          breath.currentTime = previousTime;
          breath.play();
          return [from, to];
        })()`);
        if (breathColors) {
          const expectedColors = version === '0.1.23'
            ? ['rgb(255, 244, 236)', 'rgb(255, 177, 126)']
            : ['rgb(238, 246, 241)', 'rgb(128, 174, 160)'];
          assert.deepEqual(breathColors, expectedColors);
        }
      }
    }
    await cli('pair', pin);
    if (startShowsStatus) {
      const flowLayer = sizedTerminal ? '::before' : null;
      await waitFor(() => evaluate(`{
        const start = document.querySelector('#btn-connect');
        const disconnect = document.querySelector('#btn-disconnect');
        const motion = matchMedia('(prefers-reduced-motion: reduce)').matches;
        const filling = ${fillingButton};
        const fill = filling ? start.querySelector('.connection-fill') : start;
        const sparks = getComputedStyle(fill, ${JSON.stringify(flowLayer)});
        start.disabled && start.textContent.trim() === '已连接' && !disconnect.disabled &&
          disconnect.textContent.trim() === '断开' &&
          sparks.animationName === (motion ? 'none' : 'connection-flow') &&
          (!filling || motion || (getComputedStyle(fill).animationName === 'connection-fill' &&
            parseFloat(sparks.animationDelay) < parseFloat(getComputedStyle(fill).animationDuration))) &&
          getComputedStyle(disconnect).animationName === 'none';
      }`), 'left start button shows paired status and right button stays disconnect');
      if (fillingButton && version !== '0.1.21') {
        const directions = await evaluate(`(() => {
          if (matchMedia('(prefers-reduced-motion: reduce)').matches) return null;
          const effects = document.getAnimations();
          const fill = effects.find(animation => animation.animationName === 'connection-fill');
          const stars = effects.find(animation => animation.animationName === 'connection-flow');
          const startInset = fill.effect.getKeyframes()[0].clipPath;
          const sides = startInset.slice('inset('.length, -1).split(' ').map(Number.parseFloat);
          const offsets = stars.effect.getKeyframes().filter(frame => frame.transform)
            .map(frame => Number.parseFloat(frame.transform.slice('translateX('.length)));
          return { sides, starsMoveLeft: offsets[0] > 0 && offsets.at(-1) < 0 };
        })()`);
        if (directions) assert.deepEqual(directions, { sides: [0, 100, 0, 0], starsMoveLeft: true });
      }
    }

    let cursor = (await cli('events')).cursor;
    await cli('send', "$legacyValue = 'old-value'; Write-Output ('legacy-' + 'ready')");
    await waitFor(async () => (await outputSince(cursor)).includes('\nlegacy-ready'), 'legacy interactive output');
    if (compactTerminal) {
      await waitFor(() => evaluate("Boolean(document.querySelector('#log-box .terminal-command'))"), 'default brief shows command');
      if (brighterPin && !['0.1.18', '0.1.19'].includes(version)) {
        assert.equal(await evaluate("document.querySelector('#log-box .terminal-command .text').textContent.startsWith('> $legacyValue')"), true);
      }
      assert.deepEqual(await evaluate(`[...document.querySelectorAll('.log-mode input')]
        .map(input => [input.id, input.checked])`), [['mode-brief', true], ['mode-detailed', false]]);
      assert.equal(await evaluate(`{
        const box = document.querySelector('#log-box');
        const time = box.querySelector('.time');
        !document.querySelector('.progress, .connection-details') &&
          !box.querySelector('.terminal-output') && getComputedStyle(time).display === 'none';
      }`), true);
      await evaluate("document.querySelector('#mode-detailed').click()");
    }
    await waitFor(() => evaluate(`[...document.querySelectorAll('#log-box .terminal-command .text')]
      .some(line => line.textContent.includes('$legacyValue')) &&
      [...document.querySelectorAll('#log-box .terminal-output .text')]
      .some(line => line.textContent.includes('legacy-ready'))`), 'detailed mode shows command and output');
    await evaluate("document.querySelector('#mode-brief').click()");
    assert.equal(await evaluate("Boolean(document.querySelector('#log-box .terminal-command'))"), terminalView);

    const scriptPath = path.join(scratch, 'probe.ps1');
    const lines = [
      'if (Get-Variable legacyValue -ErrorAction SilentlyContinue) { exit 9 }',
      "Write-Output '诊断结果'",
      "[Console]::Error.WriteLine('测试错误')",
      'exit 7'
    ];
    fs.writeFileSync(scriptPath, lines.join('\r\n'), 'utf8');
    const running = cli('run', scriptPath).catch(error => {
      if (error.code !== 1 || !error.stdout) throw error;
      return JSON.parse(error.stdout);
    });
    const result = await running;
    assert.equal(result.status, 'finished');
    assert.equal(result.exitCode, 7);
    assert.equal(result.stdout.trim(), '诊断结果');
    assert.equal(result.stderr.trim(), '测试错误');
    assert.equal(result.truncated, false);
    if (!compactTerminal) {
      assert.equal(await evaluate("document.querySelector('#plan-list').childElementCount"), 0);
      assert.equal(await evaluate("document.querySelector('#ui-status').textContent.includes('诊断结果')"), false);
    }
    assert.equal(await evaluate("document.querySelector('#log-box .terminal-output') === null"), true);
    if (terminalView) {
      await waitFor(() => evaluate(`[...document.querySelectorAll('#log-box .terminal-command .text')]
        .some(line => line.textContent.includes("Write-Output '诊断结果'"))`), 'brief shows the original script');
      await waitFor(() => evaluate(`Boolean(document.querySelector('.terminal-command:last-child .log-cursor'))`),
        'latest command cursor');
      assert.equal(await evaluate("document.querySelectorAll('#log-box .log-line:not(.terminal-command)').length"), 0);
      assert.equal(await evaluate(`[...document.querySelectorAll('.log-cursor')]
        .filter(cursor => getComputedStyle(cursor).display !== 'none')
        .length`), 1);
      assert.equal(await evaluate(`{
        const cursor = document.querySelector('.terminal-command:last-child .log-cursor');
        const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
        getComputedStyle(cursor).animationName === (reducedMotion ? 'none' : 'cursor-blink');
      }`), true);
    }
    await evaluate("document.querySelector('#mode-detailed').click()");
    const scriptKind = terminalView ? 'terminal-command' : 'terminal-output';
    await waitFor(() => evaluate(`[...document.querySelectorAll('#log-box .${scriptKind} .text')]
      .some(line => line.textContent.includes("Write-Output '诊断结果'"))`), 'detailed mode shows the original script');
    if (terminalView) {
      await waitFor(() => evaluate(`[...document.querySelectorAll('#log-box .terminal-error .text')]
        .some(line => line.textContent.includes('测试错误') && getComputedStyle(line).color === 'rgb(242, 243, 241)')`),
      'detailed mode shows white PowerShell output');
      assert.equal(await evaluate(`document.querySelector('.terminal-command .log-tag').textContent`), '[cmd]');
      assert.equal(await evaluate(`getComputedStyle(document.querySelector('.terminal-command .text')).color`), 'rgb(145, 247, 149)');
      assert.equal(await evaluate(`/ycljScript_|YCLJ-/.test(document.querySelector('#log-box').innerText)`), false);
      assert.deepEqual(await evaluate(`[
        getComputedStyle(document.documentElement).backgroundColor,
        getComputedStyle(document.querySelector('#pin-value')).color,
        getComputedStyle(document.querySelector('#log-box')).backgroundColor
      ]`), ['rgb(255, 255, 255)', brighterPin ? 'rgb(235, 104, 23)' : 'rgb(202, 96, 29)', 'rgb(11, 14, 11)']);
      if (compactTerminal) {
        assert.deepEqual(await evaluate(`{
          const box = document.querySelector('#log-box');
          const style = getComputedStyle(box);
          [style.fontSize, getComputedStyle(box.querySelector('.time')).fontSize,
            style.backgroundImage.split('gradient(').length - 1];
        }`), ['18px', '13px', 1]);
      }
    }

    if (retroTerminal) {
      assert.equal(await evaluate(`document.fonts.load('20px VT323').then(faces =>
        faces.length === 1 && faces[0].status === 'loaded')`), true);
      const feed = await evaluate(`{
        const box = document.querySelector('#log-box');
        box.scrollTop = box.scrollHeight;
        const entry = { ts: new Date().toISOString(), detail: true, kind: 'terminal-output',
          text: Array.from({ length: 40 }, (_, index) => 'scroll-row-' + index).join('\\n') };
        receiveLog(entry);
        ({ reduced: matchMedia('(prefers-reduced-motion: reduce)').matches,
          immediate: [...box.querySelectorAll('.text')].filter(line => line.textContent.startsWith('scroll-row-')).length });
      }`);
      if (!feed.reduced) assert.ok(feed.immediate < 40, 'a multiline entry is revealed over time');
      await waitFor(() => evaluate(`{
        const box = document.querySelector('#log-box');
        box.textContent.includes('scroll-row-39') && box.scrollTop > 0 &&
          box.scrollHeight - box.clientHeight - box.scrollTop < 4;
      }`), 'terminal followed the last row');
      await evaluate(`{
        document.querySelector('#log-box').scrollTop = 0;
        receiveLog({ ts: new Date().toISOString(), detail: true, kind: 'terminal-output', text: 'reading-marker' });
      }`);
      await waitFor(() => evaluate("document.querySelector('#log-box').textContent.includes('reading-marker')"), 'output while reading');
      assert.equal(await evaluate("document.querySelector('#log-box').scrollTop"), 0);
    }

    if (terminalView && process.env.YCLJ_CLIENT_PREVIEW_IMAGE) {
      await evaluate('window.ycljClient.clearLogs()');
      fs.writeFileSync(scriptPath, "Get-Date -Format 'HH:mm:ss'\r\n$PSVersionTable.PSVersion.ToString()", 'utf8');
      const previewResult = await cli('run', scriptPath);
      const versionLine = previewResult.stdout.trim().split('\n').at(-1).trim();
      await waitFor(() => evaluate(`[...document.querySelectorAll('.terminal-output .text')]
        .some(line => line.textContent.includes(${JSON.stringify(versionLine)}))`), 'preview output');
      assert.equal(await evaluate(`/ycljScript_|YCLJ-/.test(document.querySelector('#log-box').innerText)`), false);
      win.show();
      await delay(160);
      await evaluate(`{
        for (const animation of document.getAnimations()) {
          if (animation.animationName === 'cursor-blink' || animation.animationName === 'connection-flow') {
            animation.pause();
            animation.currentTime = animation.animationName === 'connection-flow' ? 1550 : 0;
          } else if (animation.animationName === 'terminal-row-appear') {
            animation.finish();
          }
        }
      }`);
      await delay(60);
      const image = await waitFor(async () => {
        const capture = await win.webContents.capturePage(undefined, { stayHidden: true });
        return capture.isEmpty() ? null : capture;
      }, 'client preview capture');
      fs.writeFileSync(process.env.YCLJ_CLIENT_PREVIEW_IMAGE, image.toPNG());
    }

    fs.writeFileSync(scriptPath, "# " + 'x'.repeat(8000) + "\nWrite-Output 'large-script-ok'", 'utf8');
    const larger = await cli('run', scriptPath);
    assert.equal(larger.status, 'finished');
    assert.equal(larger.exitCode, 0);
    assert.equal(larger.stdout.trim(), 'large-script-ok');

    cursor = (await cli('events')).cursor;
    await cli('send', [
      "Write-Output ('legacy-' + $legacyValue)",
      'Add-Type -AssemblyName System.Drawing',
      '$bitmap = New-Object System.Drawing.Bitmap(16, 16)',
      '$memory = New-Object System.IO.MemoryStream',
      '$bitmap.Save($memory, [Drawing.Imaging.ImageFormat]::Png)',
      "[Console]::WriteLine(('IMAGE-' + 'BEGIN'))",
      '[Console]::WriteLine([Convert]::ToBase64String($memory.ToArray()))',
      "[Console]::WriteLine(('IMAGE-' + 'END'))",
      '$memory.Dispose()',
      '$bitmap.Dispose()'
    ].join('; '));
    const output = await waitFor(async () => {
      const text = await outputSince(cursor);
      return text.includes('\nIMAGE-END') ? text : null;
    }, 'legacy image output');
    assert.match(output, /\nlegacy-old-value\r?\n/);
    const base64 = output.match(/\nIMAGE-BEGIN\r?\n([\s\S]+?)\r?\nIMAGE-END/)[1].replace(/\s/g, '');
    assert.deepEqual(nativeImage.createFromBuffer(Buffer.from(base64, 'base64')).getSize(), { width: 16, height: 16 });

    await cli('send', 'exit');
    await waitFor(async () => (await evaluate('window.ycljClient.getState()')).terminalMode === 'none', 'terminal exited');
    if (terminalView) {
      await evaluate("document.querySelector('#btn-disconnect').click()");
      await waitFor(() => evaluate(`!document.querySelector('#log-toast').hidden &&
        document.querySelector('#log-toast-message').textContent === '详细日志已保存到桌面' &&
        !document.querySelector('#btn-open-log').hidden`), 'desktop log toast beside disconnect');
      if (startShowsStatus) {
        assert.equal(await evaluate(`{
          const start = document.querySelector('#btn-connect');
          const disconnect = document.querySelector('#btn-disconnect');
          !start.disabled && start.textContent.trim() === '开始' &&
            disconnect.disabled && disconnect.textContent.trim() === '断开';
        }`), true);
      }
      const filenames = fs.readdirSync(desktop);
      assert.equal(filenames.length, 1);
      assert.match(filenames[0], /^远程帮助-.+\.log$/);
      const log = fs.readFileSync(path.join(desktop, filenames[0]), 'utf8');
      assert.match(log, /\[cmd\] \$legacyValue =/);
      assert.match(log, /诊断结果/);
      assert.match(log, /\[stderr\] 测试错误/);
      assert.match(log, /\[session\] closed \(manual_disconnect\)/);
      assert.deepEqual(log.split(/\r?\n/).filter(line => /ycljScript_|YCLJ-/.test(line)), []);

      await waitFor(async () => (await cli('status')).sessions.length === 0, 'first session ended');
      await evaluate(`window.ycljClient.start({ relayUrl: ${JSON.stringify(relayUrl)} })`);
      const nextPin = await waitFor(async () => (await evaluate('window.ycljClient.getState()')).pin, 'second PIN');
      await cli('pair', nextPin);
      await cli('send', 'exit');
      await waitFor(async () => (await evaluate('window.ycljClient.getState()')).terminalMode === 'none', 'second terminal exited');
      await cli('disconnect');
      await waitFor(() => fs.readdirSync(desktop).length === 2, 'peer disconnect saved a second log');
      const second = fs.readdirSync(desktop).find(file => !filenames.includes(file));
      assert.match(fs.readFileSync(path.join(desktop, second), 'utf8'), /\[session\] closed \(peer_disconnected\)/);
    } else {
      await cli('disconnect');
    }
    console.log(`[host-script] PASS client ${version}: pairing, command display, terminal state, image return, script isolation, Unicode, stderr and exit code`);
  } finally {
    if (fs.existsSync(manifest)) await cli('shutdown').catch(() => host.kill());
    else host.kill();
    await exited;
  }
}

main().then(() => app.quit(), error => {
  console.error(error);
  app.exit(1);
});
