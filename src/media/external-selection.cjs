'use strict';
const fs=require('node:fs/promises'); const path=require('node:path');const {spawn}=require('node:child_process');const {retryRequest,contentLength}=require('../core/http-client.cjs');const {checkedUrl}=require('../core/policy.cjs');
const MAX_SUBTITLE=2*1024*1024;const MAX_TOTAL=8*1024*1024;
async function subtitleFile({metadata,id,index,scratch,signal,budget}){
  const automatic=id.startsWith('auto:');const language=id.slice(id.indexOf(':')+1);const tracks=(automatic?metadata.automatic_captions:metadata.subtitles)?.[language];
  const track=tracks?.find(t=>t.ext==='vtt'&&typeof t.url==='string')||tracks?.find(t=>t.ext==='srt'&&typeof t.url==='string');
  if(!track)throw Error('Selected subtitle is unavailable');
  const result=await retryRequest(checkedUrl(track.url).href,{},signal);const chunks=[];let bytes=0;
  try{if(result.response.statusCode!==200||contentLength(result.response)>MAX_SUBTITLE)throw Error('Subtitle unavailable or exceeds size limit');for await(const chunk of result.response){bytes+=chunk.length;if(bytes>MAX_SUBTITLE||bytes>budget)throw Error('Subtitle size limit exceeded');chunks.push(chunk);}}finally{result.response.destroy();}
  const text=Buffer.concat(chunks);const decoded=text.toString('utf8');
  if(!bytes||text.includes(0)||!/(?:\d{2}:)?\d{2}:\d{2}[.,]\d{3}\s+-->\s+(?:\d{2}:)?\d{2}:\d{2}[.,]\d{3}/.test(decoded)||(track.ext==='vtt'&&!/^(?:\uFEFF)?WEBVTT(?:[ \t]|\r?\n|$)/.test(decoded)))throw Error('Invalid subtitle data');
  const filename=path.join(scratch,'media.subtitle-'+index+'.'+track.ext);const temporary=filename+'.tmp';
  const output=await fs.open(temporary,'wx',0o600);try{await output.writeFile(text);await output.sync();}finally{await output.close();}await fs.rename(temporary,filename);return{filename,bytes,language,format:track.ext==='vtt'?'webvtt':'srt'};
}
async function embedSubtitles({metadata,selection,produced,scratch,tools,signal,maxBytes,env}){
  if(!selection.subtitleIds.length)return produced;const tracks=[];let bytes=0;
  for(const [index,id]of selection.subtitleIds.entries()){const track=await subtitleFile({metadata,id,index,scratch,signal,budget:Math.min(MAX_TOTAL,maxBytes)-bytes});bytes+=track.bytes;tracks.push(track);}
  const output=path.join(scratch,'media.subtitled.mkv');
  // The downloader never writes this reserved remux target. A previous completed
  // remux belongs to the verified private checkpoint and may be rebuilt safely.
  await fs.unlink(output).catch(error=>{if(error.code!=='ENOENT')throw error;});
  const args=['-nostdin','-v','error','-xerror','-protocol_whitelist','file,pipe','-i',produced];for(const track of tracks)args.push('-protocol_whitelist','file,pipe','-f',track.format,'-i',track.filename);args.push('-map','0:v:0','-map','0:a:0');tracks.forEach((track,index)=>args.push('-map',(index+1)+':s:0','-metadata:s:s:'+index,'language='+track.language));args.push('-c','copy','-c:s','srt','-f','matroska',output);
  await new Promise((resolve,reject)=>{if(signal?.aborted)return reject(Object.assign(Error('Aborted'),{name:'AbortError'}));const child=spawn(tools.ffmpeg,args,{shell:false,windowsHide:true,stdio:['ignore','ignore','ignore'],env});const abort=()=>child.kill();signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();const timer=setTimeout(abort,60000);timer.unref();child.once('error',reject);child.once('close',code=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);if(signal?.aborted)return reject(Object.assign(Error('Aborted'),{name:'AbortError'}));code===0?resolve():reject(Error('Subtitle embedding failed'));});});
  if((await fs.stat(output)).size>maxBytes)throw Error('Subtitled output exceeds size limit');return output;
}
module.exports={embedSubtitles,subtitleFile};
