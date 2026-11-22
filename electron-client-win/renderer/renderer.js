const refs = Object.fromEntries([
  'connection-chip', 'connection-route', 'pin-value', 'pin-feedback', 'btn-copy-pin', 'btn-refresh-pin',
  'log-box', 'btn-connect', 'btn-disconnect', 'relay-address', 'relay-url', 'mode-detailed',
  'mode-brief', 'mode-help', 'log-toast', 'log-toast-message', 'btn-open-log', 'assist-status', 'btn-share-screen'
].map(id => [id, document.getElementById(id)]));
let addressInitialized = false;
let feedbackTimer = null;
let toastTimer = null;
let lastLogNoticeId = null;
let displayMode = 'brief';
let allLogs = [];
let rowTimer = null;
const liveRows = [];
const MAX_VISIBLE_ROWS = 400;
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
const labels = { idle: '开始', connecting: '正在连接', connected: '等待连接', paired: '已连接', disconnected: '开始' };
function showPinFeedback(message, warning = false) {
  clearTimeout(feedbackTimer);
  refs['pin-feedback'].classList.toggle('is-warning', warning);
  refs['pin-feedback'].textContent = message;
  feedbackTimer = setTimeout(() => { refs['pin-feedback'].textContent = ''; }, 2500);
}
function showLogNotice(notice) {
  const toast = refs['log-toast'];
  if (!notice) {
    clearTimeout(toastTimer);
    toast.hidden = true;
    return;
  }
  if (notice.id === lastLogNoticeId) return;

  clearTimeout(toastTimer);
  lastLogNoticeId = notice.id;
  toast.classList.toggle('is-warning', Boolean(notice.warning));
  refs['log-toast-message'].textContent = notice.message;
  refs['btn-open-log'].hidden = !notice.path;
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, 8000);
}

function isAtBottom() {
  const box = refs['log-box'];
  return box.scrollHeight - box.clientHeight - box.scrollTop <= 4;
}
function isVisible(entry) {
  return displayMode === 'detailed' || entry.kind === 'terminal-command';
}

function getLogRows(entry) {
  const command = entry.kind === 'terminal-command';
  const value = String(entry.text || '');
  const tag = command ? '[cmd]' : !entry.detail && value.match(/^\[[^\]\r\n]{1,48}\]/)?.[0];
  const message = tag && !command ? value.slice(tag.length).trimStart() : value;
  const lines = (command ? message.trimEnd() : message.replace(/\n$/, '')).split('\n');
  const timestamp = new Date(entry.ts).toLocaleTimeString('zh-CN', { hour12: false });
  return lines.map((text, index) => ({
    kind: entry.kind || 'info',
    timestamp: index === 0 ? timestamp : '',
    tag: index === 0 ? tag : '',
    text,
    cursor: command && index === lines.length - 1
  }));
}

function addRow(row, animate = false) {
  const line = document.createElement('div');
  line.className = 'log-line ' + row.kind;
  if (animate) line.classList.add('is-new');
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = row.timestamp;
  const text = document.createElement('span');
  text.className = 'text';
  if (row.tag) {
    const label = document.createElement('span');
    label.className = 'log-tag';
    label.textContent = displayMode === 'brief' ? '>' : row.tag;
    text.append(label, ' ');
  }
  text.append(row.text);
  if (row.cursor) {
    const cursor = document.createElement('span');
    cursor.className = 'log-cursor';
    cursor.setAttribute('aria-hidden', 'true');
    cursor.textContent = '_';
    text.append(cursor);
  }
  line.append(time, text);
  refs['log-box'].appendChild(line);
}
function renderLogs(forceBottom = false) {
  clearTimeout(rowTimer);
  rowTimer = null;
  liveRows.length = 0;
  const box = refs['log-box'];
  const follow = forceBottom || isAtBottom();
  const oldTop = box.scrollTop;
  const rows = [];
  for (let index = allLogs.length - 1; index >= 0 && rows.length < MAX_VISIBLE_ROWS; index--) {
    const entry = allLogs[index];
    if (isVisible(entry)) rows.unshift(...getLogRows(entry).slice(-(MAX_VISIBLE_ROWS - rows.length)));
  }
  box.replaceChildren();
  rows.forEach(row => addRow(row));
  box.scrollTop = follow ? box.scrollHeight : oldTop;
}

function appendLiveRows(rows, animate) {
  const box = refs['log-box'];
  const follow = isAtBottom();
  let oldTop = box.scrollTop;
  rows.forEach(row => addRow(row, animate && follow));
  while (box.childNodes.length > MAX_VISIBLE_ROWS) {
    const first = box.firstChild;
    oldTop -= first.getBoundingClientRect().height;
    first.remove();
  }
  box.scrollTop = follow ? box.scrollHeight : Math.max(0, oldTop);
}

function drainLiveRows() {
  rowTimer = null;
  if (!liveRows.length) return;
  const batchSize = reducedMotion.matches ? liveRows.length : Math.max(1, Math.ceil(liveRows.length / 28));
  appendLiveRows(liveRows.splice(0, batchSize), !reducedMotion.matches);
  if (!reducedMotion.matches) rowTimer = setTimeout(drainLiveRows, 42);
}

