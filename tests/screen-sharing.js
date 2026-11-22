const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { app, BrowserWindow, desktopCapturer, screen, session } = require('electron');
const { getIdentity } = require('../public-assist/protocol');
const { createServer } = require('../public-assist/server');
const { connectPeer } = require('../public-assist/peer');
const { terminalText } = require('../operator-cli/terminal-text');

const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yclj-screen-test-'));
const operator = getIdentity(path.join(base, 'operator'));
app.setPath('userData', path.join(base, 'client'));
app.setPath('desktop', base);
process.env.YCLJ_ASSIST_TRUSTED_OPERATORS = operator.id;
let captureSelections = 0;
desktopCapturer.getSources = async () => {
  captureSelections++;
  return [{ id: 'screen:test', display_id: String(screen.getPrimaryDisplay().id) }];
};
require('../electron-client-win/main');

const server = createServer({
  operatorIds: [operator.id],
  turnUrls: ['turn:127.0.0.1:3478?transport=udp'],
  turnSecret: 'screen-sharing-loopback-test-secret'
});
let peer;

async function waitFor(check, description) {
  const end = Date.now() + 10000;
  do {
    const result = await check();
    if (result) return result;
    await delay(40);
  } while (Date.now() < end);
  throw new Error('Timeout: ' + description);
}

async function click(windowsClient) {
  const contents = windowsClient.webContents;
  const position = await contents.executeJavaScript(`(() => {
    const box = document.querySelector('#btn-share-screen').getBoundingClientRect();
    return { x: Math.round(box.x + box.width / 2), y: Math.round(box.y + box.height / 2) };
  })()`);
  windowsClient.focus();
  contents.sendInputEvent({ type: 'mouseMove', ...position });
  contents.sendInputEvent({ type: 'mouseDown', ...position, button: 'left', clickCount: 1 });
  contents.sendInputEvent({ type: 'mouseUp', ...position, button: 'left', clickCount: 1 });
}

