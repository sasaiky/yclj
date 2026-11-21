const { randomBytes, createHmac } = require('node:crypto');
const http = require('node:http');
const { isIP } = require('node:net');
const { WebSocket, WebSocketServer } = require('ws');
const { INVITE_TTL, SIGNAL_LIMIT, idPattern, pinPattern, readExchangeKey, verifySignal } = require('./protocol');
const { parseVerifiers, createPasswordGate } = require('./operator-password');

const TURN_CREDENTIAL_TTL = 65 * 60_000;
const SOURCE_WINDOW_MS = 60_000;
const SOURCE_CONNECTION_LIMIT = 16;
const SOURCE_UPGRADE_LIMIT = 40;
const SOURCE_TABLE_LIMIT = 4096;

function sourceAddress(request) {
  const address = request.socket.remoteAddress;
  const forwarded = request.headers['x-forwarded-for'];
  // Only the local Caddy proxy is trusted to replace X-Forwarded-For.
  if (address === '127.0.0.1' && typeof forwarded === 'string' && isIP(forwarded)) return forwarded;
  return address;
}

function createServer({ operatorIds, operatorPasswords, turnSecret, turnUrls, turnRenewalInterval = 45 * 60_000 }) {
  if (!operatorIds.length || operatorIds.some(id => !idPattern.test(id))) throw new Error('配置 YCLJ_ASSIST_OPERATOR_IDS');
  if (!turnSecret || Buffer.byteLength(turnSecret) < 32) throw new Error('配置至少 32 字节的 YCLJ_ASSIST_TURN_SECRET');
  if (!turnUrls.length || turnUrls.some(url => !/^turns?:[a-z\d.[\]:-]+(?:\?transport=(?:udp|tcp))?$/i.test(url))) {
    throw new Error('配置有效的 YCLJ_ASSIST_TURN_URLS');
  }
  const authorized = new Set(operatorIds);
  const passwordVerifiers = parseVerifiers(operatorPasswords);
  if ([...passwordVerifiers.keys()].some(id => !authorized.has(id))) throw new Error('额外口令对应的设备必须在授权列表中');
  const verifyPassword = createPasswordGate(passwordVerifiers);
  const invites = new Map();
  const pins = new Map();
  const pinMisses = new Map();
  const sources = new Map();
  const httpServer = http.createServer((_request, response) => response.writeHead(404).end());
  const wss = new WebSocketServer({ noServer: true, maxPayload: SIGNAL_LIMIT, perMessageDeflate: false });

  httpServer.on('upgrade', (request, socket, head) => {
    if (request.url !== '/assist' || request.headers.origin || wss.clients.size >= 256) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const address = sourceAddress(request);
    const now = Date.now();
    let source = sources.get(address);
    if (!source && sources.size < SOURCE_TABLE_LIMIT) {
      source = { active: 0, upgrades: 0, resetsAt: now + SOURCE_WINDOW_MS };
      sources.set(address, source);
    }
    if (source && source.resetsAt <= now) {
      source.upgrades = 0;
      source.resetsAt = now + SOURCE_WINDOW_MS;
    }
    if (!source || source.active >= SOURCE_CONNECTION_LIMIT || source.upgrades >= SOURCE_UPGRADE_LIMIT) {
      socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nRetry-After: 60\r\n\r\n');
      return;
    }
    source.upgrades++;
    wss.handleUpgrade(request, socket, head, ws => {
      source.active++;
      ws.once('close', () => { source.active--; });
      wss.emit('connection', ws);
    });
  });

  function send(ws, message) {
    if (ws.readyState !== WebSocket.OPEN) return false;
    if (ws.bufferedAmount > SIGNAL_LIMIT * 4) {
      ws.terminate();
      return false;
    }
    ws.send(JSON.stringify(message));
    return true;
  }

  function fail(ws, code) {
    send(ws, { op: 'error', code });
    ws.close(1008, code);
  }

  function retire(pair) {
    if (invites.get(pair.route) === pair) invites.delete(pair.route);
    if (pair.pin && pins.get(pair.pin)?.pair === pair) pins.set(pair.pin, { expires: pair.expires });
  }

  function ice(session, role, op = 'ice') {
    const username = `${Math.ceil((Date.now() + TURN_CREDENTIAL_TTL) / 1000)}:${session}:${role}`;
    const credential = createHmac('sha1', turnSecret).update(username).digest('base64');
    const stunUrls = turnUrls.filter(url => url.startsWith('turn:') && !url.endsWith('=tcp'))
      .map(url => url.replace(/^turn:/, 'stun:').replace(/\?transport=udp$/, ''));
    return { op, servers: [...(stunUrls.length ? [{ urls: stunUrls }] : []), { urls: turnUrls, username, credential }] };
  }

  wss.on('connection', ws => {
    let timer;
    let role;
    let pair;
    let target;
    let identity;
    let seq = -1;
    const challenge = randomBytes(32).toString('base64url');
    const deadline = (ms, reason) => {
      clearTimeout(timer);
      if (reason) timer = setTimeout(() => fail(ws, reason), ms);
    };

    function claim(available, message) {
      retire(available);
      role = 'operator';
      pair = available;
      target = null;
      pair.operator = ws;
      pair.session = message.session;
      pair.operatorDeadline = deadline;
      pair.operatorRenewsIce = message.body?.renewIce === true;
      deadline(pair.expires - Date.now(), 'invite_expired');
      if (!send(pair.client, message)) fail(ws, 'peer_disconnected');
    }

    ws.alive = true;
    ws.on('pong', () => { ws.alive = true; });
    ws.on('error', () => ws.terminate());
    deadline(10_000, 'handshake_timeout');
    send(ws, { op: 'challenge', challenge });

    ws.on('message', (raw, binary) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      let message;
      try { if (!binary) message = JSON.parse(raw.toString()); } catch { /* rejected below */ }
      const device = verifySignal(message);
      if (!device || message.seq !== seq + 1 || (identity && identity !== device)) return fail(ws, 'invalid_signal');
      seq = message.seq;

      if (!role) {
        if (message.body?.challenge !== challenge) return fail(ws, 'invalid_challenge');
        identity = device;
        if (['register', 'register_pin'].includes(message.op)) {
          const expires = message.body.expires;
          if (!Number.isSafeInteger(expires) || expires <= Date.now() || expires > Date.now() + INVITE_TTL + 60_000 ||
              invites.has(message.route)) return fail(ws, 'invalid_invite');
          const pin = message.op === 'register_pin' ? message.body.pin : null;
          if (message.op === 'register_pin') {
            if (typeof pin !== 'string' || !pinPattern.test(pin)) return fail(ws, 'invalid_invite');
            try { readExchangeKey(message.body.exchangeKey); } catch { return fail(ws, 'invalid_signal'); }
            if (pins.get(pin)?.expires > Date.now()) return fail(ws, 'pin_conflict');
          }
          role = 'client';
          pair = { route: message.route, client: ws, expires, active: false, session: null, pin,
            clientRenewsIce: message.body.renewIce === true };
          if (pin) {
            pair.offer = message;
            pair.device = device;
            pins.set(pin, { pair, expires });
          }
          invites.set(pair.route, pair);
          deadline(expires - Date.now(), 'invite_expired');
          send(ws, { op: 'registered' });
          return;
        }

        if (!authorized.has(device)) return fail(ws, 'operator_unauthorized');
        const requiresPassword = passwordVerifiers.has(device);
        if (requiresPassword && message.op !== 'lookup_pin') return fail(ws, 'operator_password_required');
        if (message.op === 'lookup_pin') {
          const passwordError = verifyPassword(device, message.body?.password);
          if (passwordError) return fail(ws, passwordError);
          const pin = message.body.pin;
          if (typeof pin !== 'string' || !pinPattern.test(pin)) return fail(ws, 'invalid_signal');
          const now = Date.now();
          let misses = pinMisses.get(device);
          if (!misses || misses.expires <= now) {
            misses = { count: 0, expires: now + 60_000 };
            pinMisses.set(device, misses);
          }
          if (misses.count >= 5) return fail(ws, 'too_many_codes');
          target = pins.get(pin)?.pair;
          if (!target || target.expires <= now || target.client.readyState !== WebSocket.OPEN) {
            misses.count++;
            return fail(ws, 'pin_unavailable');
          }
          role = 'lookup';
          send(ws, { op: 'pin_target', offer: target.offer, ...(requiresPassword ? { passwordVerified: true } : {}) });
          return;
        }
        if (message.op !== 'request') return fail(ws, 'invalid_signal');
        const available = invites.get(message.route);
        if (!available || available.pin || available.expires <= Date.now()) return fail(ws, 'invite_unavailable');
        claim(available, message);
        return;
      }

      if (role === 'lookup') {
        if (message.op !== 'request_pin' || message.route !== target.route || message.body?.pin !== target.pin ||
            message.body?.device !== target.device) return fail(ws, 'invalid_signal');
        try { readExchangeKey(message.body.exchangeKey); } catch { return fail(ws, 'invalid_signal'); }
        if (pins.get(target.pin)?.pair !== target || target.expires <= Date.now() || target.client.readyState !== WebSocket.OPEN) {
          return fail(ws, 'pin_unavailable');
        }
        claim(target, message);
        return;
      }

      if (!pair.operator || message.route !== pair.route || message.session !== pair.session) return fail(ws, 'invalid_session');
      const peer = role === 'client' ? pair.operator : pair.client;
      if (!pair.active) {
        if (Date.now() >= pair.expires) return fail(ws, 'invite_expired');
        if (role !== 'client' || !['accept', 'reject'].includes(message.op)) {
          return fail(ws, 'approval_required');
        }
        if (!send(peer, message)) return fail(ws, 'peer_disconnected');
        if (message.op === 'reject') return ws.close(1000, 'rejected');
        pair.active = true;
        deadline();
        pair.operatorDeadline();
        send(peer, ice(pair.session, 'operator'));
        send(ws, ice(pair.session, 'client'));
        if (pair.operatorRenewsIce || pair.clientRenewsIce) {
          pair.iceRenewal = setInterval(() => {
            if (pair.operatorRenewsIce) send(peer, ice(pair.session, 'operator', 'ice_update'));
            if (pair.clientRenewsIce) send(ws, ice(pair.session, 'client', 'ice_update'));
          }, turnRenewalInterval);
        }
        return;
      }

      const allowed = role === 'operator' ? ['offer', 'candidate'] : ['answer', 'candidate', 'restart'];
      if (!allowed.includes(message.op)) return fail(ws, 'invalid_signal');
      if (!send(peer, message)) fail(ws, 'peer_disconnected');
    });

    ws.on('close', () => {
      clearTimeout(timer);
      if (!pair) return;
      clearInterval(pair.iceRenewal);
      retire(pair);
      const peer = role === 'client' ? pair.operator : pair.client;
      if (peer?.readyState === WebSocket.OPEN) fail(peer, 'peer_disconnected');
    });
  });

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const [address, source] of sources) {
      if (!source.active && source.resetsAt <= now) sources.delete(address);
    }
    for (const [pin, entry] of pins) {
      if (entry.expires <= now) pins.delete(pin);
    }
    for (const ws of wss.clients) {
      if (!ws.alive) ws.terminate();
      else if (ws.readyState === WebSocket.OPEN) {
        ws.alive = false;
        ws.ping();
      }
    }
  }, 5000);
  httpServer.once('close', () => {
    clearInterval(heartbeat);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  });
  return httpServer;
}

if (require.main === module) {
  const list = name => (process.env[name] || '').split(',').map(item => item.trim()).filter(Boolean);
  const server = createServer({ operatorIds: list('YCLJ_ASSIST_OPERATOR_IDS'), operatorPasswords: process.env.YCLJ_ASSIST_OPERATOR_PASSWORDS,
    turnUrls: list('YCLJ_ASSIST_TURN_URLS'),
    turnSecret: process.env.YCLJ_ASSIST_TURN_SECRET });
  server.listen(Number(process.env.YCLJ_ASSIST_PORT || 18082), '127.0.0.1', () => {
    console.log(`[assist] listening on 127.0.0.1:${server.address().port}/assist`);
  });
}

module.exports = { createServer };
