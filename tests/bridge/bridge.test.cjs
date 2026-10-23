const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { FrameDecoder, encodeFrame, MAX_FRAME } = require('../../src/bridge/protocol.cjs');
const { createBridge } = require('../../src/bridge/server.cjs');
const { dispatch } = require('../../src/bridge/client.cjs');
assert.equal(require('../../src/bridge/index.cjs').createBridge,createBridge);
const request = (id = 'test-1', url = 'https://example.com/ảnh.zip') => ({schema:1,request_id:id,op:'add',payload:{url}});
async function fixture(t, onAdd = async () => ({id:'task-1'})) {
  const dataDir = await fs.mkdtemp(path.join(os.tmpdir(),'flowdm-bridge-'));
  const server = await createBridge({dataDir,onAdd});
  t.after(async () => { await server.close(); await fs.rm(dataDir,{recursive:true,force:true}); });
  return { dataDir, server };
}
test('frames preserve Unicode through partial prefixes, payload and multiple frames', () => {
  const values = [];
  const decoder = new FrameDecoder(value => values.push(value));
  const data = Buffer.concat([encodeFrame(request()), encodeFrame({hello:'Tiếng Việt'})]);
  for (let i=0;i<data.length;i+=3) decoder.push(data.subarray(i,i+3));
  decoder.end();
  assert.deepEqual(values,[request(),{hello:'Tiếng Việt'}]);
});
test('malformed, truncated, oversized and invalid UTF8 frames fail', () => {
  const invalidJson=Buffer.from(encodeFrame({}));invalidJson[4]=33;
  for (const input of [Buffer.from([1,0]), encodeFrame({}).subarray(0,5), Buffer.from([0,0,0,0]),invalidJson]) {
    assert.throws(() => { const d = new FrameDecoder(() => {}); d.push(input); d.end(); });
  }
  const prefix=Buffer.alloc(4); os.endianness()==='LE'?prefix.writeUInt32LE(MAX_FRAME+1):prefix.writeUInt32BE(MAX_FRAME+1);
  assert.throws(() => new FrameDecoder(() => {}).push(prefix), /large/i);
  assert.throws(() => encodeFrame({x:'x'.repeat(MAX_FRAME)}), /large/i);
  const invalid=Buffer.from([1,0,0,0,255]);
  assert.throws(() => new FrameDecoder(() => {}).push(invalid));
});
test('authenticated private IPC acknowledges and deduplicates concurrent requests', async t => {
  let count=0;
  const {server}=await fixture(t,async payload => { count++; assert.equal(payload.url,request().payload.url); return {id:'✓',url:'private'}; });
  const replies=await Promise.all([dispatch(server.config,request()),dispatch(server.config,request())]);
  assert.deepEqual(replies[0],{request_id:'test-1',ok:true,payload:{id:'✓'}});
  assert.deepEqual(replies[0],replies[1]); assert.equal(count,1);
  assert.equal((await dispatch(server.config,request('test-1','https://example.com/other'))).error,'REQUEST_ID_CONFLICT');
  assert.equal((await dispatch({...server.config,secret:'wrong'},request('bad-auth'))).ok,false);
  await server.close();
  await assert.rejects(dispatch(server.config,request('closed')));
});
test('schema, operations, credentials, URLs, fields and request ids are rejected before callback',async t => {
  let count=0; const {server}=await fixture(t,async()=>{count++;return {id:'x'};});
  const invalid=[{}, {...request(),schema:2},{...request(),op:'delete'},{...request(),request_id:''},request('x','file:///tmp/a'),request('x','https://a:b@example.com'),{...request(),payload:{url:'https://example.com',headers:{Cookie:'x'}}},{...request(),extra:true}];
  for(const item of invalid) assert.equal((await dispatch(server.config,item)).ok,false);
  assert.equal(count,0);
});
test('callback errors and deadlines return bounded safe errors',async t => {
  const {server}=await fixture(t,async()=>{throw new Error('secret internal path');});
  assert.equal((await dispatch(server.config,request())).error,'ADD_FAILED');
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'flowdm-timeout-'));
  const slow=await createBridge({dataDir:dir,onAdd:()=>new Promise(()=>{}),timeoutMs:30});
  t.after(async()=>{await slow.close();await fs.rm(dir,{recursive:true,force:true});});
  assert.equal((await dispatch(slow.config,request())).error,'ADD_TIMEOUT');
});
test('invalid callback results and absent configuration fail safely',async t=>{
  const {server}=await fixture(t,async()=>null);
  assert.equal((await dispatch(server.config,request())).error,'ADD_FAILED');
  await assert.rejects(createBridge({dataDir:'relative',onAdd(){}}));
  await assert.rejects(dispatch(server.config,{value:'x'.repeat(MAX_FRAME)}));
  await assert.rejects(dispatch({endpoint:1234,secret:'x'},request()),/local bridge/);
});
test('native host subprocess uses framed stdout with Unicode and absent desktop error',async t => {
  const {dataDir,server}=await fixture(t);
  const run=() => new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.resolve('src/bridge/host.cjs'),'--data-dir',dataDir],{stdio:['pipe','pipe','pipe'],env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});
    const frames=[];let stderr='';const decoder=new FrameDecoder(value=>frames.push(value));
    child.stdout.on('data',chunk=>decoder.push(chunk));child.stderr.on('data',chunk=>{stderr+=chunk;});child.on('error',reject);
    child.on('close',code=>{try{decoder.end();resolve({frames,stderr,code});}catch(error){reject(error);}});
    const input=encodeFrame(request()); child.stdin.write(input.subarray(0,2));child.stdin.end(input.subarray(2));
  });
  assert.equal((await run()).frames[0].ok,true);
  await server.close();
  assert.equal((await run()).frames[0].error,'DESKTOP_UNAVAILABLE');
});
