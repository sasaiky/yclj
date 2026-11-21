const path = require('node:path');

function openRtc(options, onEvent) {
  const { BrowserWindow, MessageChannelMain } = require('electron');
  const window = new BrowserWindow({ show: false, webPreferences: {
    preload: path.join(__dirname, 'rtc-preload.js'), sandbox: true,
    contextIsolation: true, backgroundThrottling: false, nodeIntegration: false
  } });
  const { port1, port2 } = new MessageChannelMain();
  let closed = false;
  let transferred = false;
  port1.on('message', ({ data }) => { if (!closed) onEvent(data); });
  port1.on('close', () => { if (!closed) onEvent({ event: 'fatal' }); });
  port1.start();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  window.webContents.on('render-process-gone', () => { if (!closed) onEvent({ event: 'fatal' }); });
  window.loadFile(path.join(__dirname, 'rtc.html')).then(() => {
    if (closed) return;
    window.webContents.postMessage('assist:rtc', options, [port2]);
    transferred = true;
  }).catch(() => { if (!closed) onEvent({ event: 'fatal' }); });
  return {
    send: data => { if (!closed) port1.postMessage(data); },
    close: () => {
      if (closed) return;
      closed = true;
      port1.close();
      if (!transferred) port2.close();
      window.destroy();
    }
  };
}

module.exports = { openRtc };
