'use strict';
const { resolveTools } = require('../../src/tools/media-tools.cjs');
const {test}=require('node:test'); const assert=require('node:assert/strict'); const fs=require('node:fs/promises'); const os=require('node:os');const path=require('node:path');const http=require('node:http');
const {inspectMedia,downloadExternal}=require('../../src/media/external.cjs');
const cp=require('../../src/media/external-checkpoint.cjs');
test('explicit selection pins identity without changing legacy identity',()=>{const info={id:'x',duration:2,format_id:'v',vcodec:'avc1',acodec:'mp4a'};const base=cp.identity(info);assert.equal(cp.identity(info,undefined,undefined),base);assert.notEqual(cp.identity(info,undefined,{mode:'video',videoFormatId:'v',subtitleIds:[]}),base);});
async function fixture(t,info){
  const dir=await fs.mkdtemp(path.join(os.tmpdir(),'flowdm-selection-'));
  const server=http.createServer((q,s)=>s.end('<MPD type="static"><BaseURL>x.mp4</BaseURL></MPD>'));
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(dir,{recursive:true,force:true});});
  const script=path.join(dir,'fake.cjs');
  await fs.writeFile(script,`const fs=require('node:fs');const args=process.argv.slice(2);const data=${JSON.stringify(info)};
    const selector=args[args.indexOf('--format')+1];
    if(args.includes('--dump-single-json')){
      const picked=data.formats.filter(f=>(selector||'').split('+').includes(f.format_id));
      if(picked.length===1){Object.assign(data,picked[0]);delete data.requested_formats;}
      else if(picked.length)data.requested_formats=picked;
      process.stdout.write(JSON.stringify(data));
    }else{fs.writeFileSync(${JSON.stringify(path.join(dir,'args.json'))},JSON.stringify(args));
      const ext=selector==='a'?'m4a':'mp4';const out=args[args.indexOf('-o')+1].replace('%(ext)s',ext);
      fs.writeFileSync(out,'media');process.stdout.write('flowdm-file:'+out);process.stdin.resume();}`);
  return{dir,url:'http://127.0.0.1:'+server.address().port+'/manifest.mpd',tools:{ytDlp:process.execPath,ffmpeg:process.execPath,jsRuntime:process.execPath},toolArgsPrefix:[script]};
}
const info={id:'clip',duration:2,format_id:'v+a',requested_formats:[{format_id:'v',ext:'mp4',vcodec:'avc1',acodec:'none',height:2160,width:3840,protocol:'https'},{format_id:'a',ext:'m4a',vcodec:'none',acodec:'mp4a',protocol:'https'}],formats:[{format_id:'v',ext:'mp4',vcodec:'avc1',acodec:'none',height:2160,width:3840,protocol:'https'},{format_id:'a',ext:'m4a',vcodec:'none',acodec:'mp4a',protocol:'https'}]};
test('DASH inspection exposes safe 4K DTO and exact selected download',async t=>{const f=await fixture(t,info);const catalog=await inspectMedia({...f,mediaType:'dash'});assert.equal(catalog.formats.some(x=>x.height===2160),true);const selection={mode:'video',videoFormatId:'v',audioFormatId:'a',subtitleIds:[]};await downloadExternal({...f,mediaType:'dash',selection,expectedExtension:'mp4',output:path.join(f.dir,'out.part'),maxBytes:10000,validateOutput:async()=>{}});const args=JSON.parse(await fs.readFile(path.join(f.dir,'args.json')));assert.equal(args[args.indexOf('--format')+1],'v+a');});
test('audio-only selection preserves exact audio ID and output validation mode',async t=>{const f=await fixture(t,info);let mode;await downloadExternal({...f,mediaType:'dash',selection:{mode:'audio',audioFormatId:'a',subtitleIds:[]},expectedExtension:'m4a',output:path.join(f.dir,'audio.part'),maxBytes:10000,validateOutput:async(_p,_f,_s,selection)=>{mode=selection.mode;}});assert.equal(mode,'audio');const args=JSON.parse(await fs.readFile(path.join(f.dir,'args.json')));assert.equal(args[args.indexOf('--format')+1],'a');});
test('selected container drift is refused before transfer',async t=>{const f=await fixture(t,info);await assert.rejects(downloadExternal({...f,mediaType:'dash',selection:{mode:'audio',audioFormatId:'a',subtitleIds:[]},expectedExtension:'mp4',output:path.join(f.dir,'audio.part'),maxBytes:10000,validateOutput:async()=>{}}),/container|extension/i);await assert.rejects(fs.stat(path.join(f.dir,'args.json')));});

function runTool(exe,args){return new Promise((resolve,reject)=>require('node:child_process').execFile(exe,args,{windowsHide:true,timeout:60000,maxBuffer:1024*1024},(error,stdout)=>error?reject(error):resolve(stdout)));}
test('native tool DASH inspection and selected video/audio plus audio-only fully decode',async t=>{
 const directory=path.resolve('tests/fixtures/dash');const root=await fs.mkdtemp(path.join(os.tmpdir(),'flowdm-real-select-'));const server=http.createServer(async(req,res)=>{try{const name=new URL(req.url,'http://local').pathname.slice(1);if(name==='subtitle.vtt')return res.end('WEBVTT\n\n00:00:00.000 --> 00:00:02.000\nFlowDM subtitle fixture\n');if(!/^[a-zA-Z0-9_.-]+$/.test(name))return res.writeHead(404).end();res.end(await fs.readFile(path.join(directory,name)));}catch{res.writeHead(404).end();}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(async()=>{server.closeAllConnections();await new Promise(r=>server.close(r));await fs.rm(root,{recursive:true,force:true});});
 const tools=await resolveTools({ packaged: false });const url='http://127.0.0.1:'+server.address().port+'/manifest.mpd';const catalog=await inspectMedia({url,mediaType:'dash',tools});const video=catalog.formats.find(x=>x.hasVideo),audio=catalog.formats.find(x=>x.hasAudio&&!x.hasVideo);assert.ok(video&&audio);
 for(const mode of ['video','audio']){const selection={mode,...(mode==='video'?{videoFormatId:video.id}:{}),audioFormatId:audio.id,subtitleIds:[]};const output=path.join(root,mode+'.part');await downloadExternal({url,mediaType:'dash',tools,selection,expectedExtension:mode==='video'?'mp4':'m4a',output,maxBytes:10*1024*1024,checkpointDir:path.join(root,mode+'.media')});await runTool(tools.ffmpeg,['-v','error','-xerror','-i',output,'-map',mode==='video'?'0:v:0':'0:a:0',...(mode==='video'?['-map','0:a:0']:[]),'-f','null','-']);if(mode==='video'){const scratch=path.join(root,'subtitles.media');await fs.mkdir(scratch);const {embedSubtitles}=require('../../src/media/external-selection.cjs');const subtitled=await embedSubtitles({metadata:{subtitles:{en:[{ext:'vtt',url:url.replace('manifest.mpd','subtitle.vtt')}]}},selection:{...selection,subtitleIds:['manual:en']},produced:output,scratch,tools,maxBytes:10*1024*1024});const text=await runTool(tools.ffmpeg,['-v','error','-i',subtitled,'-map','0:s:0','-f','srt','-']);assert.match(text,/FlowDM subtitle fixture/);await runTool(tools.ffmpeg,['-v','error','-xerror','-i',subtitled,'-map','0:v:0','-map','0:a:0','-f','null','-']);}}
});
