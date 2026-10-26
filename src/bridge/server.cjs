const net=require('node:net');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {FrameDecoder,encodeFrame,validRequest,normalizePayload,normalizeOperationPayload}=require('./protocol.cjs');
const CONFIG_NAME='browser-bridge.json';
const errorReply=(request,error)=>({request_id:typeof request?.request_id==='string'?request.request_id.slice(0,128):null,ok:false,error});
async function createBridge({dataDir,onAdd,onPreviewBatch,onCredentialRequests,onRebindCredentials,onCommitCredentials,onCancelCredentials,timeoutMs=3000,credentialTimeoutMs=30000}) {
  if (typeof onAdd!=='function' || !path.isAbsolute(dataDir)) throw new Error('Absolute dataDir and onAdd required');
  await fs.mkdir(dataDir,{recursive:true,mode:0o700});
  const hash=crypto.createHash('sha256').update(`${os.userInfo().username}:${dataDir}`).digest('hex').slice(0,24);
  const secret=crypto.randomBytes(32).toString('hex');
  const endpoint=process.platform==='win32'?`\\\\.\\pipe\\flowdm-${hash}-${crypto.randomBytes(8).toString('hex')}`:path.join(dataDir,`bridge-${crypto.randomBytes(8).toString('hex')}.sock`);
  const config={endpoint,secret};const configPath=path.join(dataDir,CONFIG_NAME);
  const sockets=new Set();const seen=new Map();const controllers=new Set();let closing=false;
  const callbacks={add:onAdd,previewBatch:onPreviewBatch,credentialRequests:onCredentialRequests,rebindCredentials:onRebindCredentials,commitCredentials:onCommitCredentials,cancelCredentials:onCancelCredentials};
  function authenticate(value) {
    return typeof value==='string' && Buffer.byteLength(value)===Buffer.byteLength(secret) && crypto.timingSafeEqual(Buffer.from(value),Buffer.from(secret));
  }
  async function handle(message,socket) {
    if (!authenticate(message?.secret)) return errorReply(message?.request,'UNAUTHORIZED');
    const request=message.request;
    if (!validRequest(request)) return errorReply(request,'INVALID_REQUEST');
    const payload=normalizeOperationPayload(request.op,request.payload);
    const fingerprint=crypto.createHash('sha256').update(JSON.stringify({op:request.op,payload})).digest('hex');
    const prior=seen.get(request.request_id);
    if (prior) return prior.fingerprint===fingerprint?prior.promise:errorReply(request,'REQUEST_ID_CONFLICT');
    // Bound request retention; pending operations are never evicted.
    if (seen.size>=512) {
      const expired=[...seen].find(([,entry])=>entry.settled);
      if(!expired)return errorReply(request,'BRIDGE_BUSY');
      seen.delete(expired[0]);
    }
    const controller=new AbortController();controllers.add(controller);let settled=false;
    const disconnected=()=>{if(!settled)controller.abort();};socket.once('close',disconnected);
    const budget=request.op==='rebindCredentials'?credentialTimeoutMs:timeoutMs;
    socket.setTimeout(budget+1000,()=>socket.destroy());
    const promise=(async()=>{
      let timer;
      try {
        const callback=callbacks[request.op];if(typeof callback!=='function')throw Error('Operation unavailable');
        const task=await Promise.race([Promise.resolve().then(()=>callback(structuredClone(payload),{signal:controller.signal})),new Promise((_,reject)=>{timer=setTimeout(()=>{controller.abort();reject(new Error('OP_TIMEOUT'));},budget);})]);
        controller.signal.throwIfAborted();
        if(request.op==='previewBatch') {
          if(typeof task?.previewId!=='string'||!/^[A-Za-z0-9_-]{1,128}$/.test(task.previewId)||!Number.isInteger(task.count)||task.count<1||task.count>1000)throw Error('Invalid preview');
          return {request_id:request.request_id,ok:true,payload:{previewId:task.previewId,count:task.count}};
        }
        if(request.op==='credentialRequests'){
          if(!Array.isArray(task?.requests)||task.requests.length>8)throw Error('Invalid requests');
          const requests=task.requests.map(item=>{
            const bound=normalizeOperationPayload('commitCredentials',{taskId:item.taskId,origin:item.origin,requestId:item.requestId});
            if(!bound||item.origin!==payload.origin||!normalizePayload({url:item.url})||new URL(item.url).origin!==item.origin||typeof item.filename!=='string'||item.filename.length>180||/[\u0000-\u001f\u007f]/.test(item.filename)||!Number.isFinite(item.expiresAt))throw Error('Invalid credential request');
            return {...bound,url:item.url,filename:item.filename,expiresAt:item.expiresAt};
          });
          return {request_id:request.request_id,ok:true,payload:{requests}};
        }
        if (!task || typeof task.id!=='string' || !task.id.length || task.id.length>128 || /[\u0000-\u001f\u007f]/.test(task.id)) throw new Error('Invalid task');
        if(request.op!=='add'&&task.id!==payload.taskId)throw Error('Credential task mismatch');
        if(request.op==='rebindCredentials'&&task.prepared!==true)throw Error('Credentials not prepared');
        return {request_id:request.request_id,ok:true,payload:{id:task.id,...(request.op==='rebindCredentials'?{prepared:true}:{})}};
      } catch(error) { return errorReply(request,request.op==='add'?(error.message==='OP_TIMEOUT'?'ADD_TIMEOUT':'ADD_FAILED'):request.op==='previewBatch'?(error.message==='OP_TIMEOUT'?'PREVIEW_TIMEOUT':'PREVIEW_FAILED'):(error.message==='OP_TIMEOUT'?'CREDENTIAL_TIMEOUT':'CREDENTIAL_FAILED')); }
      finally {settled=true;clearTimeout(timer);socket.removeListener('close',disconnected);controllers.delete(controller);}
    })();
    const entry={fingerprint,promise,settled:false};
    seen.set(request.request_id,entry);promise.then(()=>{entry.settled=true;});return promise;
  }
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.setTimeout(timeoutMs+1000,()=>socket.destroy());
    let messages=0;
    const decoder=new FrameDecoder(message=>{
      if (++messages>1) {socket.destroy();return;}
      handle(message,socket).then(reply=>{if(!socket.destroyed)socket.end(encodeFrame(reply));}).catch(()=>socket.destroy());
    });
    socket.on('data',chunk=>{try{decoder.push(chunk);}catch{socket.destroy();}});
    socket.on('end',()=>{try{decoder.end();}catch{socket.destroy();}});
    socket.on('error',()=>{});socket.on('close',()=>sockets.delete(socket));
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(endpoint,resolve);});
  if(process.platform!=='win32')await fs.chmod(endpoint,0o600);
  try {await fs.writeFile(configPath,JSON.stringify(config),{mode:0o600});await fs.chmod(configPath,0o600);}
  catch(error){server.close();throw error;}
  return {config,configPath,close:async()=>{
    if(closing)return;closing=true;
    for(const controller of controllers)controller.abort();
    for(const socket of sockets)socket.destroy();
    await new Promise(resolve=>server.close(resolve));
    try {const current=JSON.parse(await fs.readFile(configPath,'utf8'));if(current.secret===secret)await fs.unlink(configPath);}catch{}
  }};
}
module.exports={createBridge,CONFIG_NAME};
