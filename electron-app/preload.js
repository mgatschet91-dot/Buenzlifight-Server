const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('steam', {
  getUser:            ()         => ipcRenderer.invoke('steam:user'),
  getTicket:          ()         => ipcRenderer.invoke('steam:getTicket'),
  unlockAchievement:  (id)       => ipcRenderer.invoke('steam:achievement:unlock', id),
  setPresence:        (key, val) => ipcRenderer.invoke('steam:presence', key, val),
  openInviteDialog:   (connectStr) => ipcRenderer.invoke('steam:openInviteDialog', connectStr),
  getLanguage:        ()           => ipcRenderer.invoke('steam:language'),
});

contextBridge.exposeInMainWorld('electronStore', {
  getAll:       ()          => ipcRenderer.invoke('store:getAll'),
  get:          (key)       => ipcRenderer.invoke('store:get', key),
  set:          (key, val)  => ipcRenderer.invoke('store:set', key, val),
  remove:       (key)       => ipcRenderer.invoke('store:remove', key),
  bulkSave:     (data)      => ipcRenderer.invoke('store:bulkSave', data),
  getStorePath: ()          => ipcRenderer.invoke('store:getStorePath'),
});

contextBridge.exposeInMainWorld('electronWindow', {
  minimize:       ()              => ipcRenderer.send('win:minimize'),
  maximize:       ()              => ipcRenderer.send('win:maximize'),
  close:          ()              => ipcRenderer.send('win:close'),
  setFullscreen:  (flag)          => ipcRenderer.invoke('win:setFullscreen', flag),
  isMaximized:    ()              => ipcRenderer.invoke('win:isMaximized'),
  isFullscreen:   ()              => ipcRenderer.invoke('win:isFullscreen'),
  setResolution:  (w, h)          => ipcRenderer.invoke('win:setResolution', w, h),
  getDisplays:    ()              => ipcRenderer.invoke('win:getDisplays'),
});
