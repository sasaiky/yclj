const { EventEmitter } = require('node:events');
const { randomBytes } = require('node:crypto');
const { WebSocket } = require('ws');
const { INVITE_TTL, SIGNAL_LIMIT, DATA_LIMIT, idPattern, signalUrl, makeExchangeKey, pinSecret,
  signSignal, verifySignal, operationAllowed } = require('./protocol');
const { openRtc } = require('./rtc');

const messages = {
  operator_unauthorized: '协助设备未获服务器授权',
  operator_password_required: '此控制身份需要额外口令。请用 --ask-password 重新连接。',
  operator_password_invalid: '额外口令错误',
  operator_password_locked: '额外口令连续输错，控制身份已暂时锁定',
  operator_password_unverified: '服务器没有确认额外口令，连接已停止',
  invite_unavailable: '邀请已使用、已过期或找不到该设备',
  invite_expired: '邀请已过期',
  pin_unavailable: '验证码无效、已使用或已过期',
  pin_conflict: '验证码已被占用，请重新开始',
  too_many_codes: '尝试次数过多，请稍后再试',
  session_expired: '协助会话已到期',
  peer_disconnected: '对方已断开',
  rejected: '对方拒绝了协助请求',
  rtc_failed: '无法建立或恢复协助连接',
  handshake_timeout: '协助连接超时',
  invalid_signal: '协助连接身份或信令校验失败',
  signal_unavailable: '协助服务器连接已断开'
};

