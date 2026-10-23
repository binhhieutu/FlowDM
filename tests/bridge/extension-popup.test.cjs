const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');
async function popupFixture({allowed=true,url='https://a.test/page',fail=false,accepted=true,mediaUrl='https://a.test/video.mp4',noMedia=false}={}){
 const elements=new Map();const messages=[];const node=()=>({dataset:{},children:[],append(...items){this.children.push(...items);},replaceChildren(){this.children=[];}});
 const document={querySelector(selector){if(!elements.has(selector))elements.set(selector,node());return elements.get(selector);},createElement:node};
 const state={settings:{autoCapture:true,credentials:{},connections:4},status:'Sẵn sàng',items:[{url:mediaUrl,mediaType:'direct',title:'Film'},{url:'https://a.test/video.mpd',mediaType:'dash'}]};
 if(noMedia)state.items=[];
 const chrome={tabs:{async query(){return [{id:2,url}];}},permissions:{async request(){return allowed;}},runtime:{async sendMessage(message){if(fail)throw Error('offline');messages.push(message);if(message.type==='flowdm:state')return state;if(message.type==='flowdm:settings'){if(typeof message.autoCapture==='boolean')state.settings.autoCapture=message.autoCapture;if(Number.isInteger(message.connections))state.settings.connections=message.connections;if(message.origin)state.settings.credentials[message.origin]=message.credentials;return {ok:true};}return {ok:accepted};}}};
 await vm.runInNewContext(fs.readFileSync(path.resolve('extension/popup.js'),'utf8'),{document,chrome,URL},{filename:path.resolve('extension/popup.js')});
 return {find:name=>document.querySelector(`[data-testid="${name}"]`),messages,state};
}
test('popup shows selectable DASH and persists capture and credential settings',async()=>{
 const f=await popupFixture();assert.equal(f.find('auto-capture').checked,true);assert.equal(f.find('media-list').children.length,2);assert.equal(f.find('media-list').children[1].children[1].disabled,false);
 await f.find('auto-capture').onchange({target:{checked:false}});assert.equal(f.state.settings.autoCapture,false);
 await f.find('credentials').onchange({target:{checked:true}});assert.equal(f.state.settings.credentials['https://a.test'],true);
 await f.find('media-list').children[0].children[1].onclick();assert.equal(f.messages.at(-2).type,'flowdm:download');
});
test('popup honors optional permission denial and reports handoff failure',async()=>{const f=await popupFixture({allowed:false,accepted:false});const target={checked:true};await f.find('credentials').onchange({target});assert.equal(target.checked,false);await f.find('media-list').children[0].children[1].onclick();assert.match(f.find('capture-status').textContent,/Chưa chuyển/);});
test('popup handles unsupported pages, empty detection and connection failure',async()=>{const f=await popupFixture({url:'chrome://settings',noMedia:true});assert.equal(f.find('credentials').disabled,true);const bad=await popupFixture({fail:true});assert.match(bad.find('capture-status').textContent,/Không thể đọc/);});
test('popup can explicitly choose a detected media origin for credential consent',async()=>{
 const f=await popupFixture({mediaUrl:'https://cdn.test/movie.mp4'});const selector=f.find('credential-origin');assert.deepEqual(selector.children.map(option=>option.value),['https://a.test','https://cdn.test']);
 await selector.onchange({target:{value:'https://cdn.test'}});await f.find('credentials').onchange({target:{checked:true}});assert.equal(f.state.settings.credentials['https://cdn.test'],true);assert.equal(f.state.settings.credentials['https://a.test'],undefined);assert.match(f.find('site-origin').textContent,/cdn.test/);
});

test('popup exposes a persistent connection choice for video handoffs',async()=>{
 const f=await popupFixture();assert.equal(f.find('connections').value,'4');
 await f.find('connections').onchange({target:{value:'16'}});
 assert.equal(f.messages.at(-2).connections,16);assert.equal(f.state.settings.connections,16);
});


