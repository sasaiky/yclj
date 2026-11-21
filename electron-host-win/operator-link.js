const WebSocket = require('ws');
const { createScriptRunner } = require('./script-runner');

function createOperatorLink({ port, token, onState, onEvent }) {
  let socket = null;
  let pairing = null;
  let timer = null;
  let session = { status: 'idle', pin: '', sessionId: '', message: '' };
  const scripts = createScriptRunner(sendMessage);

  function snapshot() { return { ...session }; }
  function update(next) {
    session = { ...session, ...next };
    onState(snapshot());
  }
  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }
  function settle(error) {
    if (!pairing) return;
    const current = pairing;
    pairing = null;
    clearTimer();
    if (error) current.reject(error);
    else current.resolve(snapshot());
  }
  function closeSocket() {
    scripts.disconnect();
    if (!socket) return;
    const old = socket;
    socket = null;
    old.removeAllListeners();
    try { old.close(); } catch { /* already closed */ }
  }
  function disconnect() {
    settle(new Error('连接已取消'));
    closeSocket();
    update({ status: 'idle', pin: '', sessionId: '', message: '' });
    return snapshot();
  }
  function pair(pin) {
    if (!/^\d{6}$/.test(pin)) return Promise.reject(new Error('请输入六位数字验证码'));
    if (session.status === 'connecting' || session.status === 'paired') {
      return Promise.reject(new Error('已有连接，请先断开'));
    }
    closeSocket();
    update({ status: 'connecting', pin, sessionId: '', message: '正在连接同事…' });
    const current = new WebSocket(`ws://127.0.0.1:${port}`);
    socket = current;
    return new Promise((resolve, reject) => {
      pairing = { resolve, reject };
      timer = setTimeout(() => {
        if (socket !== current) return;
        update({ status: 'error', message: '连接超时，请重试' });
        settle(new Error('连接超时，请重试'));
        closeSocket();
      }, 10000);
      current.on('open', () => current.send(JSON.stringify({ type: 'auth', role: 'operator', token })));
      current.on('message', raw => {
        let message;
        try { message = JSON.parse(raw.toString('utf8')); } catch { return; }
        if (message.type === 'auth' && message.status === 'ok') {
          current.send(JSON.stringify({ type: 'session', action: 'join', pin }));
          return;
        }
        if (message.type === 'session' && message.action === 'paired') {
          update({ status: 'paired', sessionId: message.session_id, message: '已连接，可以开始检查' });
          onEvent(message);
          settle();
          return;
        }
        if (message.type === 'session' && message.action === 'peer_disconnected') {
          onEvent(message);
          update({ status: 'idle', pin: '', sessionId: '', message: '同事已断开连接' });
          closeSocket();
          return;
        }
        if (message.type === 'error') {
          onEvent(message);
          if (pairing) {
            const error = new Error(message.code === 'PIN_NOT_FOUND' ? '验证码不正确或同事已离线' : (message.message || '连接失败'));
            update({ status: 'error', message: error.message });
            settle(error);
            closeSocket();
          }
          return;
        }
        if (session.status === 'paired') {
          scripts.handle(message);
          onEvent(message);
        }
      });
      current.on('close', () => {
        if (socket !== current) return;
        socket = null;
        scripts.disconnect();
        if (pairing) settle(new Error('连接已关闭'));
        update({ status: 'idle', pin: '', sessionId: '', message: '连接已断开' });
      });
      current.on('error', error => {
        if (socket !== current) return;
        if (pairing) {
          update({ status: 'error', message: error.message });
          settle(error);
        }
        closeSocket();
      });
    });
  }
  function sendMessage(message) {
    if (!socket || socket.readyState !== WebSocket.OPEN || session.status !== 'paired') {
      throw new Error('尚未连接同事');
    }
    if (!message || !['exec', 'ui'].includes(message.type)) throw new Error('不支持的操作');
    const payload = { ...message, session_id: session.sessionId };
    socket.send(JSON.stringify(payload));
  }
  function send(message) {
    if (scripts.isRunning() && message?.type === 'exec' && message.stream === 'stdin') {
      throw new Error('该同事的脚本正在执行，请等待结果');
    }
    sendMessage(message);
  }
  return { snapshot, pair, disconnect, send, run: scripts.start };
}

function createOperatorManager({ port, token, onState, onEvent }) {
  const links = new Map();
  let pending = null;

  function publish(session) {
    onState(session, [...links.values()].map(link => link.snapshot()));
  }

  async function pair(pin) {
    if (pending) throw new Error('正在连接同事，请稍候');
    if (links.size >= 20) throw new Error('最多同时连接 20 位同事，请先断开一位');
    let link;
    link = createOperatorLink({
      port,
      token,
      onEvent,
      onState: session => {
        for (const [id, active] of links) {
          if (active === link && (session.status !== 'paired' || id !== session.sessionId)) links.delete(id);
        }
        if (session.status === 'paired') links.set(session.sessionId, link);
        publish(session);
      }
    });
    pending = link;
    try { return await link.pair(pin); }
    finally { if (pending === link) pending = null; }
  }

  function disconnect(sessionId) {
    if (sessionId) {
      const link = links.get(sessionId);
      if (!link) throw new Error('该同事的连接已断开');
      return link.disconnect();
    }
    if (links.size > 1) throw new Error('请指定要断开的同事');
    if (links.size === 1) return links.values().next().value.disconnect();
    if (pending) return pending.disconnect();
    return { status: 'idle', pin: '', sessionId: '', message: '' };
  }

  function disconnectAll() {
    for (const link of new Set([...links.values(), pending].filter(Boolean))) link.disconnect();
  }

  function linkForSession(sessionId) {
    const link = sessionId ? links.get(sessionId) : links.size === 1 ? links.values().next().value : null;
    if (!link) throw new Error(links.size > 1 ? '请指定同事后再发送命令' : '尚未连接同事');
    return link;
  }

  return {
    pair, disconnect, disconnectAll,
    send: message => linkForSession(message.sessionId).send(message),
    run: (sessionId, script) => linkForSession(sessionId).run(script)
  };
}

module.exports = { createOperatorLink, createOperatorManager };
