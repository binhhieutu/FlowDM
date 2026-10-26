'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');
const {backgroundFixture}=require('../bridge/extension-fixture.cjs');
const vm=require('node:vm'),fs=require('node:fs'),path=require('node:path');
const load=()=>require('../../extension/page-links.js');
test('page link collector canonicalizes unique HTTP anchors while retaining query and Unicode filenames',()=>{
 const {collect}=load();
 const nodes=['/tệp.zip#x','/tệp.zip#again','/file?a=1','/file?a=2','javascript:alert(1)','data:text/plain,a','ftp://x/a','https://user:pass@x/a','http://other.test/public'].map(href=>({getAttribute:()=>href}));
 const result=collect({getElementsByTagName:()=>nodes},'https://site.test/page');
 assert.deepEqual(result.urls,['https://site.test/t%E1%BB%87p.zip','https://site.test/file?a=1','https://site.test/file?a=2','http://other.test/public']);assert.equal(result.truncated,false);
});
test('page link collector bounds rows and payload without reading unbounded anchors',()=>{
 const {collect,normalize}=load();
 const nodes=Array.from({length:1100},(_,i)=>({getAttribute:()=>'/'+i}));
 const result=collect({getElementsByTagName:()=>nodes},'https://site.test');assert.equal(result.urls.length,1000);assert.equal(result.truncated,true);
 assert.equal(normalize('https://u:p@site.test/a'),null);assert.equal(normalize('javascript:bad'),null);assert.equal(normalize('https://site.test/'+ 'a'.repeat(33000)),null);
 const large=Array.from({length:1000},(_,i)=>({getAttribute:()=>'/'+i+'?'+ 'a'.repeat(1000)}));const bounded=collect({getElementsByTagName:()=>large},'https://site.test');assert.ok(bounded.urls.join('\n').length<=512*1024);assert.equal(bounded.truncated,true);
});
function setup(){const f=backgroundFixture();let tab={id:7,url:'https://site.test/page',incognito:false};let links=['https://site.test/a','https://site.test/b?q=1'];
 f.chrome.tabs.query=async()=>[tab];f.chrome.tabs.sendMessage=async(_id,m)=>({urls:links,truncated:false});
 f.chrome.runtime.sendNativeMessage=(host,request,done)=>{f.messages.push({host,request});done({ok:true,request_id:request.request_id,payload:{previewId:'preview-1',count:request.payload.urls.length}});};
 return {f,set tab(v){tab=v;},set links(v){links=v;}};}
