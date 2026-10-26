'use strict';
const { randomUUID } = require('node:crypto');
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
const fields = ['id','name','enabled','concurrency','speedLimit','schedule','onComplete','taskIds','lastCompletionKey','windowState'];
function object(value, allowed) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(k => !allowed.includes(k))) throw Error('Invalid queue fields');
}
function integer(value, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw Error('Invalid queue integer');
  return value;
}
function dateKey(value) {
  if (typeof value !== 'string' || !DATE.test(value) || new Date(value).toISOString().slice(0,10) !== value) throw Error('Invalid occurrence date');
  return value;
}
function normalizeQueue(input, { id, defaultConcurrency = 3 } = {}) {
  object(input, fields);
  const queue = { id: id ?? input.id ?? randomUUID(), name: 'Queue', enabled: true, concurrency: defaultConcurrency, speedLimit: 0, schedule: null, onComplete: 'none', taskIds: [], lastCompletionKey: null, windowState: {key:null,closedKeys:[]}, ...input };
  if (id !== undefined && input.id !== undefined && id !== input.id) throw Error('Queue identity mismatch');
  if (queue.id !== 'default' && !UUID.test(queue.id)) throw Error('Invalid queue ID');
  if (typeof queue.name !== 'string' || !queue.name.trim() || queue.name.length > 80 || typeof queue.enabled !== 'boolean') throw Error('Invalid queue name or enabled state');
  integer(queue.concurrency,1,16); integer(queue.speedLimit,0,Number.MAX_SAFE_INTEGER);
  if (!['none','notify','sleep','shutdown'].includes(queue.onComplete)) throw Error('Invalid completion action');
  if (!Array.isArray(queue.taskIds) || queue.taskIds.some(v=>typeof v !== 'string' || !v || v.length > 128) || new Set(queue.taskIds).size !== queue.taskIds.length) throw Error('Invalid queue task order');
  if (queue.lastCompletionKey !== null && (typeof queue.lastCompletionKey !== 'string' || queue.lastCompletionKey.length > 64)) throw Error('Invalid completion key');
  object(queue.windowState,['key','closedKeys']);
  if (queue.windowState.key !== null) dateKey(queue.windowState.key);
  if (!Array.isArray(queue.windowState.closedKeys) || queue.windowState.closedKeys.length > 1) throw Error('Invalid closed occurrence watermark');
  queue.windowState.closedKeys.forEach(dateKey);
  if (queue.schedule !== null) {
    object(queue.schedule,['timezone','weekdays','start','stop']);
    const s = queue.schedule;
    if (typeof s.timezone !== 'string' || !/^[A-Za-z][A-Za-z0-9_+./-]*$/.test(s.timezone)) throw Error('Invalid timezone');
    new Intl.DateTimeFormat('en-US',{timeZone:s.timezone});
    if (!Array.isArray(s.weekdays) || !s.weekdays.length || s.weekdays.some(d=>!Number.isInteger(d)||d<1||d>7) || new Set(s.weekdays).size !== s.weekdays.length) throw Error('Invalid weekdays');
    if (![s.start,s.stop].every(t=>typeof t === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(t)) || s.start === s.stop) throw Error('Invalid schedule times');
  }
  return structuredClone(queue);
}
function createDefaultQueue(concurrency = 3) { return normalizeQueue({id:'default',name:'Default',concurrency}); }
const slots = queue => queue.speedLimit > 0 ? Math.min(queue.concurrency,queue.speedLimit) : queue.concurrency;
function effectiveQueueRate(queue, task) {
  const rate = queue.speedLimit > 0 ? Math.floor(queue.speedLimit / slots(queue)) : 0;
  return rate && task.speedLimit ? Math.min(rate,task.speedLimit) : rate || task.speedLimit || 0;
}
const formatters = new Map();
const boundaries = new Map();
function localParts(instant, timezone) {
  if (!formatters.has(timezone)) formatters.set(timezone,new Intl.DateTimeFormat('en-CA',{timeZone:timezone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hourCycle:'h23'}));
  const p = Object.fromEntries(formatters.get(timezone).formatToParts(instant).map(x=>[x.type,x.value]));
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}
function shifted(date, days) { return new Date(Date.parse(`${date}T12:00:00Z`) + days*86400000).toISOString().slice(0,10); }
// Choose the first fold occurrence. A gap boundary advances to the first valid
// wall minute, avoiding a shifted start such as 03:30 for nonexistent 02:30.
function boundary(date, time, timezone) {
  const key = `${timezone}|${date}|${time}`;
  if (boundaries.has(key)) return boundaries.get(key);
  const target = `${date}T${time}`, naive = Date.parse(`${target}:00Z`), candidates = [];
  for (let hours=-36;hours<=36;hours+=6) {
    const sample = naive+hours*3600000;
    const offset = Date.parse(`${localParts(sample,timezone)}:00Z`)-Math.floor(sample/60000)*60000;
    const instant = naive-offset;
    if (localParts(instant,timezone) === target) candidates.push(instant);
  }
  let result = candidates.length ? Math.min(...candidates) : null;
  if (result === null) {
    for (let t=naive-18*3600000;t<=naive+18*3600000;t+=60000) {
      const local = localParts(t,timezone);
      if (local.slice(0,10) === date && local >= target) { result=t; break; }
    }
  }
  if (boundaries.size > 1024) boundaries.clear();
  boundaries.set(key,result); return result;
}
function windowFor(queue, now, fallback) {
  if (!queue.schedule) return {open:queue.enabled,state:queue.windowState,wakes:[]};
  const s=queue.schedule, timezone=s.timezone||fallback, today=localParts(now,timezone).slice(0,10), occurrences=[];
  for (let day=-8;day<=8;day++) {
    const key=shifted(today,day), weekday=new Date(`${key}T12:00:00Z`).getUTCDay()||7;
    if (!s.weekdays.includes(weekday)) continue;
    const start=boundary(key,s.start,timezone), stop=boundary(shifted(key,s.stop<s.start?1:0),s.stop,timezone);
    if (start !== null && stop !== null && stop>start) occurrences.push({key,start,stop});
  }
  const active=occurrences.find(o=>now>=o.start&&now<o.stop);
  let closed=queue.windowState.closedKeys[0]||null;
  for (const o of occurrences) if (o.stop<=now && (!closed||o.key>closed)) closed=o.key;
  const previous=queue.windowState.key;
  if (previous && previous!==active?.key && (!closed||previous>closed)) closed=previous;
  const open=!!active && (!closed||active.key>closed) && (!previous||active.key>=previous);
  const state={key:open?active.key:null,closedKeys:closed?[closed]:[]};
  const wakes=occurrences.filter(o=>(!closed||o.key>closed)).flatMap(o=>[o.start,o.stop]).filter(t=>t>now);
  return {open:queue.enabled&&open,state,wakes:queue.enabled?wakes:[]};
}
function host(task) { try { return new URL(task.url).host; } catch { return null; } }
function timestamp(value) { return typeof value === 'number' ? value : value instanceof Date ? value.getTime() : Date.parse(value); }
function evaluateQueues({queues,tasks,now,timezone='Asia/Saigon',maxConcurrent=3,maxPerHost=3}) {
  const instant = timestamp(now);
  if (!Number.isFinite(instant)) throw Error('Invalid scheduler time');
  const all=tasks instanceof Map?[...tasks.values()]:tasks, byId=new Map(all.map(t=>[t.id,t]));
  const runnableIds=[],pauseIds=[],queueTransitions=[],wakes=[],states=[];
  for (const queue of queues) {
    const window=windowFor(queue,instant,timezone); wakes.push(...window.wakes);
    if (JSON.stringify(queue.windowState)!==JSON.stringify(window.state)) queueTransitions.push({queueId:queue.id,windowState:window.state});
    const members=queue.taskIds.map(id=>byId.get(id)).filter(Boolean), running=members.filter(t=>t.status==='downloading');
    if (!window.open) pauseIds.push(...running.map(t=>t.id));
    const keep=window.open?running.slice(0,slots(queue)):[];
    if (window.open) pauseIds.push(...running.slice(slots(queue)).map(t=>t.id));
    const candidates=window.open?members.filter(t=>t.status==='queued'||(t.status==='paused'&&t.queueHold===true)).filter(t=>!t.requiresHeadersMissing):[];
    for (const task of candidates) if (task.startAt && timestamp(task.startAt)>instant) wakes.push(timestamp(task.startAt));
    states.push({queue,count:keep.length,candidates:candidates.filter(t=>!t.startAt||timestamp(t.startAt)<=instant)});
  }
  const paused=new Set(pauseIds), running=all.filter(t=>t.status==='downloading'&&!paused.has(t.id)), hosts=new Map();
  for (const task of running) hosts.set(host(task),(hosts.get(host(task))||0)+1);
  let count=running.length, progress=true;
  while(count<maxConcurrent&&progress) {
    progress=false;
    for (const state of states) {
      if (count>=maxConcurrent) break;
      if (state.count>=slots(state.queue)) continue;
      const index=state.candidates.findIndex(t=>host(t)!==null&&(hosts.get(host(t))||0)<maxPerHost);
      if (index<0) continue;
      const task=state.candidates.splice(index,1)[0], h=host(task);
      runnableIds.push(task.id); hosts.set(h,(hosts.get(h)||0)+1); state.count++; count++; progress=true;
    }
  }
  return {runnableIds,pauseIds:[...paused],nextWakeAt:wakes.length?new Date(Math.min(...wakes)).toISOString():null,queueTransitions};
}
module.exports={normalizeQueue,createDefaultQueue,effectiveQueueRate,evaluateQueues};
