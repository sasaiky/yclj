const { app } = require('electron');
const { connectPeer } = require('./peer');
const { readInvite, getIdentity } = require('./protocol');

app.disableHardwareAcceleration();
let peer;
let exiting = false;

function send(message) {
  if (process.connected) process.send(message, () => {});
}

function exit(code = 0) {
  if (exiting) return;
  exiting = true;
  peer?.close();
  app.exit(code);
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
    app.setPath('userData', config.profile);
    await app.whenReady();
    if (exiting) return;
    const target = config.pin ? { pin: config.pin, url: config.url } : { invite: readInvite(config.invitation) };
    peer = connectPeer({ identity: getIdentity(config.deviceDirectory), ...target,
      operator: true, relayOnly: config.relayOnly, operatorPassword: config.operatorPassword });
    config.operatorPassword = undefined;
    peer.on('waiting', device => send({ type: 'session', action: 'awaiting_approval', device }));
    peer.on('pairing', () => send({ type: 'session', action: 'connecting' }));
    peer.on('ready', session_id => send({ type: 'session', action: 'paired', session_id }));
    peer.on('route', route => send({ type: 'session', action: 'route', route }));
    peer.on('message', send);
    peer.on('close', (code, message) => {
      if (exiting) return;
      exiting = true;
      if (!process.connected) return app.exit(0);
      process.send({ type: 'assist_closed', code, message }, () => app.exit(0));
    });
  } catch (error) {
    if (!process.connected) return exit(1);
    process.send({ type: 'assist_closed', code: 'start_failed', message: error.message }, () => exit(1));
  }
});