function connectPeer({ identity, invite, pin, url, operator, trustedOperators, relayOnly = false, viewScreen = false, operatorPassword }) {
  if (!invite) invite = { url: signalUrl(url), pin, route: randomBytes(32).toString('base64url') };
  const pinMode = Boolean(invite.pin);
  let exchange = pinMode ? makeExchangeKey() : null;
  const peer = new EventEmitter();
  const socket = new WebSocket(invite.url, { maxPayload: SIGNAL_LIMIT, perMessageDeflate: false, handshakeTimeout: 10_000 });
  let phase = 'connecting';
  let session = randomBytes(16).toString('hex');
  let remote = operator ? invite.device : null;
  let seq = 0;
  let remoteSeq = operator ? 0 : -1;
  let timer;
  let heartbeat;
  let rtc;
  let screenAvailable = false;
  let recovering = false;
  const expectsPasswordCheck = typeof operatorPassword === 'string';

  function close(code = 'disconnected') {
    if (phase === 'closed') return;
    phase = 'closed';
    clearTimeout(timer);
    clearTimeout(heartbeat);
    rtc?.close();
    if (socket.readyState === WebSocket.CONNECTING) socket.terminate();
    if (socket.readyState === WebSocket.OPEN) socket.close(1000);
    peer.emit('close', code, messages[code] || code);
  }

  function deadline(ms, code) {
    clearTimeout(timer);
    timer = setTimeout(() => close(code), Math.max(0, ms));
  }

  function expectHeartbeat() {
    clearTimeout(heartbeat);
    heartbeat = setTimeout(() => close('signal_unavailable'), 16_000);
  }

  function approved() {
    phase = 'approved';
    deadline(35_000, 'rtc_failed');
  }

  function signal(op, body) {
    if (socket.readyState !== WebSocket.OPEN || socket.bufferedAmount > SIGNAL_LIMIT * 4) {
      close('signal_unavailable');
      return false;
    }
    socket.send(JSON.stringify(signSignal(identity, invite, op, session, seq++, body)));
    return true;
  }

  function onRtc({ event, data }) {
    if (phase === 'closed') return;
    if (event === 'signal') return signal(data.op, data.body);
    if (event === 'open' && phase === 'approved') {
      phase = 'ready';
      clearTimeout(timer);
      peer.emit('ready', session);
    } else if (event === 'data' && phase === 'ready') {
      let message;
      try { if (Buffer.byteLength(data) <= DATA_LIMIT) message = JSON.parse(data); } catch { /* rejected below */ }
      if (!operationAllowed(message, !operator, session)) return close('invalid_signal');
      if (operator && message.type === 'session' && ['screen_started', 'screen_stopped'].includes(message.action)) {
        if (viewScreen) rtc.send({ op: 'screen_state', active: message.action === 'screen_started' });
        return;
      }
      peer.emit('message', message);
    } else if (event === 'screen_available' && !operator) {
      screenAvailable = data === true;
      peer.emit('screen');
    } else if (event === 'screen_capture' && phase === 'ready' && !operator) {
      peer.send({ type: 'session', action: data.active ? 'screen_started' : 'screen_stopped', session_id: session });
      peer.emit('screen', data);
    } else if (event === 'route' && phase === 'ready') {
      peer.emit('route', data);
    } else if (event === 'recovering' && phase === 'ready' && !recovering) {
      recovering = true;
      deadline(20_000, 'rtc_failed');
      peer.emit('route', 'recovering');
    } else if (event === 'recovered' && recovering) {
      recovering = false;
      clearTimeout(timer);
    } else if (event === 'fatal' || event === 'closed') {
      close(event === 'closed' ? 'peer_disconnected' : 'rtc_failed');
    }
  }

  socket.on('open', expectHeartbeat);
  socket.on('ping', expectHeartbeat);
  socket.on('error', () => close('signal_unavailable'));
  socket.on('close', () => close('signal_unavailable'));
  deadline(10_000, 'handshake_timeout');

  socket.on('message', (raw, binary) => {
    if (phase === 'closed') return;
    try {
      const message = binary ? null : JSON.parse(raw.toString());
      if (message?.op === 'error') return close(messages[message.code] ? message.code : 'invalid_signal');
      if (phase === 'connecting' && message?.op === 'challenge' && idPattern.test(message.challenge)) {
        if (pinMode && operator) {
          phase = 'lookup';
          signal('lookup_pin', { challenge: message.challenge, pin: invite.pin, password: operatorPassword });
          operatorPassword = undefined;
          return;
        }
        phase = operator ? 'waiting' : 'registering';
        deadline(invite.expires - Date.now(), 'invite_expired');
        if (operator) peer.emit('waiting', invite.device);
        const registration = { challenge: message.challenge, expires: invite.expires, renewIce: true };
        if (pinMode) signal('register_pin', { ...registration, pin: invite.pin, exchangeKey: exchange.key });
        else signal(operator ? 'request' : 'register', registration);
        return;
      }
      if (phase === 'lookup' && message?.op === 'pin_target') {
        if (expectsPasswordCheck && message.passwordVerified !== true) return close('operator_password_unverified');
        const offer = message.offer;
        const device = verifySignal(offer);
        const expires = offer?.body?.expires;
        if (!device || offer.op !== 'register_pin' || offer.seq !== 0 || offer.body.pin !== invite.pin ||
            !Number.isSafeInteger(expires) || expires <= Date.now() || expires > Date.now() + INVITE_TTL + 60_000) {
          return close('invalid_signal');
        }
        invite = { ...invite, device, expires, route: offer.route };
        invite.secret = pinSecret(exchange, offer.body.exchangeKey, invite, session, identity.id);
        const exchangeKey = exchange.key;
        exchange = null;
        remote = device;
        phase = 'waiting';
        deadline(expires - Date.now(), 'invite_expired');
        peer.emit('pairing', device);
        signal('request_pin', { device, pin: invite.pin, exchangeKey, renewIce: true });
        return;
      }
      if (phase === 'registering' && message?.op === 'registered') {
        if (Date.now() >= invite.expires) return close('invite_expired');
        phase = 'waiting';
        peer.emit('invitation', invite.pin);
        return;
      }
      if (phase === 'approved' && !rtc && message?.op === 'ice' && Array.isArray(message.servers)) {
        rtc = openRtc({ operator, iceServers: message.servers, relayOnly, viewScreen, dataLimit: DATA_LIMIT }, onRtc);
        return;
      }
      if (rtc && ['approved', 'ready'].includes(phase) && message?.op === 'ice_update' && Array.isArray(message.servers)) {
        rtc.send({ op: 'ice_update', servers: message.servers });
        return;
      }

      if (pinMode && !operator && phase === 'waiting' && message?.op === 'request_pin') {
        if (Date.now() >= invite.expires) return close('invite_expired');
        const device = verifySignal(message);
        if (!device || !trustedOperators?.has(device)) return close('operator_unauthorized');
        if (message.route !== invite.route || message.seq !== 1 || message.body?.pin !== invite.pin ||
            message.body?.device !== identity.id) return close('invalid_signal');
        invite.secret = pinSecret(exchange, message.body.exchangeKey, invite, message.session, device);
        if (verifySignal(message, invite) !== device) return close('invalid_signal');
        exchange = null;
        remoteSeq = message.seq;
        remote = device;
        session = message.session;
        if (!signal('accept', null)) return;
        approved();
        peer.emit('pairing', device);
        return;
      }

      const device = verifySignal(message, invite);
      if (!device || (remote && remote !== device) || message.seq !== remoteSeq + 1 ||
          ((operator || remote) && message.session !== session)) return close('invalid_signal');
      remoteSeq = message.seq;
      if (phase === 'waiting' && Date.now() >= invite.expires) return close('invite_expired');
      if (phase === 'waiting' && operator && message.op === 'accept') {
        approved();
      } else if (phase === 'waiting' && operator && message.op === 'reject') {
        close('rejected');
      } else if (rtc && ['approved', 'ready'].includes(phase) &&
          (operator ? ['answer', 'candidate', 'restart'] : ['offer', 'candidate']).includes(message.op)) {
        rtc.send(message);
      } else {
        close('invalid_signal');
      }
    } catch {
      close('invalid_signal');
    }
  });

  peer.send = message => {
    if (phase !== 'ready' || (operator && recovering) || !operationAllowed(message, operator, session)) return false;
    const body = JSON.stringify(message);
    if (Buffer.byteLength(body) > DATA_LIMIT) return false;
    rtc.send({ op: 'data', body });
    return true;
  };
  peer.canShareScreen = () => !operator && phase === 'ready' && screenAvailable;
  peer.shareScreen = sourceId => {
    if (!peer.canShareScreen()) return false;
    rtc.send(sourceId ? { op: 'screen_start', sourceId } : { op: 'screen_stop' });
    return true;
  };
  peer.close = close;
  return peer;
}

module.exports = { connectPeer };
