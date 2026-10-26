'use strict';
(() => {
  if (!window.flow.listQueues || !document.getElementById('queue-filter')) return;
  const byId = id => document.getElementById(id);
  let queues = []; let editing = null; let busy = false; let power = null;
  const current = () => queues.find(queue => queue.id === byId('queue-filter').value);
  const fail = error => { byId('queue-error').textContent = error.message; byId('queue-error').hidden = false; };
  async function invoke(method, ...args) {
    const result = await window.flow[method](...args);
    if (!result.ok) throw Error(result.error);
    return result.data;
  }
  function options(select, all) {
    const previous = select.value;
    select.replaceChildren(...(all ? [new Option('Tất cả hàng đợi', 'all')] : []), ...queues.map(queue => new Option(queue.name, queue.id)));
    select.value = [...select.options].some(option => option.value === previous) ? previous : all ? 'all' : 'default';
  }
  function controls() {
    const queue = current();
    byId('queue-edit').disabled = !queue; byId('queue-toggle').disabled = !queue;
    byId('queue-toggle').textContent = queue?.enabled ? 'Tạm dừng hàng đợi' : 'Tiếp tục hàng đợi';
    byId('queue-hint').textContent = queue ? `${queue.concurrency} lượt tối đa · ${queue.speedLimit ? `${Math.floor(queue.speedLimit / 1024)} KiB/s` : 'Không giới hạn tốc độ'}${queue.schedule ? ' · Có lịch' : ''}${queue.enabled ? '' : ' · Đã dừng'}${queue.error ? ' · ' + queue.error : ''}` : '';
  }
  async function refreshQueues() {
    try { queues = await invoke('listQueues'); options(byId('queue-filter'), true); options(byId('add-queue'), false); controls(); render(); }
    catch (error) { toast(error.message); }
  }
  function open(queue = null) {
    editing = queue?.id || null; byId('queue-error').hidden = true;
    byId('queue-dialog-title').textContent = queue ? 'Sửa hàng đợi' : 'Tạo hàng đợi';
    byId('queue-name').value = queue?.name || ''; byId('queue-enabled').checked = queue?.enabled ?? true;
    byId('queue-concurrency').value = queue?.concurrency || 3; byId('queue-speed').value = (queue?.speedLimit || 0) / 1024;
    byId('queue-schedule').checked = !!queue?.schedule; byId('queue-schedule-fields').hidden = !queue?.schedule;
    byId('queue-timezone').value = queue?.schedule?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
    byId('queue-start').value = queue?.schedule?.start || '22:00'; byId('queue-stop').value = queue?.schedule?.stop || '06:00';
    for (const check of byId('queue-weekdays').querySelectorAll('input')) check.checked = (queue?.schedule?.weekdays || [1, 2, 3, 4, 5, 6, 7]).includes(Number(check.value));
    byId('queue-completion').value = queue?.onComplete || 'none';
    byId('queue-delete').hidden = !queue || queue.id === 'default'; byId('queue-delete').disabled = !!queue?.taskIds?.length;
    byId('queue-dialog').showModal();
  }
  function queueInput() {
    const schedule = byId('queue-schedule').checked ? {
      timezone: byId('queue-timezone').value.trim(), weekdays: [...byId('queue-weekdays').querySelectorAll('input:checked')].map(input => Number(input.value)),
      start: byId('queue-start').value, stop: byId('queue-stop').value
    } : null;
    return { name: byId('queue-name').value.trim(), enabled: byId('queue-enabled').checked, concurrency: Number(byId('queue-concurrency').value), speedLimit: Number(byId('queue-speed').value) * 1024, schedule, onComplete: byId('queue-completion').value };
  }
  async function save(event) {
    event.preventDefault(); if (busy) return; busy = true; byId('queue-save').disabled = true; byId('queue-error').hidden = true;
    try {
      const data = queueInput(); const saved = editing ? await invoke('updateQueue', editing, data) : await invoke('createQueue', data);
      await refreshQueues(); byId('queue-filter').value = saved.id; controls(); render(); byId('queue-dialog').close();
    } catch (error) { fail(error); }
    finally { busy = false; byId('queue-save').disabled = false; }
  }
  function decorateTask(row, task) {
    const queue = queues.find(item => item.id === (task.queueId || 'default'));
    const actions = document.createElement('div'); actions.className = 'task-queue-actions';
    const select = document.createElement('select'); select.setAttribute('aria-label', `Hàng đợi của ${task.filename}`); select.dataset.queueMove = task.id;
    select.replaceChildren(...queues.map(item => new Option(item.name, item.id))); select.value = queue?.id || 'default';
    select.disabled = task.status === 'downloading';
    select.addEventListener('click', event => event.stopPropagation());
    select.addEventListener('change', async () => { try { await invoke('moveTask', task.id, select.value); await refreshQueues(); await refresh(); } catch (error) { toast(error.message); select.value = queue?.id || 'default'; } });
    actions.append(select);
    for (const [delta, label, glyph] of [[-1, 'Lên trong hàng đợi', '↑'], [1, 'Xuống trong hàng đợi', '↓']]) {
      const button = document.createElement('button'); button.type = 'button'; button.textContent = glyph; button.setAttribute('aria-label', label);
      const index = queue?.taskIds.indexOf(task.id) ?? -1; button.disabled = index < 0 || index + delta < 0 || index + delta >= (queue?.taskIds.length || 0);
      button.addEventListener('click', async event => {
        event.stopPropagation(); const ids = [...queue.taskIds]; [ids[index], ids[index + delta]] = [ids[index + delta], ids[index]];
        try { await invoke('reorderQueue', queue.id, ids); await refreshQueues(); } catch (error) { toast(error.message); }
      }); actions.append(button);
    }
    row.querySelector('.file-copy').append(actions);
  }
  function renderPower() {
    const pending = power?.status === 'countdown' ? power : power?.pending || power?.countdown;
    byId('power-panel').hidden = !pending;
    if (!pending) return;
    const remaining = pending.remainingSeconds ?? Math.max(0, Math.ceil(((pending.deadline || pending.executeAt || 0) - Date.now()) / 1000));
    byId('power-message').textContent = `${pending.queueName || 'Hàng đợi'} đã hoàn tất · ${pending.action === 'sleep' ? 'Ngủ' : 'Tắt máy'} sau ${remaining} giây`;
  }
  window.queueUI = {
    filterTasks(list) {
      const id = byId('queue-filter').value;
      if (id === 'all') return list;
      const queue = queues.find(item => item.id === id); const order = new Map((queue?.taskIds || []).map((taskId, index) => [taskId, index]));
      return list.filter(task => (task.queueId || 'default') === id).sort((a, b) => (order.get(a.id) ?? Infinity) - (order.get(b.id) ?? Infinity));
    }, decorateTask, refresh: refreshQueues
  };
  byId('queue-weekdays').append(...['T2', 'T3', 'T4', 'T5', 'T6', 'T7', 'CN'].map((day, index) => {
    const label = document.createElement('label'); label.className = 'check-label'; const check = document.createElement('input'); check.type = 'checkbox'; check.value = index + 1; check.checked = true; label.append(check, day); return label;
  }));
  byId('queue-form').addEventListener('submit', save);
  byId('queue-create').addEventListener('click', () => open()); byId('queue-edit').addEventListener('click', () => open(current()));
  byId('queue-close').addEventListener('click', () => byId('queue-dialog').close());
  byId('queue-filter').addEventListener('change', () => { controls(); render(); });
  byId('queue-schedule').addEventListener('change', () => { byId('queue-schedule-fields').hidden = !byId('queue-schedule').checked; });
  byId('queue-toggle').addEventListener('click', async () => { const queue = current(); if (!queue) return; try { await invoke(queue.enabled ? 'pauseQueue' : 'resumeQueue', queue.id); await refreshQueues(); await refresh(); } catch (error) { toast(error.message); } });
  byId('queue-delete').addEventListener('click', async () => { try { await invoke('deleteQueue', editing); byId('queue-dialog').close(); await refreshQueues(); } catch (error) { fail(error); } });
  byId('power-cancel').addEventListener('click', async () => { try { power = await invoke('cancelPower'); renderPower(); } catch (error) { toast(error.message); } });
  window.flow.onQueueChange?.(() => refreshQueues()); window.flow.onPowerChange?.(next => { power = next; renderPower(); });
  window.flow.powerInfo?.().then(result => { if (result.ok) { power = result.data; renderPower(); } }).catch(error => toast(error.message));
  setInterval(renderPower, 1000); refreshQueues();
})();
