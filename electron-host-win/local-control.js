const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

function startLocalControl({ manifestPath, token, getStatus, getEvents, pair, send, run, disconnect, start, stop, shutdown }) {
  const server = http.createServer(async (request, response) => {
    const supplied = String(request.headers.authorization || '').replace(/^Bearer /, '');
    const left = Buffer.from(supplied);
    const right = Buffer.from(token);
    if (left.length !== right.length || !crypto.timingSafeEqual(left, right)) {
      response.writeHead(401).end('Unauthorized');
      return;
    }
    const url = new URL(request.url, 'http://127.0.0.1');
    const reply = (status, data) => {
      response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
      response.end(JSON.stringify(data));
    };
    try {
      if (request.method === 'GET' && url.pathname === '/status') return reply(200, getStatus());
      if (request.method === 'GET' && url.pathname === '/events') {
        return reply(200, getEvents(Number(url.searchParams.get('after') || 0)));
      }
      if (request.method !== 'POST') return reply(404, { error: 'Not found' });
      request.setEncoding('utf8');
      let raw = '';
      for await (const chunk of request) {
        raw += chunk;
        if (raw.length > 65536) throw new Error('请求过大');
      }
      const body = raw ? JSON.parse(raw) : {};
      if (url.pathname === '/pair') return reply(200, await pair(String(body.pin || '')));
      if (url.pathname === '/send') {
        send(body);
        return reply(200, { ok: true });
      }
      if (url.pathname === '/run') return reply(200, await run(body));
      if (url.pathname === '/disconnect') return reply(200, disconnect(body.peerId || body.sessionId));
      if (url.pathname === '/start') return reply(200, await start());
      if (url.pathname === '/stop') return reply(200, stop());
      if (url.pathname === '/shutdown') {
        reply(200, { ok: true });
        setImmediate(shutdown);
        return;
      }
      return reply(404, { error: 'Not found' });
    } catch (error) {
      reply(400, { error: error.message });
    }
  });
  server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
    fs.writeFileSync(manifestPath, JSON.stringify({ port: address.port, pid: process.pid }), { mode: 0o600 });
  });
  return {
    close() {
      server.close();
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        if (manifest.pid === process.pid) fs.unlinkSync(manifestPath);
      } catch { /* already removed */ }
    }
  };
}

module.exports = { startLocalControl };
