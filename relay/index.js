#!/usr/bin/env node

const WebSocket = require('ws');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');

const PORT = Number(process.env.RELAY_PORT || process.env.PORT || 8080);
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.YCLJ_ADMIN_TOKEN;
if (!ADMIN_TOKEN) throw new Error('ADMIN_TOKEN is required');
const HOST = process.env.RELAY_HOST || '127.0.0.1';
const AUTH_TIMEOUT_MS = Number(process.env.AUTH_TIMEOUT_MS || 10000);

const pendingClientsByPin = new Map();
const sessionsById = new Map();
const metaBySocket = new Map();

function sendJSON(ws, message) {
  if (ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(message));
  }
}

function safeClose(ws, code = 1008, reason = 'policy violation') {
  try {
    ws.close(code, reason);
  } catch {
    // no-op
  }
}

function isSocketOpen(ws) {
  return ws && ws.readyState === WebSocket.OPEN;
}

function createPin() {
  let pin = '';
  do {
    pin = String(crypto.randomInt(100000, 1000000));
  } while (pendingClientsByPin.has(pin));
  return pin;
}

function getPeer(session, ws) {
  if (session.operator === ws) {
    return session.client;
  }
  if (session.client === ws) {
    return session.operator;
  }
  return null;
}

function clearPendingForSocket(ws) {
  for (const [pin, record] of pendingClientsByPin.entries()) {
    if (record.ws === ws) {
      pendingClientsByPin.delete(pin);
    }
  }
}

function detachFromSession(ws, reason = 'peer_disconnected') {
  const meta = metaBySocket.get(ws);
  if (!meta || !meta.sessionId) {
    return;
  }

  const session = sessionsById.get(meta.sessionId);
  if (!session) {
    meta.sessionId = null;
    meta.activePin = null;
    return;
  }

  sessionsById.delete(meta.sessionId);
  const peer = getPeer(session, ws);
  const peerMeta = peer ? metaBySocket.get(peer) : null;

  if (peerMeta) {
    peerMeta.sessionId = null;
    peerMeta.activePin = null;
    if (peerMeta.role === 'client') {
      console.log(JSON.stringify({event:'client_unpaired',time:new Date().toISOString(),id:peerMeta.connectionId}));
    }
  }

  if (isSocketOpen(peer)) {
    sendJSON(peer, {
      type: 'session',
      action: reason,
      session_id: session.id,
      pin: session.pin
    });
  }

  meta.sessionId = null;
  meta.activePin = null;
}

function bindSession(operatorWs, clientWs, pin) {
  const sessionId = uuidv4();

  sessionsById.set(sessionId, {
    id: sessionId,
    pin,
    operator: operatorWs,
    client: clientWs
  });

  const operatorMeta = metaBySocket.get(operatorWs);
  const clientMeta = metaBySocket.get(clientWs);

  operatorMeta.sessionId = sessionId;
  operatorMeta.activePin = pin;

  clientMeta.sessionId = sessionId;
  clientMeta.activePin = pin;

  pendingClientsByPin.delete(pin);

  console.log(JSON.stringify({event:'client_paired',time:new Date().toISOString(),id:clientMeta.connectionId,sessionId}));

  sendJSON(operatorWs, {
    type: 'session',
    action: 'paired',
    session_id: sessionId,
    pin,
    peer: 'client'
  });

  sendJSON(clientWs, {
    type: 'session',
    action: 'paired',
    session_id: sessionId,
    pin,
    peer: 'operator'
  });
}

