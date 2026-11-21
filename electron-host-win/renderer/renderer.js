const refs = Object.fromEntries([
  'service-status', 'address-list', 'service-message', 'port-value', 'toggle-service',
  'refresh-addresses', 'peer-count', 'peer-list', 'toast',
  'pair-form', 'pair-pin', 'pair-button', 'pair-message'
].map(id => [id, document.getElementById(id)]));

const statusLabels = { starting: '正在启动', running: '服务已开启', stopped: '服务已停止', error: '启动失败' };
const copyIcon = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"></rect><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"></path></svg>';
let currentState = null;
let toastTimer = null;

function showToast(text) {
  clearTimeout(toastTimer);
  refs.toast.textContent = text;
  toastTimer = setTimeout(() => { refs.toast.textContent = ''; }, 2500);
}

function copyButton(label, action) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'copy-button';
  button.title = label;
  button.setAttribute('aria-label', label);
  button.innerHTML = copyIcon;
  button.onclick = () => action().then(() => showToast('已复制')).catch(error => showToast(error.message));
  return button;
}

function renderAddresses(addresses) {
  refs['address-list'].replaceChildren();
  if (!addresses.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = '未找到可用的本机局域网地址。';
    refs['address-list'].appendChild(empty);
    return;
  }
  for (const [index, address] of addresses.entries()) {
    const row = document.createElement('div');
    row.className = 'address-row';
    const info = document.createElement('div');
    info.className = 'address-info';
    const name = document.createElement('div');
    name.className = 'adapter-name';
    name.textContent = `${address.name}${index === 0 ? ' · 推荐' : ''}`;
    const url = document.createElement('div');
    url.className = 'address-url';
    url.textContent = address.url;
    info.append(name, url);
    row.append(info, copyButton('复制连接地址', () => window.ycljHost.copyAddress(address.ip)));
    refs['address-list'].appendChild(row);
  }
}

function renderPeers(peers, serviceRunning, sessions) {
  refs['peer-count'].textContent = String(peers.length);
  refs['peer-list'].replaceChildren();
  if (!peers.length) {
    const empty = document.createElement('div');
    empty.className = 'empty peers-empty';
    empty.textContent = serviceRunning
      ? '暂时没有同事连接。请同事填写上方地址后点击连接。'
      : '服务开启后，这里会显示已连接的同事。';
    refs['peer-list'].appendChild(empty);
    return;
  }
  for (const peer of peers) {
    const row = document.createElement('div');
    row.className = 'peer-row';
    const top = document.createElement('div');
    top.className = 'peer-top';
    const name = document.createElement('strong');
    name.textContent = peer.name;
    const meta = document.createElement('span');
    meta.className = 'peer-meta';
    const time = new Date(peer.connectedAt).toLocaleTimeString('zh-CN', { hour12: false });
    meta.textContent = `连接时间 ${time}`;
    top.append(name, meta);
    const address = document.createElement('div');
    address.className = 'peer-address';
    const ipStatus = document.createElement('div');
    ipStatus.className = 'peer-ip-status';
    const ip = document.createElement('span');
    ip.className = 'peer-ip';
    ip.textContent = peer.ip;
    const badge = document.createElement('span');
    badge.className = 'peer-status';
    badge.textContent = peer.status;
    ipStatus.append(ip, badge);
    const controls = document.createElement('div');
    controls.className = 'peer-controls';
    controls.appendChild(copyButton('复制同事地址', () => window.ycljHost.copyPeerIp(peer.id)));
    if (sessions.some(session => session.sessionId === peer.sessionId)) {
      const disconnect = document.createElement('button');
      disconnect.type = 'button';
      disconnect.className = 'peer-disconnect';
      disconnect.textContent = '断开';
      disconnect.setAttribute('aria-label', `断开与${peer.name}的连接`);
      disconnect.onclick = () => window.ycljHost.disconnectPair(peer.id)
        .then(renderState).catch(error => showToast(error.message));
      controls.appendChild(disconnect);
    }
    address.append(ipStatus, controls);
    row.append(top, address);
    refs['peer-list'].appendChild(row);
  }
}

function updatePairButton() {
  const running = currentState && currentState.status === 'running';
  const connecting = currentState && currentState.session && currentState.session.status === 'connecting';
  refs['pair-button'].disabled = !running || connecting || !/^\d{6}$/.test(refs['pair-pin'].value);
}

function renderState(next) {
  if (!next) return;
  const previousSessionId = currentState && currentState.session && currentState.session.sessionId;
  currentState = next;
  refs['service-status'].textContent = statusLabels[next.status] || next.status;
  refs['service-status'].className = `status is-${next.status}`;
  refs['service-message'].textContent = next.message || '';
  refs['port-value'].textContent = String(next.port);
  refs['toggle-service'].textContent = next.status === 'stopped' || next.status === 'error' ? '启动服务' : '停止服务';
  refs['toggle-service'].disabled = next.status === 'starting';
  const pairing = next.session || { status: 'idle', message: '' };
  refs['pair-message'].textContent = pairing.status === 'paired' ? '' : (pairing.message || '');
  if (pairing.status === 'paired' && pairing.sessionId !== previousSessionId) refs['pair-pin'].value = '';
  updatePairButton();
  renderAddresses(next.addresses || []);
  renderPeers(next.peers || [], next.status === 'running', next.sessions || []);
}

refs['toggle-service'].onclick = () => {
  const action = currentState && (currentState.status === 'stopped' || currentState.status === 'error')
    ? window.ycljHost.start : window.ycljHost.stop;
  action().then(renderState).catch(error => showToast(error.message));
};
refs['refresh-addresses'].onclick = () => window.ycljHost.refreshAddresses().then(renderState).catch(error => showToast(error.message));
refs['pair-pin'].oninput = () => {
  refs['pair-pin'].value = refs['pair-pin'].value.replace(/\D/g, '').slice(0, 6);
  updatePairButton();
};
refs['pair-form'].onsubmit = event => {
  event.preventDefault();
  const pin = refs['pair-pin'].value;
  if (!/^\d{6}$/.test(pin)) {
    refs['pair-message'].textContent = '请输入六位数字验证码';
    return;
  }
  refs['pair-button'].disabled = true;
  window.ycljHost.pair(pin).then(result => {
    renderState(result.state);
    if (!result.ok) refs['pair-message'].textContent = result.error;
  }).catch(error => { refs['pair-message'].textContent = error.message; });
};
window.ycljHost.onState(renderState);
window.ycljHost.getState().then(renderState).catch(error => showToast(error.message));
