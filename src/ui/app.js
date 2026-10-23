'use strict';
const $ = id => document.getElementById(id);
const labels = { queued: 'Chờ tải', downloading: 'Đang tải', paused: 'Tạm dừng', completed: 'Hoàn tất', failed: 'Thất bại', canceled: 'Đã hủy' };
let tasks = []; let filter = 'all'; let selected = null; let defaultDirectory = ''; let toastTimer;
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
  const groups = { all: true, active: ['downloading', 'queued'].includes(task.status), paused: task.status === 'paused', completed: task.status === 'completed', failed: ['failed', 'canceled'].includes(task.status) };
  const query = $('search').value.toLocaleLowerCase();
  return groups[filter] && (!query || `${task.filename} ${task.url}`.toLocaleLowerCase().includes(query));
}
function render() {
  $('count-all').textContent = tasks.length;
  $('count-active').textContent = tasks.filter(t => ['downloading', 'queued'].includes(t.status)).length;
  $('count-paused').textContent = tasks.filter(t => t.status === 'paused').length;
  $('count-completed').textContent = tasks.filter(t => t.status === 'completed').length;
  $('count-failed').textContent = tasks.filter(t => ['failed', 'canceled'].includes(t.status)).length;
  $('transfer-speed').textContent = `${bytes(tasks.reduce((sum, t) => sum + (t.status === 'downloading' ? t.speed || 0 : 0), 0))}/s`;
  const active = tasks.filter(t => t.status === 'downloading').length;
  const queued = tasks.filter(t => t.status === 'queued').length;
  $('queue-summary').textContent = active || queued ? `${active} đang tải · ${queued} đang chờ` : 'Không có lượt tải đang chạy';
  const shown = tasks.filter(matches);
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
    copy.append(element('span', 'file-host', host)); info.append(copy);
    const progress = element('div', 'task-progress'); const meta = element('div', 'progress-meta');
    const pct = task.totalBytes ? Math.min(100, task.downloadedBytes / task.totalBytes * 100) : task.status === 'completed' ? 100 : 0;
    meta.append(element('span', `status ${task.status}`, labels[task.status] || task.status), element('span', '', `${pct.toFixed(0)}%`));
    const meter = element('progress', 'meter'); meter.max = 100; meter.value = pct; meter.setAttribute('aria-label', `Tiến trình ${task.filename}`);
    let extra = `${bytes(task.downloadedBytes)} / ${bytes(task.totalBytes)}`;
    if (task.status === 'queued' && task.startAt && new Date(task.startAt) > new Date()) extra = new Date(task.startAt).toLocaleString('vi-VN');
    progress.append(meta, meter, element('div', 'size-meta', extra));
    const buttons = element('div', 'task-actions');
    if (['downloading', 'queued'].includes(task.status)) buttons.append(taskButton(task, 'pause', 'Tạm dừng'));
    if (['paused', 'failed'].includes(task.status)) buttons.append(taskButton(task, 'resume', task.status === 'failed' ? 'Thử lại' : 'Tiếp tục'));
    if (task.status === 'completed') buttons.append(taskButton(task, 'reveal', 'Mở vị trí'));
    if (['downloading', 'queued', 'paused'].includes(task.status)) buttons.append(taskButton(task, 'cancel', 'Hủy', 'danger'));
    else buttons.append(taskButton(task, 'remove', 'Xóa khỏi danh sách', 'remove'));
    row.append(info, progress, buttons); return row;
  }));
  const task = tasks.find(t => t.id === selected);
  $('details').hidden = !task;
  if (task) {
    $('detail-name').textContent = task.filename; $('detail-state').textContent = labels[task.status];
    $('detail-path').textContent = task.path; $('detail-connections').textContent = `${task.segments?.length || task.connections} kết nối`;
    $('detail-hash').textContent = task.sha256 || 'Được tính khi tải hoàn tất';
    $('detail-error').hidden = !task.error; $('detail-error').textContent = task.error || '';
    $('segments').replaceChildren(...(task.segments || []).map((segment, index) => {
      const meter = element('progress', 'meter'); meter.max = Math.max(1, segment.end - segment.start + 1); meter.value = segment.received || 0; meter.title = `Kết nối ${index + 1}: ${bytes(segment.received)}`; return meter;
    }));
  }
}
function showAdd() { $('form-error').hidden = true; $('directory').value = defaultDirectory; $('add-dialog').showModal(); $('url').focus(); }
$('add-button').addEventListener('click', showAdd); $('empty-add').addEventListener('click', showAdd);
for (const id of ['close-dialog', 'cancel-dialog']) $(id).addEventListener('click', () => $('add-dialog').close());
$('choose-directory').addEventListener('click', async () => { const result = await window.flow.chooseDirectory(); if (result.ok && result.data) $('directory').value = result.data; else if (!result.ok) toast(result.error); });
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
  event.preventDefault(); $('form-error').hidden = true; $('submit-download').disabled = true;
  try {
    const input = { url: $('url').value.trim(), connections: Number($('connections').value), speedLimit: Number($('speed-limit').value) * 1024 };
    if ($('filename').value.trim()) input.filename = $('filename').value.trim();
    if ($('directory').value) input.directory = $('directory').value;
    if ($('start-at').value) input.startAt = new Date($('start-at').value).toISOString();
    const result = await window.flow.add(input);
    if (!result.ok) throw new Error(result.error);
    selected = result.data.id; filter = 'all'; document.querySelector('[data-filter="all"]').click();
    $('add-dialog').close(); $('url').value = ''; $('filename').value = ''; $('start-at').value = ''; await refresh();
  } catch (error) { $('form-error').textContent = error.message; $('form-error').hidden = false; }
  finally { $('submit-download').disabled = false; }
});
window.flow.onChange(next => { tasks = next; if (!selected && tasks.length) selected = tasks[0].id; render(); });
(async () => { const info = await window.flow.info(); if (info.ok) { defaultDirectory = info.data.downloadDir; $('app-version').textContent = `v${info.data.version} · ${info.data.platform}`; $('bridge-status').textContent = info.data.bridgeAvailable ? 'Sẵn sàng nhận liên kết từ trình duyệt' : 'Tích hợp trình duyệt chưa sẵn sàng'; } await refresh(); })().catch(error => toast(error.message));
