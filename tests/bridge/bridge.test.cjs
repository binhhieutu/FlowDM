const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { runHost } = require('../../src/bridge/host.cjs');
const { FrameDecoder, encodeFrame, MAX_FRAME, validRequest } = require('../../src/bridge/protocol.cjs');
const { createHostBundle, generateBundle } = require('../../src/bridge/install.cjs');
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
  const invalid=[{}, {...request(),schema:2},{...request(),op:'delete'},{...request(),request_id:''},request('x','file:///tmp/a'),request('x','https://a:b@example.com'),{...request(),payload:{url:'https://example.com',headers:{Host:'x'}}},{...request(),extra:true}];
  for(const item of invalid) assert.equal((await dispatch(server.config,item)).ok,false);
  assert.equal(count,0);
});

test('v2 payload permits explicit direct/HLS metadata and bounded allowlisted headers', () => {
  const payload={url:'https://example.com/video.m3u8',filename:'Bài giảng.mp4',mediaType:'hls',headers:{Referer:'https://example.com/',Cookie:'sid=private',Authorization:'Bearer private','User-Agent':'FlowDM'}};
  assert.equal(validRequest({...request(),payload}),true);
  const invalid=[{mediaType:'unknown'},{filename:'../bad'},{filename:'x\\bad'},{filename:'CON.txt'},{filename:'nul'},{filename:'x.'},{filename:'a\r\nb'},{filename:'x'.repeat(181)},{filename:''},{headers:{Host:'evil'}},{headers:{Cookie:'x\r\nInjected: yes'}},{headers:{Cookie:'x\u0000'}},{headers:{Cookie:5}},{headers:{Cookie:'x'.repeat(65536)}},{headers:{Cookie:'a',cookie:'b'}},{headers:[]},{extra:true}];
  for(const extra of invalid)assert.equal(validRequest({...request(),payload:{...payload,...extra}}),false,JSON.stringify(extra));
  assert.equal(validRequest(request('long','https://example.com/'+ 'a'.repeat(16384))),false);
});

test('dedupe compares entire canonical payload, cloned headers and redacted acknowledgment',async t=>{
  let received;
  const {server}=await fixture(t,async payload=>{received=payload;payload.headers.cookie='mutated';return {id:'safe-id',headers:payload.headers};});
  const input={...request(),payload:{url:'https://example.com/a',filename:'clip.mp4',mediaType:'direct',headers:{Cookie:'private',Referer:'https://example.com/'}}};
  const reply=await dispatch(server.config,input);
  assert.deepEqual(reply,{request_id:'test-1',ok:true,payload:{id:'safe-id'}});
  assert.equal(input.payload.headers.Cookie,'private');assert.equal(received.headers.cookie,'mutated');
  const reordered={...input,payload:{headers:{referer:'https://example.com/',cookie:'private'},mediaType:'direct',filename:'clip.mp4',url:input.payload.url}};
  assert.deepEqual(await dispatch(server.config,reordered),reply);
  for(const change of [{filename:'other.mp4'},{mediaType:'hls'},{headers:{Cookie:'different'}}])assert.equal((await dispatch(server.config,{...input,payload:{...input.payload,...change}})).error,'REQUEST_ID_CONFLICT');
  assert.equal(JSON.stringify(reply).includes('private'),false);
});

