const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
const {backgroundFixture}=require('./extension-fixture.cjs');
test('context menu sends explicit valid URL and ignores blob URLs',async()=>{
 const f=backgroundFixture();f.listeners.installed();assert.equal(f.menus[0].title,'Tải bằng FlowDM');
 await f.listeners.clicked({menuItemId:'flowdm-add',linkUrl:'https://example.com/file'});
 assert.equal(f.messages[0].host,'local.flowdm.bridge');assert.equal(f.messages[0].request.payload.url,'https://example.com/file');assert.match(f.titles[0],/FlowDM/);
 await f.listeners.clicked({menuItemId:'flowdm-add',srcUrl:'blob:abc'});assert.equal(f.messages.length,1);
});
test('settings are persistent and content scripts cannot change capture or credential consent',async()=>{
 const f=backgroundFixture();await f.message({type:'flowdm:settings',autoCapture:false});assert.equal(f.local.autoCapture,false);
 assert.equal((await f.message({type:'flowdm:settings',autoCapture:true},{tab:{id:3}})).ok,false);assert.equal(f.local.autoCapture,false);
 await f.message({type:'flowdm:settings',origin:'https://a.test',credentials:true});assert.equal(f.local.credentials['https://a.test'],true);
 f.chrome.permissions.contains=async()=>false;await f.message({type:'flowdm:settings',origin:'https://b.test',credentials:true});assert.equal(f.local.credentials['https://b.test'],undefined);
 await f.message({type:'flowdm:settings',origin:'https://a.test',credentials:false});assert.equal(f.local.credentials['https://a.test'],undefined);
});
test('network and dynamic content media are listed per tab, deduplicated and cleared on navigation',async()=>{
 const f=backgroundFixture();await f.message({type:'flowdm:media',items:[{url:'https://a.test/v.mp4',mime:'video/mp4'}]},{tab:{id:3}});
 f.listeners.headers({tabId:3,url:'https://a.test/stream?token=abc',responseHeaders:[{name:'Content-Type',value:'application/vnd.apple.mpegurl'}]});
 let state=await f.message({type:'flowdm:state',tabId:3});assert.equal(state.items.length,2);assert.equal(state.items[1].mediaType,'hls');assert.equal(f.messages.length,0);
 assert.equal((await f.message({type:'flowdm:download',tabId:3,url:state.items[1].url,mediaType:'hls'})).ok,true);
 assert.equal((await f.message({type:'flowdm:download',tabId:3,url:'https://a.test/unknown',mediaType:'direct'})).ok,false);
 f.listeners.updated(3,{status:'loading'});state=await f.message({type:'flowdm:state',tabId:3});assert.equal(state.items.length,0);
});
test('bundle helper writes only requested destination and exact extension origin',async t=>{
 const {generateBundle}=require('../../src/bridge/install.cjs');const output=await fs.mkdtemp(path.join(os.tmpdir(),'flowdm-install-'));t.after(()=>fs.rm(output,{recursive:true,force:true}));
 const manifestPath=await generateBundle({outputDir:output,dataDir:output,extensionId:'a'.repeat(32),nodePath:process.execPath});const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
 assert.deepEqual(manifest.allowed_origins,[`chrome-extension://${'a'.repeat(32)}/`]);assert.equal(manifest.name,'local.flowdm.bridge');assert.ok((await fs.stat(manifest.path)).isFile());
 await assert.rejects(generateBundle({outputDir:output,dataDir:output,extensionId:'*',nodePath:process.execPath}));
});
test('background excludes incognito media, accepts explicit DASH and removes tab state',async()=>{
 const f=backgroundFixture();await f.message({type:'flowdm:state',tabId:3});await f.listeners.headers({incognito:true,tabId:3,url:'https://a.test/private.mp4'});
 await f.message({type:'flowdm:media',items:[{url:'https://a.test/video.mpd'}]},{tab:{id:3}});
 assert.equal((await f.message({type:'flowdm:download',tabId:3,url:'https://a.test/video.mpd',mediaType:'dash'})).ok,true);
 assert.equal((await f.message({type:'flowdm:options'},{tab:{id:3}})).items.length,1);
 assert.equal((await f.message({type:'flowdm:options'},{tab:{id:3,incognito:true}})).items.length,0);
 assert.equal((await f.message({type:'flowdm:download',url:'https://a.test/video.mpd',mediaType:'direct'},{tab:{id:3,incognito:true}})).ok,false);
 await f.listeners.removed(3);assert.equal((await f.message({type:'flowdm:state',tabId:3})).items.length,0);
 assert.equal((await f.message({type:'unknown'})).ok,false);
 f.chrome.permissions.contains=async()=>false;await f.listeners.permissionRemoved();assert.deepEqual(f.local.credentials,{});
});
test('content may add only its own canonical YouTube watch page and a user action can hand it off',async()=>{
 const f=backgroundFixture();const sender={id:'test-extension',url:'https://www.youtube.com/watch?v=dQw4w9WgXcQ',tab:{id:7,url:'https://www.youtube.com/watch?v=dQw4w9WgXcQ'}};f.chrome.tabs.get=async()=>sender.tab;
 assert.equal((await f.message({type:'flowdm:youtube',url:'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=ignored',title:'Clip'},sender)).ok,true);
 const state=await f.message({type:'flowdm:state',tabId:7});assert.equal(JSON.stringify(state.items.map(item=>[item.mediaType,item.url])),JSON.stringify([['youtube','https://www.youtube.com/watch?v=dQw4w9WgXcQ']]));
 assert.equal((await f.message({type:'flowdm:download',tabId:7,url:state.items[0].url,mediaType:'youtube'})).ok,true);
 assert.equal((await f.message({type:'flowdm:youtube',url:'https://www.youtube.com/watch?v=aaaaaaaaaaa'},{...sender,tab:{id:7,url:'https://www.youtube.com/watch?v=dQw4w9WgXcQ'}})).ok,false);
 assert.equal((await f.message({type:'flowdm:youtube',url:'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ'},sender)).ok,false);
});
test('trusted popup derives only the current public YouTube page when no media element was detected',async()=>{
 const f=backgroundFixture();f.chrome.tabs.get=async id=>({id,url:'https://m.youtube.com/shorts/dQw4w9WgXcQ?si=ignored',incognito:false});
 const state=await f.message({type:'flowdm:state',tabId:8});assert.equal(JSON.stringify(state.items.map(item=>[item.mediaType,item.url])),JSON.stringify([['youtube','https://www.youtube.com/shorts/dQw4w9WgXcQ']]));assert.equal(f.messages.length,0);assert.equal((await f.message({type:'flowdm:download',tabId:8,url:state.items[0].url,mediaType:'youtube'})).ok,true);
 f.chrome.tabs.get=async id=>({id,url:'https://youtube.com.evil.test/watch?v=dQw4w9WgXcQ',incognito:false});assert.equal((await f.message({type:'flowdm:state',tabId:9})).items.length,0);
 f.chrome.tabs.get=async id=>({id,url:'https://www.youtube.com/watch?v=dQw4w9WgXcQ',incognito:true});assert.equal((await f.message({type:'flowdm:state',tabId:10})).items.length,0);
});
test('trusted popup reconciles YouTube rows after SPA navigation and rejects a stale selection',async()=>{
 const f=backgroundFixture();let url='https://www.youtube.com/watch?v=dQw4w9WgXcQ';f.chrome.tabs.get=async id=>({id,url,incognito:false});
 let state=await f.message({type:'flowdm:state',tabId:11});assert.equal(state.items.filter(item=>item.mediaType==='youtube').length,1);const stale=state.items[0].url;
 url='https://www.youtube.com/watch?v=9bZkp7q19f0';state=await f.message({type:'flowdm:state',tabId:11});assert.equal(JSON.stringify(state.items.filter(item=>item.mediaType==='youtube').map(item=>item.url)),JSON.stringify(['https://www.youtube.com/watch?v=9bZkp7q19f0']));
 assert.equal((await f.message({type:'flowdm:download',tabId:11,url:stale,mediaType:'youtube'})).ok,false);assert.equal(f.messages.length,0);
 url='https://www.youtube.com/';state=await f.message({type:'flowdm:state',tabId:11});assert.equal(state.items.filter(item=>item.mediaType==='youtube').length,0);
});
test('own extension popup tab is trusted while content tab cannot alter settings',async()=>{
 const f=backgroundFixture();const own={id:'test-extension',url:'chrome-extension://test-extension/popup.html',tab:{id:50,url:'chrome-extension://test-extension/popup.html'}};
 assert.ok((await f.message({type:'flowdm:state',tabId:3},own)).settings);
 assert.equal((await f.message({type:'flowdm:settings',autoCapture:false},own)).ok,true);
 assert.equal((await f.message({type:'flowdm:settings',autoCapture:true},{id:'test-extension',url:'https://a.test/page',tab:{id:3}})).ok,false);
});
test('permission removal event invalidates pending cookies even after immediate regrant',async()=>{
 const f=backgroundFixture();await f.message({type:'flowdm:settings',origin:'https://a.test',credentials:true});
 let resolveCookies,started;const began=new Promise(resolve=>{started=resolve;});f.chrome.cookies={getAll(){started();return new Promise(resolve=>{resolveCookies=resolve;});}};
 await f.message({type:'flowdm:media',items:[{url:'https://a.test/video.mp4'}]},{tab:{id:3}});
 const pending=f.message({type:'flowdm:download',tabId:3,url:'https://a.test/video.mp4',mediaType:'direct'});await began;
 const removal=f.listeners.permissionRemoved();await removal;await f.message({type:'flowdm:settings',origin:'https://a.test',credentials:true});resolveCookies([{name:'session',value:'stale-secret'}]);
 assert.equal((await pending).ok,false);assert.equal(f.messages.length,0);
});
test('handoff never invents a Referer from page context',async()=>{
 const f=backgroundFixture();await f.message({type:'flowdm:settings',origin:'https://cdn.test',credentials:true});
 await f.listeners.clicked({menuItemId:'flowdm-add',linkUrl:'https://cdn.test/file.bin',pageUrl:'https://page.test/context#fragment'});assert.equal(f.messages.at(-1).request.payload.headers?.Referer,undefined);
 await f.message({type:'flowdm:media',items:[{url:'https://cdn.test/movie.mp4'}]},{tab:{id:3}});
 await f.message({type:'flowdm:download',url:'https://cdn.test/movie.mp4',mediaType:'direct'},{tab:{id:3,url:'https://page.test/content#fragment'}});assert.equal(f.messages.at(-1).request.payload.headers?.Referer,undefined);
 f.chrome.tabs.get=async()=>({id:3,url:'https://page.test/popup#fragment'});await f.message({type:'flowdm:download',tabId:3,url:'https://cdn.test/movie.mp4',mediaType:'direct'});assert.equal(f.messages.at(-1).request.payload.headers?.Referer,undefined);
});
