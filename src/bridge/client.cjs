const net=require('node:net');
const path=require('node:path');
const {FrameDecoder,encodeFrame}=require('./protocol.cjs');
function dispatch(config,request,{timeoutMs=4500}={}) {
  return new Promise((resolve,reject)=>{
    if(typeof config?.endpoint!=='string' || typeof config.secret!=='string' || !(process.platform==='win32'?config.endpoint.startsWith('\\\\.\\pipe\\flowdm-'):path.isAbsolute(config.endpoint))) {reject(new Error('Invalid local bridge configuration'));return;}
    const socket=net.createConnection(config.endpoint);let done=false;
    function finish(error,value){if(done)return;done=true;socket.destroy();error?reject(error):resolve(value);}
    const decoder=new FrameDecoder(value=>finish(null,value));
    socket.setTimeout(timeoutMs,()=>finish(new Error('Bridge deadline')));
    socket.on('connect',()=>{try{socket.write(encodeFrame({secret:config.secret,request}));}catch(error){finish(error);}});
    socket.on('data',chunk=>{try{decoder.push(chunk);}catch(error){finish(error);}});
    socket.on('error',error=>finish(error));socket.on('close',()=>{if(!done)finish(new Error('Bridge closed'));});
  });
}
module.exports={dispatch};
