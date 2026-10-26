const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('flow', {
  info: () => ipcRenderer.invoke('flow:info'),
  list: () => ipcRenderer.invoke('flow:list'),
  listQueues: () => ipcRenderer.invoke('flow:listQueues'),
  createQueue: input => ipcRenderer.invoke('flow:createQueue', input),
  updateQueue: (id, patch) => ipcRenderer.invoke('flow:updateQueue', { id, patch }),
  deleteQueue: id => ipcRenderer.invoke('flow:deleteQueue', { id }),
  pauseQueue: id => ipcRenderer.invoke('flow:pauseQueue', { id }),
  resumeQueue: id => ipcRenderer.invoke('flow:resumeQueue', { id }),
  reorderQueue: (id, taskIds) => ipcRenderer.invoke('flow:reorderQueue', { id, taskIds }),
  moveTask: (id, queueId, beforeTaskId) => ipcRenderer.invoke('flow:moveTask', { id, queueId, beforeTaskId }),
  powerInfo: () => ipcRenderer.invoke('flow:powerInfo'),
  cancelPower: () => ipcRenderer.invoke('flow:cancelPower'),
  onQueueChange: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('flow:queues', listener); return () => ipcRenderer.removeListener('flow:queues', listener); },
  onPowerChange: callback => { const listener = (_event, value) => callback(value); ipcRenderer.on('flow:power', listener); return () => ipcRenderer.removeListener('flow:power', listener); },
  add: input => ipcRenderer.invoke('flow:add', input),
  refreshSource: (id, url) => ipcRenderer.invoke('flow:refreshSource', { id, url }),
  setConnections: (id, connections) => ipcRenderer.invoke('flow:setConnections', { id, connections }),
  requestCredentials: id => ipcRenderer.invoke('flow:requestCredentials', { id }),
  inspectMedia: input => ipcRenderer.invoke('flow:inspectMedia', input),
  addPlaylist: input => ipcRenderer.invoke('flow:addPlaylist', input),
  action: (id, action) => ipcRenderer.invoke('flow:action', { id, action }),
  chooseDirectory: () => ipcRenderer.invoke('flow:chooseDirectory'),
  openFolder: () => ipcRenderer.invoke('flow:openFolder'),
  browserInfo: () => ipcRenderer.invoke('flow:browserInfo'),
  browserExport: browser => ipcRenderer.invoke('flow:browserExport', browser),
  browserConnect: input => ipcRenderer.invoke('flow:browserConnect', input),
  browserDisconnect: browser => ipcRenderer.invoke('flow:browserDisconnect', browser),
  onChange: callback => {
    const listener = (_event, tasks) => callback(tasks);
    ipcRenderer.on('flow:changed', listener);
    return () => ipcRenderer.removeListener('flow:changed', listener);
  }
});
