const { contextBridge, ipcRenderer } = require('electron');

function makeSubscription(channel, handler) {
  const wrapped = (_event, payload) => handler(payload);
  ipcRenderer.on(channel, wrapped);
  return () => {
    ipcRenderer.removeListener(channel, wrapped);
  };
}

contextBridge.exposeInMainWorld('ycljClient', {
  getState: () => ipcRenderer.invoke('client:get-state'),
  start: (config) => ipcRenderer.invoke('client:start', config),
  disconnect: () => ipcRenderer.invoke('client:disconnect'),
  toggleScreenShare: () => ipcRenderer.invoke('client:toggle-screen-share'),
  openLog: () => ipcRenderer.invoke('client:open-log'),
  copyPin: () => ipcRenderer.invoke('client:copy-pin'),
  refreshPin: () => ipcRenderer.invoke('client:refresh-pin'),
  clearLogs: () => ipcRenderer.invoke('client:clear-logs'),
  onState: (handler) => makeSubscription('client:state', handler),
  onLog: (handler) => makeSubscription('client:log', handler),
  onUi: (handler) => makeSubscription('client:ui', handler)
});
