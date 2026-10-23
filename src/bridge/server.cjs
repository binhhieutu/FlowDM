const net=require('node:net');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const crypto=require('node:crypto');
const {FrameDecoder,encodeFrame,validRequest}=require('./protocol.cjs');
const CONFIG_NAME='browser-bridge.json';
const errorReply=(request,error)=>({request_id:typeof request?.request_id==='string'?request.request_id.slice(0,128):null,ok:false,error});
async function createBridge({dataDir,onAdd,timeoutMs=3000}) {
  if (typeof onAdd!=='function' || !path.isAbsolute(dataDir)) throw new Error('Absolute dataDir and onAdd required');
  await fs.mkdir(dataDir,{recursive:true,mode:0o700});
  const hash=crypto.createHash('sha256').update(`${os.userInfo().username}:${dataDir}`).digest('hex').slice(0,24);
  const secret=crypto.randomBytes(32).toString('hex');
  const endpoint=process.platform==='win32'?`\\\\.\\pipe\\flowdm-${hash}-${crypto.randomBytes(8).toString('hex')}`:path.join(dataDir,`bridge-${crypto.randomBytes(8).toString('hex')}.sock`);
  const config={endpoint,secret};const configPath=path.join(dataDir,CONFIG_NAME);
  const sockets=new Set();const seen=new Map();let closing=false;
  function authenticate(value) {
    return typeof value==='string' && Buffer.byteLength(value)===Buffer.byteLength(secret) && crypto.timingSafeEqual(Buffer.from(value),Buffer.from(secret));
  }
  async function handle(message) {
    if (!authenticate(message?.secret)) return errorReply(message?.request,'UNAUTHORIZED');
    const request=message.request;
    if (!validRequest(request)) return errorReply(request,'INVALID_REQUEST');
    const prior=seen.get(request.request_id);
    if (prior) return prior.url===request.payload.url?prior.promise:errorReply(request,'REQUEST_ID_CONFLICT');
    // Bound request retention; pending operations are never evicted.
    if (seen.size>=512) {
      const expired=[...seen].find(([,entry])=>entry.settled);
      if(!expired)return errorReply(request,'BRIDGE_BUSY');
      seen.delete(expired[0]);
    }
    const promise=(async()=>{
      let timer;
      try {
        const task=await Promise.race([Promise.resolve().then(()=>onAdd({...request.payload})),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('ADD_TIMEOUT')),timeoutMs);})]);
        if (!task || typeof task.id!=='string') throw new Error('Invalid task');
        return {request_id:request.request_id,ok:true,payload:{id:task.id}};
      } catch(error) { return errorReply(request,error.message==='ADD_TIMEOUT'?'ADD_TIMEOUT':'ADD_FAILED'); }
      finally {clearTimeout(timer);}
    })();
    const entry={url:request.payload.url,promise,settled:false};
    seen.set(request.request_id,entry);promise.then(()=>{entry.settled=true;});return promise;
  }
  const server=net.createServer(socket=>{
    sockets.add(socket);socket.setTimeout(timeoutMs+1000,()=>socket.destroy());
    let messages=0;
    const decoder=new FrameDecoder(message=>{
      if (++messages>1) {socket.destroy();return;}
      handle(message).then(reply=>{if(!socket.destroyed)socket.end(encodeFrame(reply));}).catch(()=>socket.destroy());
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
    for(const socket of sockets)socket.destroy();
    await new Promise(resolve=>server.close(resolve));
    try {const current=JSON.parse(await fs.readFile(configPath,'utf8'));if(current.secret===secret)await fs.unlink(configPath);}catch{}
  }};
}
module.exports={createBridge,CONFIG_NAME};
