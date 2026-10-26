'use strict';
(() => {
  const find = id => document.getElementById(id);
  const message = text => { find('browser-message').textContent = text; };
  async function refresh() {
    const result = await window.flow.browserInfo();
    if (!result.ok) throw new Error(result.error);
    const info = result.data;
    const firefox = find('browser-kind').value === 'firefox';
    find('browser-extension-path').textContent = firefox ? info.extensionPaths.firefox : info.extensionPath;
    const current = info.browsers.find(item => item.browser === find('browser-kind').value);
    find('browser-extension-id').readOnly = firefox;
    if (firefox) find('browser-extension-id').value = info.firefoxExtensionId;
    else if (find('browser-extension-id').value === info.firefoxExtensionId) find('browser-extension-id').value = '';
    if (current) find('browser-extension-id').value = current.extensionId;
    if (find('browser-load-instruction')) find('browser-load-instruction').textContent = firefox ? 'Mở about:debugging#/runtime/this-firefox, chọn Load Temporary Add-on và chọn manifest.json trong thư mục Firefox vừa xuất. Cần nạp lại sau khi đóng Firefox.' : 'Mở chrome://extensions hoặc edge://extensions, bật Developer mode và chọn Load unpacked / Tải tiện ích đã giải nén.';
    if (find('browser-id-instruction')) find('browser-id-instruction').textContent = firefox ? 'ID Firefox của FlowDM đã điền sẵn. Nhấn Kết nối và giữ ứng dụng đang mở.' : 'Sao chép ID tiện ích gồm 32 ký tự a–p, dán vào ô bên dưới rồi nhấn Kết nối.';
    message(current?.connected ? 'Cầu nối đã đăng ký. Mở FlowDM và bật tiện ích trong trình duyệt để sử dụng.' : 'Chưa đăng ký cầu nối cho trình duyệt này.');
  }
  async function perform(button, operation) {
    button.disabled = true;
    try { await operation(); } catch (error) { message(error.message); } finally { button.disabled = false; }
  }
  find('browser-button').addEventListener('click', () => { find('browser-dialog').showModal(); refresh().catch(error => message(error.message)); });
  find('browser-close').addEventListener('click', () => find('browser-dialog').close());
  find('browser-kind').addEventListener('change', () => {
    find('extension-settings-url').textContent = find('browser-kind').value === 'firefox' ? 'about:debugging#/runtime/this-firefox' : find('browser-kind').value === 'edge' ? 'edge://extensions' : 'chrome://extensions';
    refresh().catch(error => message(error.message));
  });
  find('browser-export').addEventListener('click', event => perform(event.target, async () => {
    const firefox = find('browser-kind').value === 'firefox';
    const result = await window.flow.browserExport(find('browser-kind').value); if (!result.ok) throw new Error(result.error);
    find('browser-extension-path').textContent = result.data; message(firefox ? 'Trong about:debugging, chọn Load Temporary Add-on và chọn manifest.json. Bản nạp tạm cần nạp lại sau khi đóng Firefox.' : 'Đã mở thư mục. Nạp tiện ích trong trình duyệt rồi sao chép ID vào ô bên dưới.');
  }));
  find('browser-connect').addEventListener('click', event => perform(event.target, async () => {
    const input = { browser: find('browser-kind').value, extensionId: find('browser-extension-id').value.trim() };
    if (input.browser !== 'firefox' && !/^[a-p]{32}$/.test(input.extensionId)) throw new Error('ID tiện ích phải gồm đúng 32 ký tự a–p.');
    message('Đang chuẩn bị cầu nối…'); const result = await window.flow.browserConnect(input); if (!result.ok) throw new Error(result.error);
    await refresh();
  }));
  find('browser-disconnect').addEventListener('click', event => perform(event.target, async () => {
    const result = await window.flow.browserDisconnect(find('browser-kind').value); if (!result.ok) throw new Error(result.error); await refresh();
  }));
})();