test('host bundle validates inputs and creates an executable isolated native host',async t=>{
  const {server,dataDir}=await fixture(t);
  const output=path.join(dataDir,'bundle & (safe)');
  const bundle=await createHostBundle({output,dataDir,extensionId:'a'.repeat(32),nodePath:process.execPath,electron:true});
  const manifest=JSON.parse(await fs.readFile(bundle.manifestPath,'utf8'));
  assert.equal(manifest.path,bundle.wrapperPath);assert.deepEqual(manifest.allowed_origins,[`chrome-extension://${'a'.repeat(32)}/`]);
  const wrapper=await fs.readFile(bundle.wrapperPath,'utf8');assert.match(wrapper,/ELECTRON_RUN_AS_NODE/);
  const run=await new Promise((resolve,reject)=>{
    const child=process.platform==='win32'?spawn(process.env.ComSpec||'cmd.exe',['/d','/s','/c',`""${bundle.wrapperPath}""`],{windowsVerbatimArguments:true}):spawn(bundle.wrapperPath,[]);
    const frames=[];let stderr='';const decoder=new FrameDecoder(value=>frames.push(value));
    child.stdout.on('data',chunk=>decoder.push(chunk));child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);
    child.on('close',code=>resolve({code,frames,stderr}));child.stdin.end(encodeFrame(request()));
  });
  assert.equal(run.code,0,run.stderr);assert.equal(run.frames[0].ok,true);
  await assert.rejects(createHostBundle({output:path.join(dataDir,'other'),dataDir,extensionId:'invalid'}));
  await assert.rejects(createHostBundle({output:'relative',dataDir,extensionId:'a'.repeat(32)}));
  await assert.rejects(createHostBundle({output:path.join(dataDir,'bad%path'),dataDir,extensionId:'a'.repeat(32)}));
  const legacy=await generateBundle({outputDir:path.join(dataDir,'legacy'),dataDir,extensionId:'b'.repeat(32)});
  assert.equal(path.basename(legacy),'local.flowdm.bridge.json');
  assert.equal(server.config.secret.length,64);
});

test('host handles invalid requests, malformed/truncated frames and message flood without echoing credentials',async()=>{
  async function run(buffer) {
    const input=new PassThrough();const output=new PassThrough();const frames=[];let diagnostic='';
    const decode=new FrameDecoder(value=>frames.push(value));output.on('data',chunk=>decode.push(chunk));
    const original=process.stderr.write;process.stderr.write=(value)=>{diagnostic+=value;return true;};
    try {const pending=runHost({input,output,dataDir:os.tmpdir()});input.end(buffer);await pending;decode.end();}
    finally {process.stderr.write=original;}
    return {frames,diagnostic};
  }
  const invalid=await run(encodeFrame({schema:1,request_id:'bad',op:'add',payload:{url:'file:///private',headers:{Cookie:'super-secret'}}}));
  assert.equal(invalid.frames[0].error,'INVALID_REQUEST');assert.equal(JSON.stringify(invalid).includes('super-secret'),false);
  assert.match((await run(Buffer.from([1,0]))).diagnostic,/Truncated/);
  assert.match((await run(Buffer.alloc(4))).diagnostic,/Invalid/);
  const flood=await run(Buffer.concat(Array.from({length:33},()=>encodeFrame({}))));
  assert.equal(flood.frames.length,32);assert.match(flood.diagnostic,/Invalid/);
});

test('installer CLI preserves legacy interface and rejects unsafe paths',async t=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'flowdm-installer-'));
  t.after(()=>fs.rm(dataDir,{recursive:true,force:true}));
  async function run(args) {return new Promise((resolve,reject)=>{
    const child=spawn(process.execPath,[path.resolve('src/bridge/install.cjs'),...args],{env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});let stdout='',stderr='';
    child.stdout.on('data',chunk=>stdout+=chunk);child.stderr.on('data',chunk=>stderr+=chunk);child.on('error',reject);child.on('close',code=>resolve({code,stdout,stderr}));
  });}
  const result=await run(['--output',path.join(dataDir,'output'),'--data-dir',dataDir,'--extension-id','c'.repeat(32),'--node',process.execPath,'--electron']);
  assert.equal(result.code,0,result.stderr);assert.equal(JSON.parse(await fs.readFile(result.stdout.trim(),'utf8')).name,'local.flowdm.bridge');
  assert.equal((await run([])).code,1);
  await assert.rejects(createHostBundle({output:path.join(dataDir,'new'),dataDir,extensionId:'a'.repeat(32),electron:'yes'}));
  for(const suffix of ['bad!','bad%','bad\n','bad"'])await assert.rejects(createHostBundle({output:path.join(dataDir,suffix),dataDir,extensionId:'a'.repeat(32)}));
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
