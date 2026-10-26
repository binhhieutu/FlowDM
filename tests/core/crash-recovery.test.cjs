'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs/promises'),os=require('node:os'),path=require('node:path');
const {atomicJournal}=require('../../src/core/storage.cjs');
async function fixture(t){const root=await fs.mkdtemp(path.join(os.tmpdir(),'flowdm-crash-core-'));t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('flowdm-crash-core-'));await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:100});});return{root,journal:path.join(root,'downloads.json')};}
test('schema8 journal stores queues atomically and requires queue metadata',async t=>{const f=await fixture(t);await atomicJournal(f.journal,[{id:'a'}],8,{queues:[{id:'default'}]});assert.deepEqual(JSON.parse(await fs.readFile(f.journal)),{version:8,tasks:[{id:'a'}],queues:[{id:'default'}]});await assert.rejects(atomicJournal(f.journal,[],8),/Queue journal/);});
test('journal disk-full write and failed sync preserve prior journal and clean own temporary',async t=>{const f=await fixture(t);await atomicJournal(f.journal,[{old:true}]);const original=await fs.readFile(f.journal,'utf8'),open=fs.open;for(const stage of ['writeFile','sync']){try{fs.open=async(filename,...args)=>{const handle=await open(filename,...args);if(!String(filename).startsWith(f.journal+'.'))return handle;return{writeFile:stage==='writeFile'?async()=>{throw Object.assign(Error('disk full'),{code:'ENOSPC'});}:handle.writeFile.bind(handle),sync:stage==='sync'?async()=>{throw Object.assign(Error('denied'),{code:'EACCES'});}:handle.sync.bind(handle),close:handle.close.bind(handle)};};await assert.rejects(atomicJournal(f.journal,[{new:true}]),{code:stage==='writeFile'?'ENOSPC':'EACCES'});}finally{fs.open=open;}assert.equal(await fs.readFile(f.journal,'utf8'),original);assert.deepEqual(await fs.readdir(f.root),['downloads.json']);}});
test('owned child termination at publication and journal commit boundaries preserves valid committed state',async t=>{
  const {fork}=require('node:child_process');const crypto=require('node:crypto');const {once}=require('node:events');const {recoverPublished}=require('../../src/core/storage.cjs');
  for(const mode of ['after-data-sync','before-publication','after-publication','before-journal-replace','after-journal-replace'])await t.test(mode,async sub=>{
    const f=await fixture(sub),body=Buffer.alloc(32768,73),partial=path.join(f.root,'partial.bin'),destination=path.join(f.root,'final.bin');
    await fs.writeFile(partial,body);await atomicJournal(f.journal,[{old:true}]);const child=fork(path.resolve('tests/core/helpers/storage-crash-worker.cjs'),[mode,f.root],{stdio:['ignore','pipe','pipe','ipc'],windowsHide:true});let stderr='';child.stderr.on('data',chunk=>{stderr+=chunk;});sub.after(()=>{if(child.exitCode===null&&!child.killed)child.kill('SIGKILL');});
    await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(Error('Crash worker timeout: '+stderr)),10000);child.once('message',message=>{clearTimeout(timer);assert.equal(message.stage,mode);resolve();});child.once('exit',()=>{clearTimeout(timer);reject(Error('Crash worker exited before boundary: '+stderr));});});
    const exited=once(child,'exit');assert.equal(child.kill('SIGKILL'),true);await exited;
    const saved=JSON.parse(await fs.readFile(f.journal,'utf8'));
    assert.deepEqual(saved.tasks,mode==='after-journal-replace'?[{new:true}]:[{old:true}]);
    assert.deepEqual(await fs.readFile(partial),body);
    if(mode==='after-publication'){
      assert.deepEqual(await fs.readFile(destination),body);
      assert.equal(await recoverPublished({path:destination,totalBytes:body.length,downloadedBytes:body.length,sha256:crypto.createHash('sha256').update(body).digest('hex')}),true);
    }else await assert.rejects(fs.stat(destination),{code:'ENOENT'});
    // A later journal write replaces the committed entry without reading orphan temps.
    await atomicJournal(f.journal,[{recovered:true}]);assert.deepEqual(JSON.parse(await fs.readFile(f.journal,'utf8')).tasks,[{recovered:true}]);
  });
});
test('contradictory crash journal byte counters are refused without modifying retained state',async t=>{
  const {DownloadManager}=require('../../src/core/download-manager.cjs');const f=await fixture(t),options={dataDir:path.join(f.root,'state'),downloadDir:path.join(f.root,'files')};
  const manager=await new DownloadManager(options).init();await manager.add({url:'http://127.0.0.1:9/offline',startAt:Date.now()+60000});await manager.close();
  const filename=path.join(options.dataDir,'downloads.json'),saved=JSON.parse(await fs.readFile(filename,'utf8'));saved.tasks[0].downloadedBytes=1;const corrupted=JSON.stringify(saved);await fs.writeFile(filename,corrupted);
  const candidate=new DownloadManager(options);await assert.rejects(candidate.init(),/byte count/i);await candidate.close();assert.equal(await fs.readFile(filename,'utf8'),corrupted);
});
test('Windows transient journal replacement locks retry the same synced temporary without losing prior state',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t);await atomicJournal(f.journal,[{old:true}]);const before=await fs.readFile(f.journal,'utf8'),rename=fs.rename,sources=[];
  try{fs.rename=async(source,destination)=>{if(destination!==f.journal)return rename(source,destination);sources.push(source);if(sources.length<3){assert.equal(await fs.readFile(f.journal,'utf8'),before);throw Object.assign(Error('sharing violation'),{code:sources.length===1?'EPERM':'EBUSY'});}return rename(source,destination);};await atomicJournal(f.journal,[{new:true}]);}finally{fs.rename=rename;}
  assert.equal(sources.length,3);assert.equal(new Set(sources).size,1);assert.deepEqual(JSON.parse(await fs.readFile(f.journal,'utf8')).tasks,[{new:true}]);assert.deepEqual(await fs.readdir(f.root),['downloads.json']);
});
test('Windows permanent journal replacement denial exhausts bounded attempts and preserves old journal',{skip:process.platform!=='win32'},async t=>{
  const f=await fixture(t);await atomicJournal(f.journal,[{old:true}]);const before=await fs.readFile(f.journal,'utf8'),rename=fs.rename;let attempts=0;
  try{fs.rename=async(source,destination)=>{if(destination!==f.journal)return rename(source,destination);attempts++;throw Object.assign(Error('denied'),{code:'EACCES'});};await assert.rejects(atomicJournal(f.journal,[{new:true}]),{code:'EACCES'});}finally{fs.rename=rename;}
  assert.equal(attempts,6);assert.equal(await fs.readFile(f.journal,'utf8'),before);assert.deepEqual(await fs.readdir(f.root),['downloads.json']);
});
