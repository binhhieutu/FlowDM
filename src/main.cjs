const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DownloadManager } = require('./core/download-manager.cjs');
const { createBridge } = require('./bridge/server.cjs');

const dataDir = process.env.FLOWDM_DATA_DIR || path.join(app.getPath('userData'), 'state');
if (process.env.FLOWDM_DATA_DIR) app.setPath('userData', path.dirname(dataDir));
const downloadDir = process.env.FLOWDM_DOWNLOAD_DIR || path.join(app.getPath('downloads'), 'FlowDM');
const uiFile = path.join(__dirname, 'ui', 'index.html');
let manager; let win; let bridge; let closing = false; let bridgeError = null;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(async () => {
    manager = new DownloadManager({ dataDir, downloadDir, maxConcurrent: 3 });
    await manager.init();
    bridge = await createBridge({ dataDir, onAdd: payload => manager.add(payload) }).catch(error => { bridgeError = error.message; return null; });
    installHandlers(); createWindow();
    manager.on('change', tasks => { if (win && !win.isDestroyed()) win.webContents.send('flow:changed', tasks); });
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
  }).catch(error => { dialog.showErrorBox('FlowDM không thể khởi động', error.message); app.exit(1); });
}

function createWindow() {
  win = new BrowserWindow({ width: 1220, height: 820, minWidth: 880, minHeight: 620, title: 'FlowDM', backgroundColor: '#f3f6fa', icon: path.join(__dirname, '../assets/icon.png'),
    webPreferences: { preload: path.join(__dirname, 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true } });
  Menu.setApplicationMenu(null);
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', event => event.preventDefault());
  win.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  win.webContents.session.setPermissionCheckHandler(() => false);
  win.loadFile(uiFile);
  win.on('closed', () => { win = null; });
}

function installHandlers() {
  const handle = (channel, action) => ipcMain.handle(`flow:${channel}`, async (event, input) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || event.senderFrame.url !== pathToFileURL(uiFile).href) {
      return { ok: false, error: 'Nguồn yêu cầu không hợp lệ.' };
    }
    try { return { ok: true, data: await action(input) }; }
    catch (error) { return { ok: false, error: error.message }; }
  });
  handle('info', () => ({ version: app.getVersion(), platform: process.platform, downloadDir, bridgeAvailable: !!bridge, bridgeError }));
  handle('list', () => manager.list());
  handle('add', input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Thông tin tải không hợp lệ.');
    const allowed = ['url', 'filename', 'connections', 'directory', 'startAt', 'speedLimit'];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('Tham số không được hỗ trợ.');
    return manager.add(input);
  });
  handle('action', async input => {
    if (!input || !['pause', 'resume', 'cancel', 'remove', 'reveal'].includes(input.action) || typeof input.id !== 'string') throw new Error('Thao tác không hợp lệ.');
    const task = manager.list().find(item => item.id === input.id);
    if (!task) throw new Error('Không tìm thấy tệp tải.');
    if (input.action === 'reveal') {
      if (task.status !== 'completed') throw new Error('Tệp chưa hoàn tất.');
      shell.showItemInFolder(task.path); return true;
    }
    return manager[input.action](input.id);
  });
  handle('chooseDirectory', async () => {
    const result = await dialog.showOpenDialog(win, { title: 'Chọn thư mục lưu', defaultPath: downloadDir, properties: ['openDirectory', 'createDirectory'] });
    return result.canceled ? null : result.filePaths[0];
  });
  handle('openFolder', async () => { const result = await shell.openPath(downloadDir); if (result) throw new Error(result); return true; });
}

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
app.on('before-quit', event => {
  if (closing || !manager) return;
  event.preventDefault(); closing = true;
  Promise.allSettled([manager.close(), bridge?.close()]).then(() => app.quit());
});
