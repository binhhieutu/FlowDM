'use strict';
(() => {
  if (!window.flow.previewBatch || !document.getElementById('batch-button')) return;
  const el = id => document.getElementById(id);
  let entries = []; const selected = new Set(); let busy = null; let grabId = null; let grabbing = false; let viewEpoch = 0; let grabEpoch = 0; let pendingText = null;
  let queueRequest = 0; let pickerRequest = 0;
  const liveView = epoch => epoch === viewEpoch && el('batch-dialog').open;
  async function invoke(method, input) { const result = await window.flow[method](input); if (!result.ok) throw Error(result.error); return result.data; }
  function failure(error) { el('batch-error').textContent = error.message; el('batch-error').hidden = false; }
  function message(text) { el('batch-message').textContent = text; }
  function controls() {
    el('batch-count').textContent = `${entries.filter(entry => `${entry.text || ''} ${entry.url}`.toLocaleLowerCase().includes(el('batch-filter').value.toLocaleLowerCase())).length}/${entries.length} liên kết · ${selected.size} đã chọn`;
    el('batch-submit').disabled = busy || grabbing || !selected.size;
    el('batch-submit').textContent = `Tạo ${selected.size} lượt tải đã chọn`;
    el('batch-preview').disabled = busy || grabbing; el('grab-start').disabled = busy || grabbing;
    el('grab-cancel').disabled = !grabbing; el('batch-select-visible').disabled = grabbing || !entries.length;
  }
  function render() {
    const query = el('batch-filter').value.toLocaleLowerCase();
    const shown = entries.filter(entry => `${entry.text || ''} ${entry.url}`.toLocaleLowerCase().includes(query));
    el('batch-results').replaceChildren(...shown.map(entry => {
      const row = document.createElement('label'); row.className = 'batch-row'; row.dataset.batchUrl = entry.url;
      const check = document.createElement('input'); check.type = 'checkbox'; check.checked = selected.has(entry.url); check.disabled = busy || grabbing;
      check.addEventListener('change', () => { check.checked ? selected.add(entry.url) : selected.delete(entry.url); controls(); });
      const copy = document.createElement('span'); const url = document.createElement('span'); url.textContent = entry.url; copy.append(url);
      if (entry.text) { const caption = document.createElement('small'); caption.textContent = entry.text; copy.append(caption); }
      row.append(check, copy); return row;
    }));
    el('batch-count').textContent = `${shown.length}/${entries.length} liên kết · ${selected.size} đã chọn`; controls();
  }
  function replaceEntries(items) {
    entries = items.map(entry => typeof entry === 'string' ? { url: entry, text: '' } : entry);
    const available = new Set(entries.map(entry => entry.url)); for (const url of selected) if (!available.has(url)) selected.delete(url);
    render();
  }
  async function queues() {
    const epoch = viewEpoch; const request = ++queueRequest;
    try {
      const list = await invoke('listQueues');
      if (!liveView(epoch) || request !== queueRequest) return;
      const value = el('batch-queue').value;
      el('batch-queue').replaceChildren(...list.map(queue => new Option(queue.name, queue.id)));
      el('batch-queue').value = list.some(queue => queue.id === value) ? value : 'default';
    } catch (error) { if (liveView(epoch) && request === queueRequest) failure(error); }
  }
  async function chooseDirectory() {
    const epoch = viewEpoch; const request = ++pickerRequest;
    try {
      const directory = await invoke('chooseDirectory');
      if (liveView(epoch) && request === pickerRequest && directory) el('batch-directory').value = directory;
    } catch (error) { if (liveView(epoch) && request === pickerRequest) failure(error); }
  }
  async function open(text) {
    if (typeof text === 'string' && busy?.kind === 'submit') { pendingText = text; return; }
    const freshText = typeof text === 'string';
    const epoch = freshText || !el('batch-dialog').open ? ++viewEpoch : viewEpoch;
    if (freshText) {
      const previous = grabId; grabId = null; grabbing = false;
      const operation = { kind: 'stage' }; busy = operation; controls();
      try { if (previous) await invoke('cancelGrab', { id: previous }); }
      catch (error) { if (epoch === viewEpoch) failure(error); }
      finally { if (busy === operation) busy = null; }
      if (epoch !== viewEpoch) return;
      el('grab-status').textContent = 'Đã dừng · Danh sách mới từ trình duyệt';
    }
    el('batch-error').hidden = true;
    if (typeof text === 'string') { el('batch-text').value = text; selected.clear(); replaceEntries([]); message('Danh sách từ trình duyệt. Nhấn Xem trước để kiểm tra và chọn link.'); }
    if (!el('batch-dialog').open) el('batch-dialog').showModal();
    try { await queues(); if (liveView(epoch) && !el('batch-directory').value) { const info = await invoke('info'); if (liveView(epoch) && !el('batch-directory').value) el('batch-directory').value = info.downloadDir; } }
    catch (error) { if (epoch === viewEpoch) failure(error); }
    finally { controls(); }
  }
  async function cancelGrab() {
    if (!grabId || !grabbing) return;
    try { applyGrab(await invoke('cancelGrab', { id: grabId })); } catch (error) { failure(error); }
  }
  async function close() {
    viewEpoch++; const previous = grabId; grabId = null; grabbing = false;
    if (busy?.kind !== 'submit') busy = null;
    el('batch-dialog').close(); controls();
    if (previous) { try { await invoke('cancelGrab', { id: previous }); } catch (error) { toast(error.message); } }
  }
  async function preview() {
    if (busy || grabbing) return; const epoch = ++viewEpoch; const operation = { kind: 'preview' }; busy = operation; selected.clear(); replaceEntries([]); el('batch-error').hidden = true;
    try {
      const result = await invoke('previewBatch', { text: el('batch-text').value }); if (epoch !== viewEpoch) return; selected.clear(); replaceEntries(result.urls);
      const errors = result.errors || []; message(`${result.urls.length} liên kết hợp lệ · ${result.duplicates || 0} trùng · ${errors.length} dòng lỗi${errors.length ? ': ' + errors.slice(0, 5).map(item => `dòng ${item.line}: ${item.message}`).join('; ') : ''}. Chưa tạo lượt tải.`);
    } catch (error) { if (epoch === viewEpoch) failure(error); }
    finally { if (busy === operation) busy = null; render(); }
  }
  async function submit() {
    if (busy || grabbing || !selected.size) return; const operation = { kind: 'submit' }; busy = operation; render(); el('batch-error').hidden = true;
    try {
      const result = await invoke('submitBatch', { urls: entries.filter(entry => selected.has(entry.url)).map(entry => entry.url), queueId: el('batch-queue').value, directory: el('batch-directory').value, connections: Number(el('batch-connections').value) });
      const created = result.created || []; for (const task of created) selected.delete(task.url);
      message(`Đã tạo ${created.length} lượt tải · ${(result.errors || []).length} mục lỗi. Chỉ các link được chọn mới được gửi.`);
      if (result.errors?.length) failure(Error(result.errors.slice(0, 5).map(item => `Mục ${item.index + 1}: ${item.message}`).join('; ')));
      await refresh();
    } catch (error) { failure(error); }
    finally { if (busy === operation) busy = null; render(); if (pendingText !== null) { const text = pendingText; pendingText = null; void open(text); } }
  }
  function applyGrab(snapshot) {
    if (grabEpoch !== viewEpoch || !snapshot || (grabId && snapshot.id !== grabId) || (!grabId && !grabbing)) return;
    grabId = snapshot.id; grabbing = snapshot.status === 'running'; replaceEntries(snapshot.links || []);
    const state = { running: 'Đang lấy link', completed: 'Hoàn tất', cancelled: 'Đã dừng', failed: 'Lỗi' }[snapshot.status] || snapshot.status;
    el('grab-status').textContent = `${state} · ${snapshot.pages || 0} trang · ${(snapshot.links || []).length} liên kết · ${(snapshot.errors || []).length} lỗi`;
    if (snapshot.error) failure(Error(snapshot.error));
    message('Kết quả chỉ để xem trước. Chọn link và đích lưu rồi tạo lượt tải.'); render();
  }
  async function startGrab() {
    if (busy || grabbing) return; const epoch = ++viewEpoch; grabEpoch = epoch; grabbing = true; grabId = null; selected.clear(); replaceEntries([]); el('batch-error').hidden = true; el('grab-status').textContent = 'Đang lấy link';
    try {
      const result = await invoke('startGrab', { seed: el('grab-seed').value.trim(), maxDepth: Number(el('grab-depth').value), maxPages: Number(el('grab-pages').value) });
      if (epoch !== viewEpoch || !el('batch-dialog').open) { await invoke('cancelGrab', { id: result.id }); return; }
      grabId = result.id;
    } catch (error) { if (epoch === viewEpoch) { grabbing = false; failure(error); el('grab-status').textContent = 'Không bắt đầu được'; } }
    finally { render(); }
  }
  window.batchUI = { open };
  el('batch-button').addEventListener('click', () => open()); el('batch-close').addEventListener('click', close);
  el('batch-dialog').addEventListener('cancel', event => { event.preventDefault(); void close(); });
  el('batch-text').addEventListener('input', () => { if (busy?.kind !== 'submit' && !grabbing) { viewEpoch++; if (busy?.kind === 'preview') busy = null; selected.clear(); replaceEntries([]); message('Danh sách đã đổi. Nhấn Xem trước để kiểm tra lại.'); } });
  el('batch-preview').addEventListener('click', preview); el('batch-submit').addEventListener('click', submit); el('batch-filter').addEventListener('input', render);
  el('batch-select-visible').addEventListener('click', () => { const inputs = [...el('batch-results').querySelectorAll('input')]; const select = inputs.some(input => !input.checked); for (const input of inputs) { const url = input.closest('[data-batch-url]').dataset.batchUrl; select ? selected.add(url) : selected.delete(url); } render(); });
  el('batch-choose-directory').addEventListener('click', chooseDirectory);
  el('grab-start').addEventListener('click', startGrab); el('grab-cancel').addEventListener('click', cancelGrab);
  window.flow.onGrabChange?.(applyGrab); window.flow.onBatchPreview?.(payload => open(payload.text));
  window.flow.onQueueChange?.(() => { if (el('batch-dialog').open) void queues(); });
  controls();
})();