test('explicit extension page collection and selected subset stage one native preview, never add jobs or headers',async()=>{
 const {f}=setup();const result=await f.message({type:'flowdm:collectPageLinks',tabId:7});assert.equal(result.ok,true);assert.equal(result.urls.length,2);assert.equal(f.messages.length,0);
 const staged=await f.message({type:'flowdm:previewBatch',tabId:7,urls:[result.urls[1]]});assert.equal(staged.ok,true);assert.equal(staged.count,1);
 const sent=f.messages[0].request;assert.equal(sent.op,'previewBatch');assert.deepEqual(Array.from(sent.payload.urls),['https://site.test/b?q=1']);assert.equal(sent.payload.headers,undefined);
});
test('web content, incognito, inactive tab, uncached URLs and navigation cannot stage native preview',async()=>{
 const s=setup(),{f}=s;const web={id:'test-extension',url:'https://site.test/page',tab:{id:7,url:'https://site.test/page'}};
 assert.equal((await f.message({type:'flowdm:collectPageLinks',tabId:7},web)).ok,false);
 assert.equal((await f.message({type:'flowdm:previewBatch',tabId:7,urls:['https://site.test/a']})).ok,false);
 await f.message({type:'flowdm:collectPageLinks',tabId:7});
 for(const urls of [[],['https://evil.test/injected'],['https://site.test/a','https://site.test/a']])assert.equal((await f.message({type:'flowdm:previewBatch',tabId:7,urls})).ok,false);
 s.tab={id:8,url:'https://site.test/page'};assert.equal((await f.message({type:'flowdm:previewBatch',tabId:7,urls:['https://site.test/a']})).ok,false);
 s.tab={id:7,url:'https://site.test/changed'};assert.equal((await f.message({type:'flowdm:previewBatch',tabId:7,urls:['https://site.test/a']})).ok,false);
 s.tab={id:7,url:'https://site.test/page',incognito:true};assert.equal((await f.message({type:'flowdm:collectPageLinks',tabId:7})).ok,false);assert.equal(f.messages.length,0);
});
test('navigation while collecting and wrong native acknowledgements leave no usable preview',async()=>{
 const {f}=setup();let release;f.chrome.tabs.sendMessage=()=>new Promise(r=>release=r);
 const pending=f.message({type:'flowdm:collectPageLinks',tabId:7});await new Promise(r=>setImmediate(r));await f.listeners.updated(7,{status:'loading'});release({urls:['https://site.test/a']});assert.equal((await pending).ok,false);
 f.chrome.tabs.sendMessage=async()=>({urls:['https://site.test/a']});await f.message({type:'flowdm:collectPageLinks',tabId:7});
 f.chrome.runtime.sendNativeMessage=(_host,request,done)=>done({ok:true,request_id:'wrong',payload:{previewId:'p',count:1}});
 assert.equal((await f.message({type:'flowdm:previewBatch',tabId:7,urls:['https://site.test/a']})).ok,false);
});
test('content page collection is read-only and popup exposes an unchecked preview flow',()=>{
 const html=fs.readFileSync(path.resolve('extension/popup.html'),'utf8'),popup=fs.readFileSync(path.resolve('extension/popup.js'),'utf8');
 for(const id of ['collect-page-links','page-links-filter','page-links-all','page-links-list','preview-page-links','page-links-status'])assert.match(html,new RegExp('data-testid="'+id+'"'));
 assert.match(popup,/flowdm:collectPageLinks/);assert.match(popup,/flowdm:previewBatch/);
 const messages=[];let listener;const document={documentElement:{},querySelectorAll:()=>[],getElementsByTagName:()=>[{getAttribute:()=>'/a'}],addEventListener(){}};
 const chrome={runtime:{id:'test-extension',onMessage:{addListener(fn){listener=fn;}},sendMessage:m=>{messages.push(m);return Promise.resolve({});}}};
 const c=vm.createContext({chrome,document,location:{href:'https://site.test/page'},MutationObserver:class{observe(){}},queueMicrotask,WeakMap,URL});
 for(const file of ['media.js','page-links.js','content.js'])vm.runInContext(fs.readFileSync(path.resolve('extension',file),'utf8'),c);
 assert.equal(messages.length,0);let result;listener({type:'flowdm:readPageLinks'},{id:'test-extension'},r=>result=r);assert.equal(result.urls[0],'https://site.test/a');assert.equal(messages.length,0);
});

test('collection follows the rendered document base URL without evaluating code',()=>{
 const {collect}=load();
 const result=collect({baseURI:'https://cdn.test/files/',getElementsByTagName:()=>[{getAttribute:()=> 'download.zip'}]},'https://site.test/page');
 assert.deepEqual(result.urls,['https://cdn.test/files/download.zip']);
});
test('popup requires trusted collection, starts unchecked and sends only filtered user selection to desktop preview',async()=>{
 const elements=new Map(),messages=[];
 const node=tag=>({tag,children:[],value:'',textContent:'',checked:false,disabled:false,hidden:false,append(...children){this.children.push(...children);},replaceChildren(...children){this.children=children;}});
 const document={createElement:node,querySelector(selector){if(!elements.has(selector))elements.set(selector,node());return elements.get(selector);}};
 const chrome={tabs:{query:async()=>[{id:7,url:'https://site.test/page'}]},runtime:{sendMessage:async m=>{messages.push(m);if(m.type==='flowdm:state')return{settings:{connections:4,credentials:{},autoCapture:true},items:[],status:'Ready'};if(m.type==='flowdm:collectPageLinks')return{ok:true,urls:['https://site.test/a.zip','https://site.test/b.txt']};if(m.type==='flowdm:previewBatch')return{ok:true,count:m.urls.length};}}};
 await vm.runInNewContext(fs.readFileSync(path.resolve('extension/popup.js'),'utf8'),{chrome,document,URL});
 const get=name=>document.querySelector('[data-testid="'+name+'"]');
 assert.equal(messages.some(m=>m.type==='flowdm:collectPageLinks'),false);
 await get('collect-page-links').onclick({isTrusted:false});assert.equal(messages.length,1);
 await get('collect-page-links').onclick({isTrusted:true});assert.equal(get('preview-page-links').disabled,true);
 assert.equal(get('page-links-list').children.length,2);assert.equal(get('page-links-list').children.every(row=>row.children[0].checked===false),true);
 get('page-links-filter').value='.zip';get('page-links-filter').oninput();get('page-links-all').onchange({target:{checked:true}});
 await get('preview-page-links').onclick({isTrusted:true});
 assert.deepEqual(Array.from(messages.find(m=>m.type==='flowdm:previewBatch').urls),['https://site.test/a.zip']);
 assert.equal(messages.some(m=>m.type==='flowdm:download'),false);
});