async function main() {
  const listening = once(server, 'listening');
  server.listen(0, '127.0.0.1');
  await Promise.all([listening, app.whenReady()]);
  const url = 'ws://127.0.0.1:' + server.address().port + '/assist';
  const windowsClient = await waitFor(() => BrowserWindow.getAllWindows()[0], 'Windows client window');
  const evaluate = code => windowsClient.webContents.executeJavaScript(code);
  const clientState = () => evaluate('window.ycljClient.getState()');
  await waitFor(() => evaluate('Boolean(window.ycljClient)'), 'Windows client preload');
  await evaluate(`window.ycljClient.start(${JSON.stringify({ relayUrl: url, shell: process.platform === 'win32' ? 'cmd.exe' : '/bin/cat' })})`);
  const pin = await waitFor(async () => (await clientState()).pin, 'pairing code');
  peer = connectPeer({ identity: operator, pin, url, operator: true, viewScreen: true });
  await waitFor(async () => (await clientState()).screenShareAvailable, 'sharing capability');

  const rtcWindows = BrowserWindow.getAllWindows().filter(window => window !== windowsClient);
  const capture = rtcWindows.find(window => window.webContents.session === session.fromPartition('yclj-assist-display'));
  const viewer = rtcWindows.find(window => window !== capture);
  const inCapture = code => capture.webContents.executeJavaScriptInIsolatedWorld(999, [{ code }]);
  const inViewer = code => viewer.webContents.executeJavaScript(code);
  await inCapture(`const setParameters = RTCRtpSender.prototype.setParameters;
  RTCRtpSender.prototype.setParameters = function (params) {
    globalThis.testVideoEncoding = params.encodings[0];
    return setParameters.call(this, params);
  };
  navigator.mediaDevices.getUserMedia = async ({ audio, video }) => {
    if (audio !== false || video.mandatory.chromeMediaSourceId !== 'screen:test') throw new Error('Unexpected capture');
    const canvas = document.createElement('canvas');
    canvas.width = video.mandatory.maxWidth;
    canvas.height = video.mandatory.maxHeight;
    const context = canvas.getContext('2d');
    let frame = 0;
    const paint = () => {
      context.fillStyle = ++frame % 2 ? '#336699' : '#346998';
      context.fillRect(0, 0, canvas.width, canvas.height);
    };
    paint();
    const stream = canvas.captureStream(15);
    globalThis.testTrack = stream.getVideoTracks()[0];
    const timer = setInterval(() => {
      if (globalThis.testTrack.readyState === 'ended') clearInterval(timer);
      else paint();
    }, 50);
    return stream;
  }; undefined`);

  assert.equal(viewer.isVisible(), false);
  assert.equal(await inViewer('document.querySelector("video").srcObject === null'), true);
  await evaluate('document.querySelector("#btn-share-screen").click()');
  assert.equal(captureSelections, 0, 'programmatic click must not capture');
  let commandOutput = '';
  peer.on('message', message => {
    if (message.type === 'exec') commandOutput = (commandOutput + message.payload).slice(-4096);
  });
  for (let index = 0; index < 2; index++) {
    await click(windowsClient);
    await waitFor(async () => (await clientState()).screenSharing, 'local share started');
    await waitFor(() => viewer.isVisible(), 'viewer opened');
    assert.equal(await inViewer('document.querySelector("video").videoHeight'), 720);
    assert.equal(await inCapture('globalThis.testVideoEncoding.maxBitrate'), 900_000);
    assert.equal(await inViewer('document.querySelector("#screen-controls").hidden'), false);

    if (index === 0) {
      for (const [quality, height, bitrate, fps] of [
        ['clear', 1080, 1_800_000, 15],
        ['economy', 540, 350_000, 8],
        ['standard', 720, 900_000, 15]
      ]) {
        await inViewer(`(() => {
          const select = document.querySelector('#screen-quality');
          select.value = ${JSON.stringify(quality)};
          select.dispatchEvent(new Event('change'));
        })()`);
        await waitFor(async () => await inViewer('document.querySelector("video").videoHeight') === height, 'video resized to ' + height);
        const encoding = await inCapture('globalThis.testVideoEncoding');
        assert.equal(encoding.maxBitrate, bitrate);
        assert.equal(encoding.maxFramerate, fps);
        assert.equal(captureSelections, 1, 'changing quality must reuse the selected screen');
      }
    }

    const marker = 'YCLJ-VIDEO-CONTROL-' + index;
    const command = process.platform === 'win32' ? 'echo ' + marker : marker;
    const { sessionId } = await clientState();
    assert(peer.send({ type: 'exec', stream: 'stdin', payload: command + '\r\n', session_id: sessionId }));
    await waitFor(() => terminalText(commandOutput).split('\n').some(line => line.trim() === marker),
      'command output during video');

    await click(windowsClient);
    await waitFor(async () => !(await clientState()).screenSharing && !viewer.isVisible(), 'share stopped');
    assert.equal(await inViewer('document.querySelector("video").srcObject === null'), true);
    assert.equal(await inCapture('globalThis.testTrack.readyState'), 'ended');
  }
  await click(windowsClient);
  await waitFor(() => viewer.isVisible(), 'viewer reopened before disconnect');
  assert.equal(captureSelections, 3);
  await evaluate('window.ycljClient.disconnect()');
  await waitFor(() => viewer.isDestroyed() && capture.isDestroyed(), 'RTC windows closed');
  console.log('[screen] PASS consent, all three quality settings, commands during video, stop, repeat, and disconnect');
}

function finish(code, error) {
  if (error) console.error(error.stack);
  peer?.close();
  server.close();
  fs.rmSync(base, { recursive: true, force: true, maxRetries: 3 });
  app.exit(code);
}

main().then(() => finish(0), error => finish(1, error));
