'use strict';
const{test}=require('node:test');const assert=require('node:assert/strict');const fs=require('node:fs/promises');const os=require('node:os');const path=require('node:path');const{downloadExternal}=require('../../src/media/external.cjs');
test('extractor cannot substitute another actual format while retaining the requested ID in its catalog',async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'flowdm-selected-ids-'));t.after(async()=>{assert.equal(path.dirname(root),os.tmpdir());await fs.rm(root,{recursive:true,force:true});});
  const marker=path.join(root,'transfer-started');const script=path.join(root,'extractor.cjs');
  const info={id:'aqz-KE-bpKQ',duration:1,format_id:'wrong',ext:'mp4',protocol:'https',vcodec:'avc1',acodec:'mp4a',width:3840,height:2160,url:'http://fixture.invalid/wrong',formats:[{format_id:'wanted',ext:'mp4',protocol:'https',vcodec:'avc1',acodec:'mp4a',height:720},{format_id:'wrong',ext:'mp4',protocol:'https',vcodec:'avc1',acodec:'mp4a',height:2160}]};
  await fs.writeFile(script,`const fs=require('node:fs');if(process.argv.includes('--dump-single-json'))console.log(${JSON.stringify(JSON.stringify(info))});else{fs.writeFileSync(${JSON.stringify(marker)},'started');process.exitCode=1;}`);
  const cache=path.join(root,'checkpoint');await assert.rejects(downloadExternal({url:'https://www.youtube.com/watch?v=aqz-KE-bpKQ',mediaType:'youtube',selection:{mode:'video',videoFormatId:'wanted',subtitleIds:[]},expectedExtension:'mp4',checkpointDir:cache,output:path.join(root,'output.part'),maxBytes:1024*1024,signal:new AbortController().signal,tools:{ytDlp:process.execPath,ffmpeg:process.execPath,aria2c:process.execPath,jsRuntime:process.execPath},toolArgsPrefix:[script],validateOutput:async()=>{}}),/selected.*format|format.*match/i);
  await assert.rejects(fs.stat(marker),{code:'ENOENT'});await assert.rejects(fs.stat(path.join(cache,'checkpoint.json')),{code:'ENOENT'});
});
