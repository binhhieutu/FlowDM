'use strict';
(() => {
  if (!window.flow.preferences || !document.getElementById('settings-button')) return;
  const el = id => document.getElementById(id);
  let state; let epoch = 0; let suggestion = null; let ftpTask = null;
  async function invoke(method, ...args) { const result = await window.flow[method](...args); if (!result.ok) throw Error(result.error); return result.data; }
  function error(value) { el('settings-error').textContent = value.message; el('settings-error').hidden = false; }
  function setState(value) { state = value; window.downloadPreferences = value; render(); }
  function populate(value) {
    const settings = value.settings;
    el('settings-category').checked = settings.categories.enabled; el('settings-category-root').value = settings.categories.root;
    el('settings-scan').checked = settings.scanner.enabled; el('settings-scanner').value = settings.scanner.executable || '';
    el('settings-scanner-args').value = JSON.stringify(settings.scanner.args); el('settings-scan-timeout').value = settings.scanner.timeoutMs / 1000;
    el('settings-clipboard').checked = settings.clipboard.enabled; el('settings-duplicates').checked = settings.duplicateWarnings;
    el('settings-proxy-change').checked = false; el('settings-proxy-type').value = value.proxy?.type || 'none';
    el('settings-proxy-host').value = value.proxy?.host || ''; el('settings-proxy-port').value = value.proxy?.port || 8080;
    el('settings-proxy-user').value = ''; el('settings-proxy-password').value = '';
    el('settings-proxy-info').textContent = value.proxy ? `${value.proxy.type.toUpperCase()} ${value.proxy.host}:${value.proxy.port}${value.proxy.authenticated ? ' · Có xác thực, nhập lại nếu đổi cấu hình' : ''}` : 'Không có proxy trong phiên này.';
  }
  async function open() {
    const request = ++epoch; el('settings-error').hidden = true; el('settings-dialog').showModal();
    try { const value = await invoke('preferences'); if (request !== epoch || !el('settings-dialog').open) return; setState(value); populate(value); }
    catch (value) { if (request === epoch) error(value); }
  }
  async function save(event) {
    event.preventDefault(); if (el('settings-save').disabled) return;
    const request = epoch; el('settings-save').disabled = true; el('settings-error').hidden = true;
    try {
      const executable = el('settings-scanner').value.trim();
      const settings = {
        categories: { enabled: el('settings-category').checked, root: el('settings-category-root').value.trim() },
        scanner: { enabled: el('settings-scan').checked, executable: executable || null, args: JSON.parse(el('settings-scanner-args').value || '[]'), timeoutMs: Number(el('settings-scan-timeout').value) * 1000 },
        clipboard: { enabled: el('settings-clipboard').checked }, duplicateWarnings: el('settings-duplicates').checked
      };
      const input = { settings };
      if (el('settings-proxy-change').checked) {
        const type = el('settings-proxy-type').value;
        input.proxy = type === 'none' ? null : { type, host: el('settings-proxy-host').value.trim(), port: Number(el('settings-proxy-port').value) };
        if (input.proxy && (el('settings-proxy-user').value || el('settings-proxy-password').value)) { input.proxy.username = el('settings-proxy-user').value; input.proxy.password = el('settings-proxy-password').value; }
      }
      const value = await invoke('configure', input); setState(value);
      if (request === epoch) { el('settings-dialog').close(); el('settings-proxy-password').value = ''; toast('Đã lưu thiết lập. Proxy và mật khẩu chỉ giữ trong phiên.'); }
    } catch (value) { if (request === epoch) error(value); }
    finally { el('settings-save').disabled = false; }
  }
  function ftpHint() {
    const ftp = /^ftps?:/i.test(el('url').value.trim()) || el('media-type').value === 'ftp';
    el('ftp-options').hidden = !ftp;
    el('ftp-warning').textContent = /^ftps:/i.test(el('url').value.trim()) ? 'FTPS explicit xác minh chứng chỉ, mặc định cổng 21. Chỉ một kết nối thụ động.' : 'FTP truyền tài khoản và dữ liệu không mã hóa. Dùng FTPS nếu máy chủ hỗ trợ. Chỉ một kết nối thụ động.';
  }
  function bindFtp(task) {
    ftpTask = task.id; el('ftp-bind-user').value = ''; el('ftp-bind-password').value = ''; el('ftp-bind-error').hidden = true; el('ftp-bind-dialog').showModal();
  }
  async function rescan(task) {
    try { await invoke('rescan', task.id); toast('Đã quét lại tệp.'); await refresh(); }
    catch (value) { toast(value.message); }
  }
  function decorateTask(buttons, task) {
    if (task.status === 'completed' && task.postScan && task.postScan.status !== 'running') {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Quét lại';
      button.addEventListener('click', event => { event.stopPropagation(); button.disabled = true; rescan(task).finally(() => { button.disabled = false; }); }); buttons.append(button);
    }
    if (task.mediaType === 'ftp' && ['paused', 'failed'].includes(task.status)) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Cấp tài khoản FTP';
      button.addEventListener('click', event => { event.stopPropagation(); bindFtp(task); }); buttons.append(button);
    }
    if (task.requiresProxy && !state?.proxy && ['paused', 'failed', 'queued'].includes(task.status)) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = 'Cho phép trực tiếp';
      button.addEventListener('click', async event => { event.stopPropagation(); try { await invoke('allowDirect', task.id); toast('Đã cho phép đường truyền trực tiếp. Nhấn Tiếp tục để tải.'); await refresh(); } catch (value) { toast(value.message); } }); buttons.append(button);
    }
  }
  window.settingsUI = { decorateTask, bindFtp, ftpHint, rescan };
  el('settings-button').addEventListener('click', open); el('settings-form').addEventListener('submit', save);
  el('settings-close').addEventListener('click', () => { epoch++; el('settings-dialog').close(); el('settings-proxy-password').value = ''; });
  el('settings-dialog').addEventListener('cancel', () => { epoch++; el('settings-proxy-password').value = ''; });
  el('settings-category-choose').addEventListener('click', async () => { const request = epoch; try { const directory = await invoke('chooseDirectory'); if (directory && request === epoch && el('settings-dialog').open) el('settings-category-root').value = directory; } catch (value) { if (request === epoch) error(value); } });
  el('settings-scanner-choose').addEventListener('click', async () => { const request = epoch; try { const executable = await invoke('chooseScanner'); if (executable && request === epoch && el('settings-dialog').open) el('settings-scanner').value = executable; } catch (value) { if (request === epoch) error(value); } });
  for (const id of ['settings-proxy-type', 'settings-proxy-host', 'settings-proxy-port', 'settings-proxy-user', 'settings-proxy-password']) el(id).addEventListener('input', () => { el('settings-proxy-change').checked = true; });
  el('url').addEventListener('input', ftpHint); el('media-type').addEventListener('change', ftpHint);
  el('ftp-bind-close').addEventListener('click', () => { el('ftp-bind-dialog').close(); el('ftp-bind-password').value = ''; });
  el('ftp-bind-dialog').addEventListener('cancel', () => { el('ftp-bind-password').value = ''; });
  el('ftp-bind-form').addEventListener('submit', async event => {
    event.preventDefault(); el('ftp-bind-save').disabled = true; el('ftp-bind-error').hidden = true;
    try { await invoke('bindFtp', ftpTask, { user: el('ftp-bind-user').value, password: el('ftp-bind-password').value }); el('ftp-bind-dialog').close(); toast('Đã gắn tài khoản trong RAM. Nhấn Tiếp tục để tải.'); }
    catch (value) { el('ftp-bind-error').textContent = value.message; el('ftp-bind-error').hidden = false; }
    finally { el('ftp-bind-password').value = ''; el('ftp-bind-save').disabled = false; }
  });
  window.flow.onPreferences?.(setState);
  window.flow.onClipboardSuggestion?.(value => { suggestion = value; el('clipboard-message').textContent = `Liên kết trong clipboard: ${value.display}`; el('clipboard-banner').hidden = false; });
  el('clipboard-preview').addEventListener('click', () => { const value = suggestion; suggestion = null; el('clipboard-banner').hidden = true; if (value) { showAdd(); el('media-type').value = 'auto'; el('url').value = value.url; el('url').dispatchEvent(new Event('input')); } });
  el('clipboard-dismiss').addEventListener('click', () => { suggestion = null; el('clipboard-banner').hidden = true; });
  invoke('preferences').then(setState).catch(value => toast(value.message));
})();
