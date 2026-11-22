const app = process.versions.electron ? require('electron').app : null;
const { connectPeer } = require('./peer');
const { readInvite, getIdentity } = require('./protocol');

app?.disableHardwareAcceleration();
let peer;
let exiting = false;

function send(message) {
  if (process.connected) process.send(message, () => {});
}

function quit(code) {
  if (app) app.exit(code);
  else process.exit(code);
}

function exit(code = 0) {
  if (exiting) return;
  exiting = true;
  peer?.close();
  quit(code);
}

process.on('disconnect', () => exit());
process.on('message', input => {
  if (input.type === 'close') return exit();
  if (peer && !exiting && !peer.send(input)) {
    send({ type: 'error', code: 'operation_unavailable', message: '当前会话无法发送该操作' });
  }
});
process.once('message', async config => {
  if (exiting) return;
  try {
    if (app) {
      app.setPath('userData', config.profile);
      await app.whenReady();
    }
    if (exiting) return;
    const target = config.pin ? { pin: config.pin, url: config.url } : { invite: readInvite(config.invitation) };
    const rtcFactory = app ? undefined : require('./rtc-native').createRtcFactory(config.nativeViewer, config.profile);
    peer = connectPeer({ identity: getIdentity(config.deviceDirectory), ...target,
      operator: true, relayOnly: config.relayOnly, viewScreen: config.viewScreen, operatorPassword: config.operatorPassword, rtcFactory });
    config.operatorPassword = undefined;
    peer.on('waiting', device => send({ type: 'session', action: 'awaiting_approval', device }));
    peer.on('pairing', () => send({ type: 'session', action: 'connecting' }));
    peer.on('ready', session_id => send({ type: 'session', action: 'paired', session_id }));
    peer.on('route', route => send({ type: 'session', action: 'route', route }));
    peer.on('message', send);
    peer.on('close', (code, message) => {
      if (exiting) return;
      exiting = true;
      if (!process.connected) return quit(0);
      process.send({ type: 'assist_closed', code, message }, () => quit(0));
    });
  } catch (error) {
    if (!process.connected) return exit(1);
    process.send({ type: 'assist_closed', code: 'start_failed', message: error.message }, () => exit(1));
  }
});
