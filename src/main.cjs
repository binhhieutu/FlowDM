const { app, BrowserWindow, ipcMain, dialog, shell, Menu, Notification, powerMonitor, clipboard } = require('electron');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { DownloadManager } = require('./core/download-manager.cjs');
const { createBridge } = require('./bridge/server.cjs');
const { createBrowserSetup } = require('./browser/setup.cjs');
const { createBrowserAdmission } = require('./browser/admission.cjs');
const { createCredentialRebind } = require('./browser/credential-rebind.cjs');
const { mediaToolStatus } = require('./tools/media-tools.cjs');
const { SystemPowerAdapter } = require('./core/power-actions.cjs');
const { BatchService, selectedUrls } = require('./core/batch-service.cjs');
const { randomUUID } = require('node:crypto');
const { ClipboardWatcher } = require('./core/clipboard-policy.cjs');
const { assertProfileReady } = require('./tools/profile-snapshot.cjs');
const { manualUpdateInfo } = require('./tools/update-manifest.cjs');

const dataDir = process.env.FLOWDM_DATA_DIR || path.join(app.getPath('userData'), 'state');
if (process.env.FLOWDM_DATA_DIR) app.setPath('userData', path.dirname(dataDir));
const downloadDir = process.env.FLOWDM_DOWNLOAD_DIR || path.join(app.getPath('downloads'), 'FlowDM');
const uiFile = path.join(__dirname, 'ui', 'index.html');
let manager; let win; let bridge; let browserSetup; let credentialRebind; let closing = false; let bridgeError = null;
let batches; let stagedBatch = null;
let clipboardWatcher;

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', () => { if (win) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); } });
  app.whenReady().then(async () => {
    await assertProfileReady(dataDir);
    const powerAdapter = new SystemPowerAdapter({ notify: message => {
      if (!Notification.isSupported()) throw Error('Thông báo desktop chưa được hệ điều hành hỗ trợ.');
      new Notification(message).show();
    } });
    manager = new DownloadManager({ dataDir, downloadDir, maxConcurrent: 3, powerAdapter });
    await manager.init();
    clipboardWatcher = new ClipboardWatcher({ readText: () => clipboard.readText(), tasks: () => manager.list(), onSuggest: value => { if (win && !win.isDestroyed()) win.webContents.send('flow:clipboardSuggestion', value); } });
    clipboardWatcher.setEnabled(manager.preferenceInfo().settings.clipboard.enabled);
    manager.on('preferences', value => { clipboardWatcher.setEnabled(value.settings.clipboard.enabled); if (win && !win.isDestroyed()) win.webContents.send('flow:preferences', value); });
    batches = new BatchService(manager);
    batches.on('change', value => { if (win && !win.isDestroyed()) win.webContents.send('flow:grabChanged', value); });
    credentialRebind = createCredentialRebind(manager);
    browserSetup = createBrowserSetup({ appDir: app.getAppPath(), dataDir, userDataDir: app.getPath('userData'), executablePath: process.execPath });
    const admission = createBrowserAdmission(manager);
    bridge = await createBridge({ dataDir, onAdd: input => manager.network(() => admission(input)),
      onPreviewBatch: input => {
        const urls = selectedUrls(input.urls); manager.cancelPower();
        const previewId = randomUUID(); stagedBatch = { text: urls.join('\n') };
        if (!win || win.isDestroyed()) createWindow();
        if (!win.webContents.isLoadingMainFrame()) { win.webContents.send('flow:batchPreview', stagedBatch); stagedBatch = null; }
        win.show(); win.focus(); return { previewId, count: urls.length };
      },
      onCredentialRequests: input => ({ requests: credentialRebind.requests(input.origin) }),
      onRebindCredentials: (input, context) => manager.network(() => credentialRebind.prepare(input, context)),
      onCommitCredentials: (input, context) => credentialRebind.commit(input, context),
      onCancelCredentials: input => credentialRebind.cancel(input)
    }).catch(error => { bridgeError = error.message; return null; });
    installHandlers(); createWindow();
    manager.on('change', tasks => { if (win && !win.isDestroyed()) win.webContents.send('flow:changed', tasks); });
    manager.on('queues', queues => { if (win && !win.isDestroyed()) win.webContents.send('flow:queues', queues); });
    manager.on('power', value => { if (win && !win.isDestroyed()) win.webContents.send('flow:power', value); });
    for (const event of ['suspend', 'resume']) powerMonitor.on(event, () => { manager.cancelPower(); if (event === 'resume') manager._pump(); });
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
  win.webContents.on('did-finish-load', () => {
    if (stagedBatch) { win.webContents.send('flow:batchPreview', stagedBatch); stagedBatch = null; }
  });
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
  handle('info', async () => ({ version: app.getVersion(), platform: process.platform, downloadDir, bridgeAvailable: !!bridge, bridgeError, browser: await browserSetup.info(), mediaTools: await mediaToolStatus() }));
  handle('updateInfo', () => manualUpdateInfo(app.getVersion()));
  handle('openReleasePage', async () => { await shell.openExternal(manualUpdateInfo(app.getVersion()).releasePage); return true; });
  handle('browserInfo', () => browserSetup.info());
  handle('browserExport', async browser => { const directory = await browserSetup.prepareExtension(browser); const error = await shell.openPath(directory); if (error) throw new Error(error); return directory; });
  handle('browserConnect', input => browserSetup.connect(input || {}));
  handle('browserDisconnect', browser => browserSetup.disconnect(browser));
  handle('list', () => manager.list());
  handle('preferences', () => manager.preferenceInfo());
  handle('rescan', input => { if (!input || Object.keys(input).join(',') !== 'id' || typeof input.id !== 'string') throw Error('Invalid scan request'); return manager.rescan(input.id); });
  handle('configure', input => { if (Object.hasOwn(input || {}, 'proxy') && batches.listGrabs()[0]?.status === 'running') throw Error('Stop Site Grabber before changing proxy'); return manager.configure(input); });
  handle('bindFtp', input => { if (!input || Object.keys(input).some(k => !['id', 'credentials'].includes(k)) || typeof input.id !== 'string') throw Error('Invalid FTP binding'); return manager.bindFtpCredentials(input.id, input.credentials); });
  handle('allowDirect', input => { if (!input || Object.keys(input).join(',') !== 'id' || typeof input.id !== 'string') throw Error('Invalid route change'); return manager.allowDirect(input.id); });
  handle('chooseScanner', async () => { const result = await dialog.showOpenDialog(win, { title: 'Chọn executable antivirus', properties: ['openFile'], ...(process.platform === 'win32' ? { filters: [{ name: 'Executable', extensions: ['exe'] }] } : {}) }); return result.canceled ? null : result.filePaths[0]; });
  handle('previewBatch', input => batches.previewBatch(input));
  handle('submitBatch', input => batches.submitBatch(input));
  handle('startGrab', input => { manager.cancelPower(); return manager.network(() => batches.startGrab(input)); });
  handle('cancelGrab', input => batches.cancelGrab(input));
  handle('listGrabs', () => batches.listGrabs());
  const queueInput = (input, keys) => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !keys.includes(key)) || typeof input.id !== 'string') throw Error('Thông tin hàng đợi không hợp lệ.');
    return input;
  };
  handle('listQueues', () => manager.listQueues());
  handle('createQueue', input => manager.createQueue(input));
  handle('updateQueue', input => { queueInput(input, ['id', 'patch']); return manager.updateQueue(input.id, input.patch); });
  for (const method of ['deleteQueue', 'pauseQueue', 'resumeQueue']) handle(method, input => { queueInput(input, ['id']); return manager[method](input.id); });
  handle('reorderQueue', input => { queueInput(input, ['id', 'taskIds']); return manager.reorderQueue(input.id, input.taskIds); });
  handle('moveTask', input => { queueInput(input, ['id', 'queueId', 'beforeTaskId']); return manager.moveTask(input.id, input.queueId, input.beforeTaskId); });
  handle('powerInfo', () => manager.powerInfo());
  handle('cancelPower', () => manager.cancelPower());
  handle('requestCredentials', input => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).join(',') !== 'id' || typeof input.id !== 'string') throw Error('Thông tin kết nối lại không hợp lệ.');
    if (!bridge) throw Error('Cầu nối trình duyệt chưa sẵn sàng.');
    return credentialRebind.request(input.id);
  });
  handle('add', input => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('Thông tin tải không hợp lệ.');
    const allowed = ['url', 'filename', 'connections', 'directory', 'startAt', 'speedLimit', 'mediaType', 'selection', 'catalogId', 'queueId', 'ftpCredentials', 'allowDuplicate'];
    if (Object.keys(input).some(key => !allowed.includes(key))) throw new Error('Tham số không được hỗ trợ.');
    if (input.allowDuplicate !== undefined && typeof input.allowDuplicate !== 'boolean') throw Error('Invalid duplicate consent');
    return manager.add({ ...input, checkDuplicate: true });
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
  handle('refreshSource', input => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.id !== 'string' || typeof input.url !== 'string' || Object.keys(input).some(key => !['id', 'url'].includes(key))) throw Error('Thông tin cập nhật liên kết không hợp lệ.');
    return manager.network(() => manager.refreshSource(input.id, { url: input.url })).catch(error => { throw Error(manager._safeError(error)); });
  });
  handle('setConnections', input => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || typeof input.id !== 'string' || Object.keys(input).some(key => !['id', 'connections'].includes(key))) throw Error('Thông tin số kết nối không hợp lệ.');
    return manager.setConnections(input.id, input.connections).catch(error => { throw Error(manager._safeError(error)); });
  });
  handle('inspectMedia', input => {
    if (!input || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).some(key => !['url', 'mediaType'].includes(key))) throw Error('Thông tin kiểm tra media không hợp lệ.');
    return manager.inspectMedia(input).catch(error => { throw Error(manager._safeError(error)); });
  });
  handle('addPlaylist', input => manager.addPlaylist(input));
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
  clipboardWatcher?.close();
  Promise.allSettled([batches?.close(), credentialRebind?.close(), manager.close(), bridge?.close(), browserSetup?.waitForIdle()]).then(() => app.quit());
});
