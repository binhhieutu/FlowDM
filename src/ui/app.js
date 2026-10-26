'use strict';
const $ = id => document.getElementById(id);
const labels = { queued: 'Chờ tải', downloading: 'Đang tải', paused: 'Tạm dừng', completed: 'Hoàn tất', failed: 'Thất bại', canceled: 'Đã hủy' };
let tasks = []; let filter = 'all'; let selected = null; let defaultDirectory = ''; let toastTimer; let refreshingId = null;
let connectionTask = null; let connectionDraft = null; let changingConnections = false;
const bytes = number => {
  if (number === null || number === undefined) return 'Chưa rõ';
  if (number < 1024) return `${Math.max(0, number).toFixed(0)} B`;
  const unit = Math.min(Math.floor(Math.log(number) / Math.log(1024)), 4);
  return `${(number / 1024 ** unit).toFixed(unit > 1 ? 2 : 0)} ${['B', 'KiB', 'MiB', 'GiB', 'TiB'][unit]}`;
};
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 6000); }
async function action(id, op) {
  const result = await window.flow.action(id, op);
  if (!result.ok) toast(result.error);
  else if (op === 'remove' && id === selected) selected = null;
  await refresh();
}
async function refresh() { const result = await window.flow.list(); if (result.ok) { tasks = result.data; render(); } else toast(result.error); }
function element(tag, className, text) { const el = document.createElement(tag); if (className) el.className = className; if (text !== undefined) el.textContent = text; return el; }
function taskButton(task, op, name, className = '') {
  const button = element('button', className, op === 'remove' ? '×' : name); button.type = 'button'; button.setAttribute('aria-label', name); button.title = name;
  button.addEventListener('click', event => { event.stopPropagation(); action(task.id, op); }); return button;
}
function matches(task) {
  const groups = { all: true, active: ['downloading', 'queued'].includes(task.status), paused: task.status === 'paused', completed: task.status === 'completed', failed: (['failed', 'canceled'].includes(task.status) || task.postScan?.status === 'failed') };
  const query = $('search').value.toLocaleLowerCase();
  return groups[filter] && (!query || `${task.filename} ${task.url}`.toLocaleLowerCase().includes(query));
}
function render() {
  $('count-all').textContent = tasks.length;
  $('count-active').textContent = tasks.filter(t => ['downloading', 'queued'].includes(t.status)).length;
  $('count-paused').textContent = tasks.filter(t => t.status === 'paused').length;
  $('count-completed').textContent = tasks.filter(t => t.status === 'completed').length;
  $('count-failed').textContent = tasks.filter(t => ['failed', 'canceled'].includes(t.status) || t.postScan?.status === 'failed').length;
  $('transfer-speed').textContent = `${bytes(tasks.reduce((sum, t) => sum + (t.status === 'downloading' ? t.speed || 0 : 0), 0))}/s`;
  const active = tasks.filter(t => t.status === 'downloading').length;
  const queued = tasks.filter(t => t.status === 'queued').length;
  $('queue-summary').textContent = active || queued ? `${active} đang tải · ${queued} đang chờ` : 'Không có lượt tải đang chạy';
  const shown = window.queueUI?.filterTasks(tasks.filter(matches)) || tasks.filter(matches);
  $('visible-count').textContent = `${shown.length} tệp`;
  $('empty').hidden = shown.length > 0;
  $('tasks').replaceChildren(...shown.map(task => {
    const row = element('div', `task${selected === task.id ? ' chosen' : ''}`); row.dataset.task = task.id; row.tabIndex = 0;
    const select = () => { selected = task.id; render(); };
    row.addEventListener('click', select); row.addEventListener('keydown', e => { if (e.key === 'Enter' && e.target === row) select(); });
    const info = element('div', 'file-info');
    const ext = task.filename.includes('.') ? task.filename.split('.').pop().slice(0, 4).toUpperCase() : 'FILE';
    info.append(element('div', 'file-icon', ext));
    const copy = element('div', 'file-copy'); copy.append(element('span', 'file-name', task.filename));
    let host = ''; try { host = new URL(task.url).hostname; } catch { host = 'Địa chỉ không hợp lệ'; }
    copy.append(element('span', 'file-host', host));
    if (task.category) copy.append(element('small', 'scan-status', 'Nhóm: ' + task.category));
    if (task.postScan) copy.append(element('small', 'scan-status ' + task.postScan.status, ({ running: 'Đang quét sau tải', pending: 'Chờ quét', passed: 'Quét hoàn tất', failed: 'Quét lỗi — giữ nguyên tệp', skipped: 'Không quét' })[task.postScan.status] || 'Trạng thái quét chưa rõ'));
    info.append(copy);
    const progress = element('div', 'task-progress'); const meta = element('div', 'progress-meta');
    const pct = task.totalBytes ? Math.min(100, task.downloadedBytes / task.totalBytes * 100) : task.status === 'completed' ? 100 : 0;
    meta.append(element('span', `status ${task.status}`, labels[task.status] || task.status), element('span', '', task.totalBytes || task.status === 'completed' ? `${pct.toFixed(0)}%` : '—'));
    const meter = element('progress', 'meter'); meter.max = 100; meter.value = pct; meter.setAttribute('aria-label', `Tiến trình ${task.filename}`);
    let extra = `${bytes(task.downloadedBytes)} / ${bytes(task.totalBytes)}`;
    if (task.status === 'queued' && task.startAt && new Date(task.startAt) > new Date()) extra = new Date(task.startAt).toLocaleString('vi-VN');
    progress.append(meta, meter, element('div', 'size-meta', extra));
    const buttons = element('div', 'task-actions');
    if (['downloading', 'queued'].includes(task.status)) buttons.append(taskButton(task, 'pause', 'Tạm dừng'));
    if (['paused', 'failed'].includes(task.status)) buttons.append(taskButton(task, 'resume', task.status === 'failed' ? 'Thử lại' : 'Tiếp tục'));
    if (['paused', 'failed'].includes(task.status)) {
      const update = element('button', '', 'Cập nhật liên kết'); update.type = 'button';
      update.addEventListener('click', event => { event.stopPropagation(); refreshingId = task.id; $('refresh-url').value = ''; $('refresh-error').hidden = true; $('refresh-dialog').showModal(); $('refresh-url').focus(); });
      if (task.mediaType !== 'ftp') buttons.append(update);
      if (['direct', 'hls'].includes(task.mediaType || 'direct')) {
        const reconnect = element('button', '', 'Kết nối lại từ trình duyệt'); reconnect.type = 'button';
        reconnect.addEventListener('click', async event => {
          event.stopPropagation(); reconnect.disabled = true;
          try {
            const result = await window.flow.requestCredentials(task.id);
            if (!result.ok) throw Error(result.error);
            toast(`Mở trang ${result.data.origin}, bật quyền đăng nhập trong tiện ích FlowDM rồi chọn Tìm tác vụ cần kết nối lại. Yêu cầu có hiệu lực 2 phút.`);
          } catch (error) { toast(error.message); }
          finally { reconnect.disabled = false; }
        });
        buttons.append(reconnect);
      }
    }
    if (task.status === 'completed') buttons.append(taskButton(task, 'reveal', 'Mở vị trí'));
    if (['downloading', 'queued', 'paused'].includes(task.status)) buttons.append(taskButton(task, 'cancel', 'Hủy', 'danger'));
    else buttons.append(taskButton(task, 'remove', 'Xóa khỏi danh sách', 'remove'));
    window.settingsUI?.decorateTask(buttons, task);
    row.append(info, progress, buttons); window.queueUI?.decorateTask(row, task); return row;
  }));
  const task = tasks.find(t => t.id === selected);
  $('details').hidden = !task;
  if (task) {
    $('detail-name').textContent = task.filename; $('detail-state').textContent = labels[task.status];
    const streamed = ['hls', 'dash', 'youtube'].includes(task.mediaType); $('detail-path').textContent = task.path; $('detail-connections').textContent = streamed ? `${task.connections} kết nối tối đa · ${task.media?.completedSegments || 0}/${task.media?.segmentCount || '?'} đoạn ${task.mediaType.toUpperCase()}` : `${task.activeConnections || 0}/${task.connections} kết nối · ${task.segments.length} vùng`;
    if (connectionTask !== task.id) { connectionTask = task.id; connectionDraft = null; $('connection-change-error').hidden = true; }
    $('connection-controls').hidden = task.mediaType === 'ftp' || !['queued', 'downloading', 'paused', 'failed'].includes(task.status);
    const count = String(connectionDraft ?? task.connections);
    if (![...$('live-connections').options].some(option => option.value === count)) $('live-connections').add(new Option(`${count} kết nối`, count));
    const unavailable = streamed && task.status === 'downloading' && task.media?.canResize === false;
    $('live-connections').value = count; $('live-connections').disabled = changingConnections; $('apply-connections').disabled = changingConnections || unavailable;
    $('connection-hint').textContent = streamed ? task.mediaType === 'hls' ? 'Đổi số kết nối tại ranh giới đoạn, giữ lại các đoạn đã tải.' : unavailable ? 'Đang chuẩn bị hoặc định dạng hiện tại chưa hỗ trợ đổi kết nối an toàn; tác vụ vẫn tiếp tục.' : 'Đổi kết nối bằng tiếp tục từ checkpoint; giữ các đoạn hoàn tất.' : task.ranges ? 'Giữ tiến độ khi đổi số kết nối; tự chia phần còn thiếu.' : 'Số kết nối thực tế phụ thuộc máy chủ; có thể chỉ dùng một kết nối.';
    $('detail-hash').textContent = task.sha256 || 'Được tính khi tải hoàn tất';
    $('detail-error').hidden = !task.error && !streamed && task.postScan?.status !== 'failed'; $('detail-error').textContent = task.error || (task.postScan?.status === 'failed' ? 'Tải đã hoàn tất; quét sau tải thất bại. Tệp được giữ nguyên. ' + (task.postScan.error || '') : '') || (streamed ? `Giữ lại các đoạn đã tải khi tạm dừng hoặc đóng app. Đã dùng lại ${task.media?.reusedResources || 0} đoạn; đoạn còn dở có thể tải lại riêng.` : '');
    $('segments').replaceChildren(...(task.segments || []).map((segment, index) => {
      const meter = element('progress', 'meter'); meter.max = Math.max(1, segment.end - segment.start + 1); meter.value = segment.received || 0; meter.title = `Vùng ${index + 1}: ${bytes(segment.received)}`; return meter;
    }));
  }
}
function showAdd() { window.mediaChoice?.reset(); $('form-error').hidden = true; $('directory').value = defaultDirectory; $('directory').dataset.explicit = 'false'; if ($('allow-duplicate')) $('allow-duplicate').checked = false; if ($('ftp-user')) $('ftp-user').value = ''; if ($('ftp-password')) $('ftp-password').value = ''; window.settingsUI?.ftpHint(); $('add-dialog').showModal(); $('url').focus(); }
$('live-connections').addEventListener('change', () => { connectionDraft = Number($('live-connections').value); });
$('apply-connections').addEventListener('click', async () => {
  if (changingConnections) return;
  const id = selected; const count = Number($('live-connections').value);
  changingConnections = true; $('connection-change-error').hidden = true; render();
  try {
    const result = await window.flow.setConnections(id, count);
    if (!result.ok) throw Error(result.error);
    connectionDraft = null; toast(`Đã đặt tối đa ${count} kết nối và giữ tiến độ.`); await refresh();
  } catch (error) { $('connection-change-error').textContent = error.message; $('connection-change-error').hidden = false; }
  finally { changingConnections = false; render(); }
});
for (const id of ['refresh-close', 'refresh-cancel']) $(id).addEventListener('click', () => $('refresh-dialog').close());
$('refresh-form').addEventListener('submit', async event => {
  event.preventDefault(); if ($('refresh-submit').disabled) return;
  $('refresh-error').hidden = true; $('refresh-submit').disabled = true;
  try {
    const result = await window.flow.refreshSource(refreshingId, $('refresh-url').value.trim());
    if (!result.ok) throw Error(result.error);
    $('refresh-dialog').close(); toast('Đã cập nhật liên kết và giữ tiến độ. Nhấn Tiếp tục để tải.'); await refresh();
  } catch (error) { $('refresh-error').textContent = error.message; $('refresh-error').hidden = false; }
  finally { $('refresh-submit').disabled = false; }
});
$('add-button').addEventListener('click', showAdd); $('empty-add').addEventListener('click', showAdd);
for (const id of ['close-dialog', 'cancel-dialog']) $(id).addEventListener('click', () => $('add-dialog').close());
$('choose-directory').addEventListener('click', async () => { const result = await window.flow.chooseDirectory(); if (result.ok && result.data) { $('directory').value = result.data; $('directory').dataset.explicit = 'true'; } else if (!result.ok) toast(result.error); });
$('open-folder').addEventListener('click', async () => { const result = await window.flow.openFolder(); if (!result.ok) toast(result.error); });
$('search').addEventListener('input', render);
for (const button of document.querySelectorAll('[data-filter]')) button.addEventListener('click', () => {
  filter = button.dataset.filter; document.querySelector('[data-filter].selected')?.classList.remove('selected'); button.classList.add('selected');
  $('view-title').textContent = { all: 'Tất cả tệp', active: 'Đang tải', paused: 'Tạm dừng', completed: 'Hoàn tất', failed: 'Cần xử lý' }[filter]; render();
});
for (const [id, op, states] of [['pause-all', 'pause', ['downloading', 'queued']], ['resume-all', 'resume', ['paused']]]) $(id).addEventListener('click', async () => {
  for (const task of tasks.filter(t => states.includes(t.status))) { const result = await window.flow.action(task.id, op); if (!result.ok) toast(result.error); }
  await refresh();
});
$('add-form').addEventListener('submit', async event => {
  event.preventDefault(); if ($('add-form').dataset.busy === 'true') return;
  $('add-form').dataset.busy = 'true'; $('form-error').hidden = true; $('submit-download').disabled = true;
  try {
    const input = { url: $('url').value.trim(), queueId: $('add-queue')?.value || 'default', connections: Number($('connections').value), speedLimit: Number($('speed-limit').value) * 1024 };
    if ($('media-type').value !== 'auto') input.mediaType = $('media-type').value;
    if ($('filename').value.trim()) input.filename = $('filename').value.trim();
    if ($('directory').value && (!window.downloadPreferences?.settings.categories.enabled || $('directory').dataset.explicit === 'true')) input.directory = $('directory').value;
    if ($('allow-duplicate')?.checked) input.allowDuplicate = true;
    if (/^ftps?:/i.test(input.url) && $('ftp-user')?.value) input.ftpCredentials = { user: $('ftp-user').value, password: $('ftp-password').value };
    if ($('start-at').value) input.startAt = new Date($('start-at').value).toISOString();
    const media = window.mediaChoice?.optionsForUrl(input.url) || {};
    let result;
    if (media.playlist) {
      const batch = await window.flow.addPlaylist({ catalogId: media.catalogId, entryIds: media.entryIds, queueId: input.queueId, connections: input.connections, speedLimit: input.speedLimit, ...(input.directory ? { directory: input.directory } : {}) });
      if (!batch.ok) throw Error(batch.error);
      if (!batch.data.created.length) throw Error(batch.data.errors[0]?.error || 'Không tạo được tác vụ playlist.');
      toast(`Đã thêm ${batch.data.created.length} video${batch.data.errors.length ? `; ${batch.data.errors.length} mục lỗi` : ''}.`);
      result = { ok: true, data: batch.data.created[0] };
    } else result = await window.flow.add({ ...input, ...media });
    if (!result.ok) throw new Error(result.error);
    selected = result.data.id; filter = 'all'; document.querySelector('[data-filter="all"]').click();
    $('add-dialog').close(); if ($('ftp-password')) $('ftp-password').value = ''; $('url').value = ''; $('filename').value = ''; $('start-at').value = ''; await refresh();
  } catch (error) { $('form-error').textContent = error.message; $('form-error').hidden = false; }
  finally { delete $('add-form').dataset.busy; $('submit-download').disabled = false; }
});
window.flow.onChange(next => { tasks = next; if (!selected && tasks.length) selected = tasks[0].id; render(); });
$('update-button').addEventListener('click', async () => { try { const result = await window.flow.updateInfo(); if (!result.ok) throw Error(result.error); $('update-message').textContent = `Phiên bản hiện tại: ${result.data.currentVersion}. ${result.data.message}`; $('update-dialog').showModal(); } catch (error) { toast(error.message); } });
$('update-close').addEventListener('click', () => $('update-dialog').close());
$('update-github').addEventListener('click', async () => { try { const result = await window.flow.openReleasePage(); if (!result.ok) throw Error(result.error); } catch (error) { toast(error.message); } });
(async () => { const info = await window.flow.info(); if (info.ok) { defaultDirectory = info.data.downloadDir; $('app-version').textContent = `v${info.data.version} · ${info.data.platform}`; $('bridge-status').textContent = info.data.bridgeAvailable ? 'Sẵn sàng nhận liên kết từ trình duyệt' : 'Tích hợp trình duyệt chưa sẵn sàng'; if (info.data.mediaTools && !info.data.mediaTools.ready) $('media-type-hint').textContent = `HLS/DASH/YouTube chưa sẵn sàng: ${info.data.mediaTools.error || 'thiếu công cụ media'}`; } await refresh(); })().catch(error => toast(error.message));
