const { contextBridge, ipcRenderer } = require('electron');
// Keep the learning identity if another program occupies the saved local port.
const argument = name => process.argv.find(value => value.startsWith(name + '='))?.slice(name.length + 1);
if (location.origin === argument('--edupilot-origin') && !localStorage.getItem('eduowl_uid')) {
  localStorage.setItem('eduowl_uid', argument('--edupilot-uid'));
}
// Only the local recovery screen receives privileged desktop controls.
if (location.protocol === 'file:') contextBridge.exposeInMainWorld('edupilotDesktop', {
  state: () => ipcRenderer.invoke('desktop:state'),
  retry: () => ipcRenderer.invoke('desktop:retry'),
  logs: () => ipcRenderer.invoke('desktop:logs'),
  onState: callback => ipcRenderer.on('desktop:state', (_event, state) => callback(state)),
});
