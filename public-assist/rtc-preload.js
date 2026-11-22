const { ipcRenderer } = require('electron');

ipcRenderer.once('assist:rtc', (event, { operator, iceServers, relayOnly, viewScreen, dataLimit }) => {
  const [port] = event.ports;
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
  let incomingTrack;
  let sharing = false;
  const screenVideo = operator && viewScreen ? document.getElementById('screen') : null;

  if (screenVideo) {
    screenTransceiver = pc.addTransceiver('video', { direction: 'recvonly' });
    screenVideo.addEventListener('playing', () => { if (sharing) report('screen_visible', true); });
    pc.addEventListener('track', ({ track }) => {
      if (track.kind !== 'video') return;
      incomingTrack = track;
      if (sharing) screenVideo.srcObject = new MediaStream([incomingTrack]);
    });
  }

  function updateScreen(active) {
    if (!screenVideo || sharing === active) return;
    sharing = active;
    screenVideo.srcObject = active && incomingTrack ? new MediaStream([incomingTrack]) : null;
    if (!active) report('screen_visible', false);
  }

  async function stopScreen() {
    if (!captureTrack) return;
    captureTrack.stop();
    captureTrack = null;
    report('screen_capture', { active: false });
    try { await screenTransceiver.sender.replaceTrack(null); } catch {
      // The track is already stopped if ICE or the PeerConnection has closed.
    }
  }

  async function startScreen(sourceId) {
    if (operator || captureTrack) return;
    if (screenTransceiver?.currentDirection !== 'sendonly') {
      report('screen_capture', { active: false, error: '屏幕共享不可用' });
      return;
    }
    try {
      const sender = screenTransceiver.sender;
      const parameters = sender.getParameters();
      parameters.encodings[0].maxBitrate = 700_000;
      parameters.degradationPreference = 'maintain-resolution';
      await sender.setParameters(parameters);
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { mandatory: { chromeMediaSource: 'desktop', chromeMediaSourceId: sourceId,
          maxWidth: 1280, maxHeight: 720, maxFrameRate: 15 } }
      });
      const [track] = stream.getVideoTracks();
      captureTrack = track;
      track.contentHint = 'detail';
      track.addEventListener('ended', () => { if (captureTrack === track) void stopScreen(); });
      await sender.replaceTrack(track);
      if (captureTrack === track) report('screen_capture', { active: true });
    } catch {
      captureTrack?.stop();
      captureTrack = null;
      report('screen_capture', { active: false, error: '无法共享屏幕' });
    }
  }

  function bindChannel(active) {
    channel = active;
    channel.addEventListener('open', () => {
      opened = true;
      report('open');
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
    if (message.op === 'screen_state') return updateScreen(message.active);
    if (message.op === 'data') {
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
    bindChannel(pc.createDataChannel('yclj-assist-1'));
    queue(async () => describe(await pc.createOffer()));
  }
});
