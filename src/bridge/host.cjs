#!/usr/bin/env node
const fs=require('node:fs/promises');
const path=require('node:path');
const {FrameDecoder,encodeFrame,validRequest}=require('./protocol.cjs');
const {CONFIG_NAME}=require('./server.cjs');
const {dispatch}=require('./client.cjs');
async function runHost({input=process.stdin,output=process.stdout,dataDir}={}) {
  let pending=Promise.resolve();let count=0;let failed=false;
  const decoder=new FrameDecoder(request=>{
    if(++count>32)throw new Error('Too many messages');
    pending=pending.then(async()=>{
      let reply={request_id:typeof request?.request_id==='string'?request.request_id.slice(0,128):null,ok:false,error:'INVALID_REQUEST'};
      if(validRequest(request)) {
        try {const config=JSON.parse(await fs.readFile(path.join(dataDir,CONFIG_NAME),'utf8'));reply=await dispatch(config,request,{timeoutMs:request.op==='rebindCredentials'?35000:4500});}
        catch {reply={request_id:request.request_id,ok:false,error:'DESKTOP_UNAVAILABLE'};}
      }
      output.write(encodeFrame(reply));
    });
  });
  await new Promise(resolve=>{
    input.on('data',chunk=>{if(failed)return;try{decoder.push(chunk);}catch{failed=true;process.stderr.write('Invalid native message frame\n');input.destroy();resolve();}});
    input.on('end',()=>{try{decoder.end();}catch{process.stderr.write('Truncated native message frame\n');}resolve();});
    input.on('error',()=>resolve());
  });
  await pending;
}
if(require.main===module) {
  const index=process.argv.indexOf('--data-dir');const dataDir=index>=0?process.argv[index+1]:null;
  if(!dataDir || !path.isAbsolute(dataDir)){process.stderr.write('Required: --data-dir ABSOLUTE_PATH\n');process.exitCode=1;}
  else runHost({dataDir}).catch(()=>{process.stderr.write('Native host failed\n');process.exitCode=1;});
}
module.exports={runHost};
