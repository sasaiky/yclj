function startRtc({ operator, iceServers, relayOnly, viewScreen, screenQualities, dataLimit }, port) {
  const report = (event, data) => port.postMessage({ event, data });
  const pc = new RTCPeerConnection({ iceServers, iceTransportPolicy: relayOnly ? 'relay' : 'all' });
  let channel;
  let opened = false;
  let retryTimer;
  let restarting = false;
  let previousRoute;
  let statsPending = false;
  let pendingCandidates;
  let actions = Promise.resolve();
  let screenTransceiver;
  let captureTrack;
  let sendingQuality;
  let incomingTrack;
  let sharing = false;
  let viewingQuality;
  let controlling = false;
  const screenVideo = operator && viewScreen ? document.getElementById('screen') : null;
  const qualitySelect = screenVideo && document.getElementById('screen-quality');

  if (screenVideo) {
    bindScreenInput();
    screenTransceiver = pc.addTransceiver('video', { direction: 'recvonly' });
    qualitySelect.addEventListener('change', () => {
      if (viewingQuality) report('screen_quality', qualitySelect.value);
    });
    screenVideo.addEventListener('playing', () => { if (sharing) report('screen_visible', true); });
    pc.addEventListener('track', ({ track }) => {
      if (track.kind !== 'video') return;
      incomingTrack = track;
      if (sharing) screenVideo.srcObject = new MediaStream([incomingTrack]);
    });
  }

  function bindScreenInput() {
    const keyboard = document.getElementById('screen-keyboard');
    const input = (action, fields) => { if (controlling) report('screen_input', { action, ...fields }); };
    let lastMove = 0;
    const buttons = new Set();
    const keys = new Set();

    function position(event, clamp = false) {
      const rect = screenVideo.getBoundingClientRect();
      const { videoWidth, videoHeight } = screenVideo;
      if (!videoWidth || !videoHeight) return;
      const scale = Math.min(rect.width / videoWidth, rect.height / videoHeight);
      const width = videoWidth * scale;
      const height = videoHeight * scale;
      const x = (event.clientX - rect.x - (rect.width - width) / 2) / width;
      const y = (event.clientY - rect.y - (rect.height - height) / 2) / height;
      if (!clamp && (x < 0 || x > 1 || y < 0 || y > 1)) return;
      return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
    }

    const release = () => { buttons.clear(); keys.clear(); input('release'); };
    screenVideo.addEventListener('pointerdown', event => {
      if (!controlling || !event.isTrusted || ![0, 2].includes(event.button)) return;
      const point = position(event);
      if (!point) return;
      event.preventDefault();
      keyboard.focus({ preventScroll: true });
      screenVideo.setPointerCapture(event.pointerId);
      buttons.add(event.button);
      input('button', { ...point, button: event.button, down: true });
    });
    screenVideo.addEventListener('pointerup', event => {
      if (!event.isTrusted || !buttons.delete(event.button)) return;
      const point = position(event, true);
      if (point) input('button', { ...point, button: event.button, down: false });
      else release();
    });
    screenVideo.addEventListener('pointermove', event => {
      if (!controlling || !event.isTrusted || performance.now() - lastMove < 35) return;
      const point = position(event, buttons.size > 0);
      if (point) {
        lastMove = performance.now();
        input('move', point);
      }
    });
    screenVideo.addEventListener('pointercancel', release);
    screenVideo.addEventListener('contextmenu', event => { if (controlling) event.preventDefault(); });
    screenVideo.addEventListener('wheel', event => {
      if (!controlling || !event.isTrusted) return;
      const point = position(event);
      if (!point) return;
      event.preventDefault();
      const scale = event.deltaMode === 1 ? 40 : event.deltaMode === 2 ? 120 : 1;
      const delta = value => Math.round(Math.max(-1200, Math.min(1200, -value * scale)));
      input('wheel', { ...point, dx: delta(event.deltaX), dy: delta(event.deltaY) });
    }, { passive: false });

    const textKey = event => event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey;
    const pasteKey = event => (event.metaKey || event.ctrlKey) && event.code === 'KeyV';
    keyboard.addEventListener('keydown', event => {
      if (!controlling || !event.isTrusted || event.isComposing || textKey(event) || pasteKey(event)) return;
      event.preventDefault();
      if (!/^[A-Za-z0-9]{1,24}$/.test(event.code)) return;
      keys.add(event.code);
      input('key', { code: event.code, down: true });
    });
    keyboard.addEventListener('keyup', event => {
      if (!controlling || !event.isTrusted || !keys.delete(event.code)) return;
      event.preventDefault();
      input('key', { code: event.code, down: false });
    });
    function sendText(text) {
      const chars = Array.from(text.slice(0, 8192));
      for (let start = 0; start < chars.length; start += 256) input('text', { text: chars.slice(start, start + 256).join('') });
    }
    keyboard.addEventListener('input', event => {
      if (!event.isTrusted || event.isComposing) return;
      sendText(keyboard.value);
      keyboard.value = '';
    });
    keyboard.addEventListener('paste', event => {
      if (!controlling || !event.isTrusted) return;
      event.preventDefault();
      sendText(event.clipboardData.getData('text/plain'));
    });
    keyboard.addEventListener('blur', release);
    window.addEventListener('blur', release);
  }

  function updateScreen(active, quality, input) {
    if (!screenVideo) return;
    controlling = active && input === true;
    if (!controlling) document.getElementById('screen-keyboard').blur();
    viewingQuality = active && quality;
    document.getElementById('screen-controls').hidden = !viewingQuality && !controlling;
    document.getElementById('screen-input-status').hidden = !controlling;
    document.getElementById('screen-quality-label').hidden = !viewingQuality;
    qualitySelect.hidden = !viewingQuality;
    if (viewingQuality) qualitySelect.value = viewingQuality;
    if (sharing === active) return;
    sharing = active;
    screenVideo.srcObject = active && incomingTrack ? new MediaStream([incomingTrack]) : null;
    if (!active) report('screen_visible', false);
  }

  async function stopScreen() {
    if (!captureTrack) return;
    captureTrack.stop();
    captureTrack = null;
    sendingQuality = null;
    report('screen_capture', { active: false });
    try { await screenTransceiver.sender.replaceTrack(null); } catch {
      // The track is already stopped if ICE or the PeerConnection has closed.
    }
  }

  async function configureScreen(track, quality) {
    const profile = screenQualities[quality];
    const sender = screenTransceiver.sender;
    const parameters = sender.getParameters();
    const { width = screenQualities.clear.width, height = screenQualities.clear.height } = track.getSettings();
    Object.assign(parameters.encodings[0], {
      maxBitrate: profile.bitrate,
      maxFramerate: profile.fps,
      scaleResolutionDownBy: Math.max(1, width / profile.width, height / profile.height)
    });
    parameters.degradationPreference = 'maintain-resolution';
    await sender.setParameters(parameters);
  }

  async function changeScreenQuality(quality) {
    const track = captureTrack;
    if (!track || !sendingQuality || !Object.hasOwn(screenQualities, quality)) return;
    try {
      await configureScreen(track, quality);
      if (captureTrack !== track) return;
      sendingQuality = quality;
      report('screen_capture', { active: true, quality });
    } catch {
      if (captureTrack === track) report('screen_capture', { active: true, quality: sendingQuality, error: '无法切换画质' });
    }
  }

  async function startScreen(sourceId) {
    if (operator || captureTrack) return;
    if (screenTransceiver?.currentDirection !== 'sendonly') {
      report('screen_capture', { active: false, error: '屏幕共享不可用' });
      return;
    }
    try {
      const { width, height, fps } = screenQualities.clear;
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId,
          maxWidth: width, maxHeight: height, maxFrameRate: fps } }
      });
      const [track] = stream.getVideoTracks();
      captureTrack = track;
      track.contentHint = 'detail';
      track.addEventListener('ended', () => { if (captureTrack === track) void stopScreen(); });
      await configureScreen(track, 'standard');
      if (captureTrack !== track) return;
      await screenTransceiver.sender.replaceTrack(track);
      if (captureTrack === track) {
        sendingQuality = 'standard';
        report('screen_capture', { active: true, quality: sendingQuality });
      }
    } catch {
      captureTrack?.stop();
      captureTrack = null;
      sendingQuality = null;
      report('screen_capture', { active: false, error: '无法共享屏幕' });
    }
  }

  function bindChannel(active) {
    channel = active;
    channel.addEventListener('open', () => {
      opened = true;
      report('open', { screenInput: channel.protocol === 'yclj-screen-input-v1' });
      updateRoute();
    });
    channel.addEventListener('message', ({ data }) => {
      if (typeof data !== 'string' || data.length > dataLimit) return report('fatal');
      report('data', data);
    });
    channel.addEventListener('close', () => report('closed'));
    channel.addEventListener('error', () => report('fatal'));
  }

  async function updateRoute() {
    if (!opened || statsPending || !['connected', 'completed'].includes(pc.iceConnectionState)) return;
    statsPending = true;
    try {
      const stats = await pc.getStats();
      const transport = [...stats.values()].find(item => item.type === 'transport' && item.selectedCandidatePairId);
      const pair = stats.get(transport?.selectedCandidatePairId);
      const local = stats.get(pair?.localCandidateId);
      const remote = stats.get(pair?.remoteCandidateId);
      if (!local || !remote) return;
      const route = local.candidateType === 'relay' || remote.candidateType === 'relay' ? 'relay' : 'direct';
      if (previousRoute !== route) {
        previousRoute = route;
        report('route', route);
      }
    } catch {
      // The transport may close while Chromium collects the report.
    } finally {
      statsPending = false;
    }
  }

  function queue(operation) {
    actions = actions.then(operation).catch(() => report('fatal'));
  }

  function beginRecovery() {
    previousRoute = null;
    report('recovering');
  }

  async function describe(description) {
    pendingCandidates = [];
    await pc.setLocalDescription(description);
    report('signal', { op: description.type, body: pc.localDescription.sdp });
    for (const body of pendingCandidates) report('signal', { op: 'candidate', body });
    pendingCandidates = null;
  }

  async function restart() {
    if (!opened || restarting || pc.signalingState !== 'stable') return;
    restarting = true;
    beginRecovery();
    await describe(await pc.createOffer({ iceRestart: true }));
  }

  pc.addEventListener('datachannel', ({ channel: incoming }) => {
    if (operator || channel || incoming.label !== 'yclj-assist-1') return report('fatal');
    bindChannel(incoming);
  });
  pc.addEventListener('icecandidate', ({ candidate }) => {
    if (!candidate) return;
    const body = candidate.toJSON();
    if (pendingCandidates) pendingCandidates.push(body);
    else report('signal', { op: 'candidate', body });
  });
  pc.addEventListener('iceconnectionstatechange', () => {
    const state = pc.iceConnectionState;
    clearTimeout(retryTimer);
    if (['connected', 'completed'].includes(state)) {
      if (restarting || previousRoute === null) report('recovered');
      restarting = false;
      updateRoute();
    } else if (opened && ['disconnected', 'failed'].includes(state)) {
      beginRecovery();
      retryTimer = setTimeout(() => {
        if (operator) queue(restart);
        else report('signal', { op: 'restart', body: null });
      }, state === 'failed' ? 0 : 2500);
    } else if (!opened && state === 'failed') {
      report('fatal');
    }
  });

  port.onmessage = ({ data: message }) => {
    if (message.op === 'screen_start') return void startScreen(message.sourceId);
    if (message.op === 'screen_stop') return void stopScreen();
    if (message.op === 'screen_state') return updateScreen(message.active, message.quality, message.input);
    if (message.op === 'screen_quality') return queue(() => changeScreenQuality(message.quality));
    if (message.op === 'screen_quality_failed' && viewingQuality) {
      qualitySelect.value = viewingQuality;
      return;
    }
    if (message.op === 'data') {
      if (message.volatile && channel?.bufferedAmount > dataLimit * 2) return;
      if (channel?.readyState !== 'open' || channel.bufferedAmount > dataLimit * 32) return report('fatal');
      try { channel.send(message.body); } catch { report('fatal'); }
      return;
    }
    queue(async () => {
      if (message.op === 'ice_update') {
        pc.setConfiguration({ ...pc.getConfiguration(), iceServers: message.servers });
      } else if (message.op === 'candidate') {
        await pc.addIceCandidate(message.body);
      } else if (message.op === 'restart' && operator) {
        await restart();
      } else if (message.op === (operator ? 'answer' : 'offer')) {
        if (opened && !restarting) {
          restarting = true;
          beginRecovery();
        }
        await pc.setRemoteDescription({ type: message.op, sdp: message.body });
        if (!operator) {
          screenTransceiver = pc.getTransceivers().find(transceiver => transceiver.receiver.track.kind === 'video');
          if (screenTransceiver) screenTransceiver.direction = 'sendonly';
          await describe(await pc.createAnswer());
          if (screenTransceiver) report('screen_available', screenTransceiver.currentDirection === 'sendonly');
        }
        if (opened && ['connected', 'completed'].includes(pc.iceConnectionState)) {
          restarting = false;
          report('recovered');
          updateRoute();
        }
      }
    });
  };

  setInterval(updateRoute, 1000);
  if (operator) {
    bindChannel(pc.createDataChannel('yclj-assist-1', { protocol: viewScreen ? 'yclj-screen-input-v1' : '' }));
    queue(async () => describe(await pc.createOffer()));
  }
}

if (typeof require === 'function') {
  const { ipcRenderer } = require('electron');
  ipcRenderer.once('assist:rtc', (event, options) => startRtc(options, event.ports[0]));
} else {
  const bridge = window.webkit?.messageHandlers?.assistRtc ?? window.chrome.webview;
  const port = { postMessage: message => bridge.postMessage(JSON.stringify(message)) };
  globalThis.ycljRtcStart = options => startRtc(options, port);
  globalThis.ycljRtcReceive = data => port.onmessage({ data });
}
