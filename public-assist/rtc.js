const path = require('node:path');

function openRtc(options, onEvent) {
  const { BrowserWindow, MessageChannelMain } = require('electron');
  const window = new BrowserWindow({ show: false, width: 1024, height: 640, autoHideMenuBar: true, webPreferences: {
    preload: path.join(__dirname, 'rtc-preload.js'), sandbox: true,
    contextIsolation: true, backgroundThrottling: false, nodeIntegration: false,
    partition: options.operator ? undefined : 'yclj-assist-display'
  } });
  const { port1, port2 } = new MessageChannelMain();
  let closed = false;
  let transferred = false;
  let capturePermitted = false;
  if (!options.operator) {
    const contents = window.webContents;
    const allowed = (sender, permission) => capturePermitted && sender === contents && permission === 'display-capture';
    contents.session.setPermissionCheckHandler(allowed);
    contents.session.setPermissionRequestHandler((sender, permission, callback, { mediaTypes }) => {
      callback(allowed(sender, permission) && mediaTypes?.length === 1 && mediaTypes[0] === 'video');
    });
  }
  port1.on('message', ({ data }) => {
    if (closed) return;
    if (data.event === 'screen_visible') {
      if (options.operator && options.viewScreen) {
        if (data.data) window.showInactive();
        else window.hide();
      }
      return;
    }
    if (data.event === 'screen_capture') capturePermitted = false;
    onEvent(data);
  });
  port1.on('close', () => { if (!closed) onEvent({ event: 'fatal' }); });
  port1.start();
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', event => event.preventDefault());
  if (options.operator && options.viewScreen) {
    window.on('close', event => {
      event.preventDefault();
      window.minimize();
    });
  }
  window.webContents.on('render-process-gone', () => { if (!closed) onEvent({ event: 'fatal' }); });
  window.loadFile(path.join(__dirname, 'rtc.html')).then(() => {
    if (closed) return;
    window.webContents.postMessage('assist:rtc', options, [port2]);
    transferred = true;
  }).catch(() => { if (!closed) onEvent({ event: 'fatal' }); });
  return {
    send: data => {
      if (closed) return;
      if (data.op === 'screen_start') capturePermitted = true;
      if (data.op === 'screen_stop') capturePermitted = false;
      port1.postMessage(data);
    },
    close: () => {
      if (closed) return;
      closed = true;
      capturePermitted = false;
      port1.close();
      if (!transferred) port2.close();
      window.destroy();
    }
  };
}

module.exports = { openRtc };
