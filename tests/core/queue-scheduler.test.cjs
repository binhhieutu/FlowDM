'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
let api;
try { api = require('../../src/core/queue-scheduler.cjs'); } catch (e) { if (e.code !== 'MODULE_NOT_FOUND') throw e; }
const id = '11111111-1111-4111-8111-111111111111';
const q = overrides => ({ ...api.createDefaultQueue(), ...overrides });
const task = (id, overrides = {}) => ({ id, status: 'queued', url: 'https://example.com/file', speedLimit: 0, ...overrides });
const evaluate = (queue, tasks, now, options = {}) => api.evaluateQueues({ queues: [queue], tasks, now, ...options });
const schedule = (overrides = {}) => ({ timezone: 'Asia/Saigon', weekdays: [1,2,3,4,5,6,7], start: '09:00', stop: '10:00', ...overrides });
test('scheduler exports its pure interface', () => { assert.equal(typeof api?.evaluateQueues, 'function'); });
test('canonical validation rejects malformed queues', () => {
  const queue = api.createDefaultQueue(4); assert.deepEqual(api.normalizeQueue(queue), queue);
  for (const patch of [{ concurrency: 0 }, { concurrency: 17 }, { enabled: 'yes' }, { speedLimit: -1 }, { name: 'x'.repeat(81) }, { id: 'bad' }, { surprise: 1 }, { schedule: schedule({ start:'10:00' }) }, { schedule: schedule({ weekdays: [1,1] }) }, { schedule: schedule({ timezone: 'Wrong/Place' }) }, { schedule: schedule({ start: '24:00' }) }]) assert.throws(() => api.normalizeQueue({ ...queue, ...patch }));
  assert.equal(api.normalizeQueue({ name: 'Work' }, { id }).id, id);
});
test('fair selection skips blocked hosts and respects global and queue caps', () => {
  const queues = [q({ taskIds: ['a','b','c'], concurrency: 2 }), q({ id, taskIds: ['d','e'] })];
  const tasks = [task('r', {status:'downloading'}), task('a'), task('b',{url:'https://two.test/b'}), task('c',{url:'https://three.test/c'}), task('d'), task('e',{url:'https://four.test/e'})];
  assert.deepEqual(api.evaluateQueues({queues,tasks,now:'2026-10-26T01:00:00Z',maxConcurrent:4,maxPerHost:1}).runnableIds, ['b','e','c']);
});
test('manual pauses, headers, completed tasks and one shots remain intact', () => {
  const tasks = [task('a',{status:'paused'}), task('b',{status:'paused',queueHold:true}), task('c',{requiresHeadersMissing:true}), task('d',{status:'completed'}), task('e',{startAt:'2026-10-26T03:00:00Z'})];
  const queue = q({taskIds:tasks.map(t=>t.id)}); const before = structuredClone({queue,tasks});
  const result = evaluate(queue,tasks,'2026-10-26T02:00:00Z');
  assert.deepEqual(result.runnableIds,['b']); assert.equal(result.nextWakeAt,'2026-10-26T03:00:00.000Z'); assert.deepEqual({queue,tasks},before);
});
test('half open windows pause running work and calculate wake boundaries', () => {
  const queue = q({schedule:schedule(),taskIds:['a']}); const tasks=[task('a',{status:'downloading'})];
  assert.equal(evaluate(queue,tasks,'2026-10-26T01:59:00Z').nextWakeAt,'2026-10-26T02:00:00.000Z');
  assert.deepEqual(evaluate(queue,tasks,'2026-10-26T02:00:00Z').pauseIds,[]);
  assert.equal(evaluate(queue,tasks,'2026-10-26T02:30:00Z').nextWakeAt,'2026-10-26T03:00:00.000Z');
  assert.deepEqual(evaluate(queue,tasks,'2026-10-26T03:00:00Z').pauseIds,['a']);
});
test('overnight weekdays refer to start day', () => {
  const queue=q({schedule:schedule({weekdays:[1],start:'22:00',stop:'02:00'}),taskIds:['a']});
  assert.deepEqual(evaluate(queue,[task('a')],'2026-10-26T18:00:00Z').runnableIds,['a']);
  assert.deepEqual(evaluate(queue,[task('a')],'2026-10-27T19:00:00Z').runnableIds,[]);
});
test('closed watermark prevents reopening after arbitrary clock rollback', () => {
  let queue=q({schedule:schedule(),taskIds:['a']});
  let out=evaluate(queue,[task('a')],'2026-10-26T02:30:00Z'); queue={...queue,...out.queueTransitions[0]};
  out=evaluate(queue,[task('a')],'2026-10-26T03:00:00Z'); queue={...queue,...out.queueTransitions[0]};
  assert.deepEqual(evaluate(queue,[task('a')],'2026-10-26T02:30:00Z').runnableIds,[]);
  assert.deepEqual(evaluate(queue,[task('a')],'2025-10-26T02:30:00Z').runnableIds,[]);
});
test('DST gap advances boundary while fold closes at first stop', () => {
  let queue=q({schedule:schedule({timezone:'America/New_York',start:'02:30',stop:'04:00'}),taskIds:['a']});
  assert.deepEqual(evaluate(queue,[task('a')],'2026-03-08T06:59:00Z').runnableIds,[]);
  assert.deepEqual(evaluate(queue,[task('a')],'2026-03-08T07:00:00Z').runnableIds,['a']);
  queue=q({schedule:schedule({timezone:'America/New_York',start:'01:00',stop:'01:30'}),taskIds:['a']});
  assert.deepEqual(evaluate(queue,[task('a')],'2026-11-01T05:15:00Z').runnableIds,['a']);
  assert.deepEqual(evaluate(queue,[task('a')],'2026-11-01T06:15:00Z').runnableIds,[]);
});
test('disabled queues pause work and tiny byte caps reduce slots', () => {
  assert.deepEqual(evaluate(q({enabled:false,taskIds:['a']}),[task('a',{status:'downloading'})],'2026-10-26T02:30:00Z').pauseIds,['a']);
  assert.equal(api.effectiveQueueRate(q({concurrency:3,speedLimit:2}),task('a')),1);
  assert.equal(api.effectiveQueueRate(q({concurrency:3,speedLimit:300}),task('a',{speedLimit:50})),50);
  assert.equal(api.effectiveQueueRate(q(),task('a')),0);
  assert.deepEqual(evaluate(q({concurrency:3,speedLimit:1,taskIds:['a','b']}),[task('a'),task('b')],'2026-10-26T02:30:00Z').runnableIds,['a']);
});
test('new tasks join active occurrence without redundant durable transitions', () => {
  const queue=q({schedule:schedule(),taskIds:['a','b'],windowState:{key:'2026-10-26',closedKeys:['2026-10-25']}});
  const out=evaluate(queue,[task('a',{status:'completed'}),task('b')],'2026-10-26T02:45:00Z');
  assert.deepEqual(out.runnableIds,['b']); assert.deepEqual(out.queueTransitions,[]);
});
test('outside window future one shot wakes at the next allowed window', () => {
  const queue=q({schedule:schedule(),taskIds:['a']});
  const out=evaluate(queue,[task('a',{startAt:'2026-10-26T04:00:00Z'})],'2026-10-26T03:30:00Z');
  assert.deepEqual(out.runnableIds,[]); assert.equal(out.nextWakeAt,'2026-10-27T02:00:00.000Z');
});
test('IANA timezone contract rejects fixed offset timezone strings', () => {
  assert.throws(()=>api.normalizeQueue(q({schedule:schedule({timezone:'+01:00'})})));
});
test('numeric one shot times wait until due and retain original timestamps', () => {
  const tasks=[task('a',{startAt:1792983600000}),task('b',{startAt:1792980000000}),task('c',{status:'failed'}),task('d',{status:'canceled'})];
  const out=evaluate(q({taskIds:['a','b','c','d']}),tasks,new Date('2026-10-26T02:00:00Z'));
  assert.deepEqual(out.runnableIds,['b']); assert.equal(out.nextWakeAt,'2026-10-26T03:00:00.000Z');
  assert.equal(tasks[0].startAt,1792983600000);
});