function handleAuthenticatedMessage(ws, message) {
  const meta = metaBySocket.get(ws);
  if (!meta) {
    return;
  }

  if (meta.role === 'operator' && message.type === 'session' && message.action === 'join') {
    if (meta.sessionId) {
      sendJSON(ws, {
        type: 'error',
        code: 'ALREADY_IN_SESSION',
        message: 'operator already in a session'
      });
      return;
    }

    const pin = String(message.pin || '');
    if (!/^\d{6}$/.test(pin)) {
      sendJSON(ws, {
        type: 'error',
        code: 'INVALID_PIN',
        message: 'pin must be 6 digits'
      });
      return;
    }

    const candidate = pendingClientsByPin.get(pin);
    if (!candidate || !isSocketOpen(candidate.ws)) {
      pendingClientsByPin.delete(pin);
      sendJSON(ws, {
        type: 'error',
        code: 'PIN_NOT_FOUND',
        message: 'client for this pin is offline'
      });
      return;
    }

    const clientMeta = metaBySocket.get(candidate.ws);
    if (!clientMeta || clientMeta.sessionId) {
      sendJSON(ws, {
        type: 'error',
        code: 'PIN_BUSY',
        message: 'client already paired'
      });
      return;
    }

    bindSession(ws, candidate.ws, pin);
    return;
  }

  if ((message.type === 'ui' || message.type === 'exec') && typeof message.session_id === 'string') {
    const session = sessionsById.get(message.session_id);
    if (!session) {
      sendJSON(ws, {
        type: 'error',
        code: 'SESSION_NOT_FOUND',
        message: 'session not found'
      });
      return;
    }

    const peer = getPeer(session, ws);
    if (!peer || !isSocketOpen(peer)) {
      sendJSON(ws, {
        type: 'error',
        code: 'PEER_OFFLINE',
        message: 'peer is offline'
      });
      return;
    }

    peer.send(JSON.stringify(message));
    return;
  }

  sendJSON(ws, {
    type: 'error',
    code: 'UNSUPPORTED_MESSAGE',
    message: 'unsupported message'
  });
}

function handleAuth(ws, message) {
  if (message.type !== 'auth' || typeof message.role !== 'string') {
    safeClose(ws, 1008, 'first message must be auth');
    return;
  }

  const role = message.role;
  if (role === 'operator') {
    const token = typeof message.token === 'string' ? message.token : message.admin_token;
    if (token !== ADMIN_TOKEN) {
      safeClose(ws, 1008, 'invalid admin token');
      return;
    }

    const meta = metaBySocket.get(ws);
    meta.authed = true;
    meta.role = 'operator';

    sendJSON(ws, {
      type: 'auth',
      status: 'ok',
      role: 'operator'
    });
    return;
  }

  if (role === 'client') {
    const pin = createPin();
    const meta = metaBySocket.get(ws);

    meta.authed = true;
    meta.role = 'client';
    meta.pin = pin;
    meta.clientName = String(message.client_name || 'unknown').slice(0, 120);
    console.log(JSON.stringify({event:'client_online', time:new Date().toISOString(), id:meta.connectionId, name:meta.clientName, ip:meta.ip}));

    pendingClientsByPin.set(pin, {
      ws,
      createdAt: Date.now()
    });

    sendJSON(ws, {
      type: 'auth',
      status: 'ok',
      role: 'client'
    });

    sendJSON(ws, {
      type: 'session',
      action: 'pin_generated',
      pin,
      ip: String(meta.ip || '').replace(/^::ffff:/, '')
    });
    return;
  }

  safeClose(ws, 1008, 'invalid role');
}

const wss = new WebSocket.Server({ port: PORT, host: HOST, maxPayload: 1048576 });

wss.on('connection', (ws, request) => {
  const ip = request.socket.remoteAddress;

  metaBySocket.set(ws, {
    connectionId: uuidv4(),
    authed: false,
    role: null,
    pin: null,
    sessionId: null,
    activePin: null,
    ip
  });

  const authTimer = setTimeout(() => {
    const meta = metaBySocket.get(ws);
    if (meta && !meta.authed) {
      safeClose(ws, 1008, 'auth timeout');
    }
  }, AUTH_TIMEOUT_MS);

  ws.on('message', (raw) => {
    let message = null;
    try {
      message = JSON.parse(raw.toString('utf8'));
    } catch {
      safeClose(ws, 1003, 'invalid json');
      return;
    }

    const meta = metaBySocket.get(ws);
    if (!meta) {
      return;
    }

    if (!meta.authed) {
      clearTimeout(authTimer);
      handleAuth(ws, message);
      return;
    }

    handleAuthenticatedMessage(ws, message);
  });

  ws.on('close', () => {
    const meta = metaBySocket.get(ws);
    if (meta && meta.role === 'client') console.log(JSON.stringify({event:'client_offline',time:new Date().toISOString(),id:meta.connectionId,name:meta.clientName,ip:meta.ip}));
    clearTimeout(authTimer);
    clearPendingForSocket(ws);
    detachFromSession(ws);
    metaBySocket.delete(ws);
  });

  ws.on('error', () => {
    // no-op
  });
});

process.on('SIGINT', () => {
  for (const socket of wss.clients) {
    safeClose(socket, 1001, 'relay shutting down');
  }
  wss.close(() => process.exit(0));
});

wss.on('listening', () => console.log(`[relay] listening on ${HOST}:${PORT}`));
console.log('[relay] operator token env: ADMIN_TOKEN or YCLJ_ADMIN_TOKEN');
