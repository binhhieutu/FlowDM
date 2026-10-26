'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { QueueCoordinator } = require('../../src/core/queue-manager.cjs');
function fixture() {
  const power = { intents: [], cancel() {}, arm(intent) { this.intents.push(intent); } };
  const manager = { maxConcurrent: 3, maxPerHost: 2, tasks: new Map(), running: new Map(), pendingAdds: new Set(), secrets: new Map(), writes: 0,
    async _persist() { this.writes++; if (this.fail) throw Error('disk full'); }, _notify() {}, _pump() {},
    async _pause(id, {queueHold=false}={}) { const task=this.tasks.get(id); task.status='paused'; task.queueHold=queueHold; this.running.delete(id); } };
  const queues = new QueueCoordinator(manager, {clock:()=>Date.parse('2026-10-26T02:00:00Z'), powerController:power});
  const add=(id, status='queued')=>{const task={id,status,url:'https://example.com/'+id,speedLimit:0,startAt:null};manager.tasks.set(id,task);queues.attach(task);return task;};
  return {manager,queues,power,add};
}
test('legacy load assigns default queue in durable task order without reviving paused tasks',()=>{
  const {queues}=fixture();const tasks=queues.load({version:6,tasks:[{id:'a',status:'paused'},{id:'b',status:'completed'}]});
  assert.deepEqual(queues.snapshot()[0].taskIds,['a','b']);assert.equal(tasks[0].queueId,'default');assert.equal(tasks[0].queueHold,false);assert.equal(tasks[0].status,'paused');
});
test('v7 rejects unknown queues and ambiguous ownership',()=>{
  const {queues}=fixture();const q=queues.snapshot()[0];q.taskIds=['a'];
  assert.throws(()=>queues.load({version:7,queues:[q],tasks:[{id:'a',queueId:'wrong',queueHold:false}]}));
  assert.throws(()=>queues.load({version:7,queues:[q,q],tasks:[{id:'a',queueId:'default',queueHold:false}]}));
});
test('create/reorder/move persist order and refuse live transfer moves',async()=>{
  const {queues,manager,add}=fixture();add('a');add('b');const q=await queues.createQueue({name:'Other',concurrency:1});
  await queues.reorderQueue('default',['b','a']);await queues.moveTask('b',q.id);assert.deepEqual(queues.queues.get(q.id).taskIds,['b']);
  manager.running.set('a',{});await assert.rejects(queues.moveTask('a',q.id));await assert.rejects(queues.deleteQueue(q.id));
  assert.deepEqual(queues.queues.get('default').taskIds,['a']);
});
test('failed persistence rolls back configuration and releases admission block',async()=>{
  const {queues,manager}=fixture();manager.fail=true;await assert.rejects(queues.createQueue({name:'No'}),/disk full/);assert.equal(queues.queues.size,1);assert.equal(queues.blocked,0);
});
test('scheduler enforces global queue host bounds and skips pending or unavailable credentials',async()=>{
  const {queues,manager,add}=fixture();add('a');add('b');add('c');add('d');manager.pendingAdds.add('a');manager.tasks.get('b').requiresHeaders=true;
  assert.deepEqual(queues.evaluate().runnableIds,['c','d']);await queues.updateQueue('default',{concurrency:1});assert.deepEqual(queues.evaluate().runnableIds,['c']);
});
test('reconcile releases only queue-held paused work preserving one-shot time',async()=>{
  const {queues,manager,add}=fixture();const manual=add('a','paused'),held=add('b','paused');held.queueHold=true;held.startAt=Date.parse('2026-10-25T00:00:00Z');
  await queues.reconcile();assert.equal(manual.status,'paused');assert.equal(held.status,'queued');assert.equal(held.startAt,Date.parse('2026-10-25T00:00:00Z'));assert.equal(held.queueHold,false);assert.ok(manager.writes);
});
test('stop window pauses running work with queue provenance',async()=>{
  const {queues,manager,add}=fixture();add('a','downloading');manager.running.set('a',{});await queues.updateQueue('default',{enabled:false});await queues.reconcile();assert.equal(manager.tasks.get('a').status,'paused');assert.equal(manager.tasks.get('a').queueHold,true);
});
test('completion deduplicates after durable key; incomplete or active other work blocks destructive actions',async()=>{
  const {queues,manager,power,add}=fixture();add('a','completed');await queues.updateQueue('default',{onComplete:'shutdown'});await queues.completed('a');await queues.completed('a');assert.equal(power.intents.length,1);
  assert.equal(await queues.beforePowerDispatch(power.intents[0]),true);add('b','paused');assert.equal(await queues.beforePowerDispatch(power.intents[0]),false);
  manager.tasks.get('b').status='completed';manager.fail=true;await assert.rejects(queues.completed('b'));assert.equal(power.intents.length,1);
});
test('failed move restores task ownership and exact order without deleting task data',async()=>{
  const {queues,manager,add}=fixture();const task=add('a');task.downloadedBytes=123;const q=await queues.createQueue({name:'Other'});manager.fail=true;
  await assert.rejects(queues.moveTask('a',q.id));assert.equal(task.queueId,'default');assert.equal(task.downloadedBytes,123);assert.deepEqual(queues.require('default').taskIds,['a']);assert.deepEqual(queues.require(q.id).taskIds,[]);
});
test('v7 requires every stored task to have an explicit owner',()=>{
  const {queues}=fixture();assert.throws(()=>queues.load({version:7,queues:queues.snapshot(),tasks:[{id:'a',queueHold:false}]}),/Unassigned/);
});
test('running queue limits are immutable while enabled changes remain available',async()=>{
  const {queues,manager,add}=fixture();add('a','downloading');manager.running.set('a',{});
  await assert.rejects(queues.updateQueue('default',{speedLimit:1}),/Pause/);await assert.rejects(queues.updateQueue('default',{concurrency:1}),/Pause/);
  await queues.pauseQueue('default');assert.equal(manager.tasks.get('a').queueHold,true);await queues.updateQueue('default',{speedLimit:1,concurrency:3});assert.equal(queues.require('default').speedLimit,1);
});
test('failed schedule release remains held and does not synchronously retry pumping',async()=>{
  const {queues,manager,add}=fixture();const task=add('a','paused');task.queueHold=true;manager.fail=true;let pumps=0;manager._pump=()=>pumps++;
  await assert.rejects(queues.reconcile());assert.equal(task.status,'paused');assert.equal(task.queueHold,true);assert.equal(queues.blocked,0);assert.equal(pumps,0);
});
test('notification allows unrelated work and changing settings cancels a pending destructive intent',async()=>{
  const {queues,power,add}=fixture();add('a','completed');const other=await queues.createQueue({name:'Other'});add('b','paused');await queues.moveTask('b',other.id);
  await queues.updateQueue('default',{onComplete:'shutdown'});await queues.completed('a');assert.equal(power.intents.length,0);assert.ok(queues.require('default').lastCompletionKey);
  await queues.updateQueue('default',{onComplete:'notify'});await queues.completed('a');assert.equal(power.intents.length,1);assert.equal(await queues.beforePowerDispatch(power.intents[0]),true);
});
test('v7 roundtrip preserves explicit ownership, held state and completion receipt',async()=>{
  const {queues,manager,add}=fixture();const task=add('a','paused');task.queueHold=true;await queues.updateQueue('default',{onComplete:'notify'});queues.require('default').lastCompletionKey='saved';
  const saved={version:7,queues:queues.snapshot(),tasks:[task]}, restored=queues.load(saved);assert.equal(restored[0].queueHold,true);assert.equal(queues.require('default').lastCompletionKey,'saved');
  saved.queues[0].name='Mutated';assert.equal(queues.require('default').name,'Default');assert.equal(manager.tasks.size,1);
});
test('exact reorder, insertion move and empty deletion reject invalid inputs',async()=>{
  const {queues,add}=fixture();const a=add('a'),b=add('b');const q=await queues.createQueue({name:'Other'});
  await assert.rejects(queues.reorderQueue('default',['a','a']));await assert.rejects(queues.createQueue({taskIds:[]}));await assert.rejects(queues.updateQueue('default',{id:'bad'}));
  await queues.moveTask(b.id,'default',a.id);assert.deepEqual(queues.require('default').taskIds,['b','a']);
  await assert.rejects(queues.moveTask('missing',q.id));await assert.rejects(queues.moveTask('a',q.id,'missing'));
  queues.detach('a');assert.deepEqual(queues.require('default').taskIds,['b']);assert.equal(await queues.deleteQueue(q.id),true);
  assert.throws(()=>queues.attach(b),/already/);assert.equal(await queues.beforePowerDispatch({queueId:'missing'}),false);
});
test('resume queue releases held workers but invalid completion events cannot arm power',async()=>{
  const {queues,add,power}=fixture();const task=add('a','paused');task.queueHold=true;await queues.pauseQueue('default');await queues.resumeQueue('default');assert.equal(task.status,'queued');
  assert.equal(await queues.completed('a'),false);assert.equal(await queues.completed('missing'),false);assert.equal(power.intents.length,0);
});
test('manual queue pause wins a late publication completion callback and final power check',async()=>{
  const {queues,manager,add,power}=fixture();const task=add('a','downloading');manager.running.set('a',{});await queues.updateQueue('default',{onComplete:'shutdown'});
  await queues.pauseQueue('default');task.status='completed';await queues.completed('a');assert.equal(power.intents.length,0);assert.equal(queues.require('default').lastCompletionKey,null);
  await queues.resumeQueue('default');await queues.completed('a');assert.equal(power.intents.length,1);await queues.pauseQueue('default');assert.equal(await queues.beforePowerDispatch(power.intents[0]),false);
});
test('durable destructive receipt waits in RAM for other queues to finish and arms once',async()=>{
  const {queues,manager,add,power}=fixture();const a=add('a','completed');const other=await queues.createQueue({name:'Other'});const b=add('b','paused');
  await queues.moveTask('b',other.id);b.status='downloading';
  await queues.updateQueue('default',{onComplete:'shutdown'});const arms=[];power.arm=intent=>arms.push({intent,writes:manager.writes,key:queues.require(intent.queueId).lastCompletionKey});
  await queues.completed(a.id);assert.equal(arms.length,0);const receiptWrites=manager.writes;assert.ok(queues.require('default').lastCompletionKey);
  b.status='completed';await queues.completed(b.id);assert.equal(arms.length,1);assert.equal(arms[0].intent.queueId,'default');assert.equal(arms[0].key,arms[0].intent.intentId);assert.ok(arms[0].writes>receiptWrites);
  await queues.completed(a.id);await queues.completed(b.id);assert.equal(arms.length,1);
});
test('pending destructive completion is canceled by new work and never restored from journal',async()=>{
  const {queues,manager,add,power}=fixture();add('a','completed');const other=await queues.createQueue({name:'Other'});const b=add('b','paused');await queues.moveTask('b',other.id);await queues.updateQueue('default',{onComplete:'shutdown'});await queues.completed('a');
  const saved={version:7,queues:queues.snapshot(),tasks:[...manager.tasks.values()]};queues.load(saved);b.status='completed';await queues.completed('b');assert.equal(power.intents.length,0);
});
test('transient completion receipt write retries in reconcile without replaying startup history',async()=>{
  const {queues,manager,add,power}=fixture();add('a','completed');await queues.updateQueue('default',{onComplete:'shutdown'});manager.fail=true;
  await assert.rejects(queues.completed('a'));assert.equal(power.intents.length,0);assert.equal(queues.require('default').lastCompletionKey,null);
  manager.fail=false;await queues.reconcile();assert.equal(power.intents.length,1);assert.equal(queues.require('default').lastCompletionKey,power.intents[0].intentId);
  await queues.reconcile();assert.equal(power.intents.length,1);
});
test('new work cancels both pending destructive intent and undurable receipt retry',async()=>{
  const {queues,manager,add,power}=fixture();add('a','completed');const other=await queues.createQueue({name:'Other'});const b=add('b','paused');await queues.moveTask('b',other.id);await queues.updateQueue('default',{onComplete:'shutdown'});await queues.completed('a');
  const c=add('c','paused');b.status='completed';c.status='completed';await queues.completed('b');assert.equal(power.intents.length,0);
  await queues.updateQueue('default',{onComplete:'sleep'});manager.fail=true;await assert.rejects(queues.completed('a'));queues.cancelPower();manager.fail=false;await queues.reconcile();assert.equal(power.intents.length,0);
});
test('first destructive completion wins when several queues become idle together',async()=>{
  const {queues,manager,add,power}=fixture();add('a','completed');const other=await queues.createQueue({name:'Other',onComplete:'sleep'});const b=add('b','paused');await queues.moveTask('b',other.id);await queues.updateQueue('default',{onComplete:'shutdown'});await queues.completed('a');
  b.status='completed';await queues.completed('b');assert.equal(power.intents.length,1);assert.equal(power.intents[0].action,'shutdown');await queues.reconcile();assert.equal(power.intents.length,1);
});
test('synchronous cancellation invalidates a receipt continuation already awaiting persistence',async()=>{
  const {queues,manager,add,power}=fixture();add('a','completed');await queues.updateQueue('default',{onComplete:'shutdown'});
  let finish;manager._persist=()=>new Promise(resolve=>{finish=resolve;});const completion=queues.completed('a');queues.cancelPower();finish();await completion;
  assert.equal(power.intents.length,0);assert.equal(queues.pendingCompletions.size,0);
});
test('cancellation during a failed receipt write prevents later reconciliation retry',async()=>{
  const {queues,manager,add,power}=fixture();add('a','completed');await queues.updateQueue('default',{onComplete:'shutdown'});
  let fail;manager._persist=()=>new Promise((resolve,reject)=>{fail=reject;});const completion=queues.completed('a');queues.cancelPower();fail(Error('disk full'));await assert.rejects(completion);
  assert.equal(queues.pendingReceipts.size,0);manager._persist=async()=>{};await queues.reconcile();assert.equal(power.intents.length,0);
});