function receiveLog(entry) {
  if (displayMode === 'brief' && entry.kind === 'error') showPinFeedback(entry.text, true);
  allLogs.push(entry);
  if (allLogs.length > 300) {
    const oldestDetail = allLogs.findIndex(item => item.detail);
    allLogs.splice(oldestDetail === -1 ? 0 : oldestDetail, 1);
  }
  if (!isVisible(entry)) return;
  liveRows.push(...getLogRows(entry).slice(-MAX_VISIBLE_ROWS));
  if (liveRows.length > MAX_VISIBLE_ROWS) liveRows.splice(0, liveRows.length - MAX_VISIBLE_ROWS);
  if (rowTimer === null) drainLiveRows();
}
function setDisplayMode(mode) {
  displayMode = mode;
  refs['log-box'].dataset.mode = mode;
  refs['mode-detailed'].checked = mode === 'detailed';
  refs['mode-brief'].checked = mode === 'brief';
  refs['mode-help'].textContent = mode === 'detailed'
    ? '命令、返回与连接记录'
    : '仅显示命令';
  renderLogs(true);
}
function applyState(next) {
  if (!next) return;
  const connection = next.connection || 'idle';
  const active = ['connecting','connected','paired'].includes(connection);
  const startButton = refs['btn-connect'];
  refs['connection-chip'].textContent = labels[connection] || labels.idle;
  startButton.dataset.connection = connection;
  startButton.disabled = active;
  refs['btn-disconnect'].disabled = !active;
  const shareButton = refs['btn-share-screen'];
  shareButton.hidden = !next.screenShareAvailable;
  shareButton.disabled = Boolean(next.screenShareBusy);
  shareButton.textContent = next.screenSharing ? '停止共享' : next.screenInputAvailable ? '共享屏幕并允许控制' : '共享屏幕';
  shareButton.title = next.screenInputAvailable ? '共享主屏幕并允许当前协助人使用键盘和鼠标' : '将主屏幕共享给当前协助人';
  shareButton.setAttribute('aria-pressed', String(Boolean(next.screenSharing)));
  refs['relay-address'].hidden = !next.addressEditable;
  if (!addressInitialized && next.relayUrl) {
    refs['relay-url'].value = next.relayUrl;
    addressInitialized = true;
  }
  refs['relay-url'].disabled = active;
  const route = { direct: '直连', relay: '中继', recovering: '正在恢复连接' }[next.route] || '';
  refs['pin-value'].textContent = active && next.pin ? next.pin : '------';
  if (refs['connection-route'].textContent !== route) refs['connection-route'].textContent = route;
  const hasPin = /^\d{6}$/.test(next.pin || '');
  refs['btn-copy-pin'].disabled = next.pinConsumed || !hasPin || !['connected', 'paired'].includes(connection);
  refs['btn-refresh-pin'].disabled = connection !== 'connected' || !next.authed || !hasPin;
  refs['assist-status'].textContent = next.assistStatus || '';
  showLogNotice(next.logNotice);
  if (Array.isArray(next.logs)) {
    allLogs = next.logs;
    renderLogs();
  }
}
function reportError(error) {
  receiveLog({ ts: new Date().toISOString(), kind: 'error', text: `[client] ${error.message}` });
}
refs['mode-detailed'].onchange = () => setDisplayMode('detailed');
refs['mode-brief'].onchange = () => setDisplayMode('brief');
refs['btn-copy-pin'].onclick = () => window.ycljClient.copyPin()
  .then(result => showPinFeedback(result.copiedAddress ? '验证码和连接地址已复制' : result.copiedIp ? '验证码和 IP 已复制' : '验证码已复制'))
  .catch(error => { reportError(error); showPinFeedback('复制失败'); });
refs['btn-refresh-pin'].onclick = () => {
  refs['btn-refresh-pin'].disabled = true;
  window.ycljClient.refreshPin()
    .then(next => { applyState(next); showPinFeedback('正在刷新配对码…'); })
    .catch(error => { reportError(error); showPinFeedback('刷新失败'); window.ycljClient.getState().then(applyState).catch(reportError); });
};
refs['btn-connect'].onclick = () => {
  const config = {};
  if (!refs['relay-address'].hidden) {
    config.relayUrl = refs['relay-url'].value.trim();
    try {
      const parsed = new URL(config.relayUrl);
      if (!['ws:', 'wss:'].includes(parsed.protocol)) throw new Error();
    } catch {
      reportError(new Error('请输入有效的 ws:// 或 wss:// 连接地址'));
      return;
    }
  }
  window.ycljClient.start(config).then(applyState).catch(error => {
    reportError(error);
    showPinFeedback(error.message, true);
  });
};
refs['btn-disconnect'].onclick = () => window.ycljClient.disconnect().then(applyState).catch(reportError);
refs['btn-share-screen'].onclick = event => {
  if (event.isTrusted) window.ycljClient.toggleScreenShare().then(applyState).catch(reportError);
};
refs['btn-open-log'].onclick = () => window.ycljClient.openLog().catch(error => {
  reportError(error);
  refs['log-toast-message'].textContent = '无法打开日志';
});
window.ycljClient.onState(applyState);
window.ycljClient.onLog(receiveLog);
window.ycljClient.getState().then(applyState).catch(reportError);
