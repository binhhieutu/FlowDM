const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('flow', {
  info: () => ipcRenderer.invoke('flow:info'),
  list: () => ipcRenderer.invoke('flow:list'),
  add: input => ipcRenderer.invoke('flow:add', input),
  action: (id, action) => ipcRenderer.invoke('flow:action', { id, action }),
  chooseDirectory: () => ipcRenderer.invoke('flow:chooseDirectory'),
  openFolder: () => ipcRenderer.invoke('flow:openFolder'),
  browserInfo: () => ipcRenderer.invoke('flow:browserInfo'),
  browserExport: () => ipcRenderer.invoke('flow:browserExport'),
  browserConnect: input => ipcRenderer.invoke('flow:browserConnect', input),
  browserDisconnect: browser => ipcRenderer.invoke('flow:browserDisconnect', browser),
  onChange: callback => {
    const listener = (_event, tasks) => callback(tasks);
    ipcRenderer.on('flow:changed', listener);
    return () => ipcRenderer.removeListener('flow:changed', listener);
  }
});
