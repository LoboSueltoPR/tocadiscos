const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('sf', {
  nowPlaying: () => ipcRenderer.invoke('now-playing'),
  cmd: (...args) => ipcRenderer.invoke('cmd', args),
  art: (url) => ipcRenderer.invoke('art', url),
  hide: () => ipcRenderer.send('hide'),
  move: (x, y) => ipcRenderer.send('move', x, y),
  interactive: (v) => ipcRenderer.send('interactive', v),
  togglePin: () => ipcRenderer.send('toggle-pin'),
  getPinned: () => ipcRenderer.invoke('get-pinned'),
  openSpotify: () => ipcRenderer.send('open-spotify'),
  onVisibility: (fn) => ipcRenderer.on('visibility', (_e, v) => fn(v)),
  onPinned: (fn) => ipcRenderer.on('pinned', (_e, v) => fn(v)),
});
