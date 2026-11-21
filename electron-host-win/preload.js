const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ycljHost', {
  getState: () => ipcRenderer.invoke('host:get-state'),
  start: () => ipcRenderer.invoke('host:start'),
  stop: () => ipcRenderer.invoke('host:stop'),
  refreshAddresses: () => ipcRenderer.invoke('host:refresh-addresses'),
  copyAddress: ip => ipcRenderer.invoke('host:copy-address', ip),
  copyPeerIp: id => ipcRenderer.invoke('host:copy-peer-ip', id),
  pair: pin => ipcRenderer.invoke('host:pair', pin),
  disconnectPair: id => ipcRenderer.invoke('host:disconnect-pair', id),
  onState: handler => {
    const listener = (_event, state) => handler(state);
    ipcRenderer.on('host:state', listener);
    return () => ipcRenderer.removeListener('host:state', listener);
  }
});
