const {test}=require('node:test');
const assert=require('node:assert/strict');
const {createCapture}=require('../../extension/capture.js');
function fixture({reply='ok',paused=true,timeout=20}={}) {
 const calls=[];let callback;const item={id:7,url:'https://example.com/file',state:'in_progress',danger:'safe',paused};
 const chrome={runtime:{lastError:null,sendNativeMessage(host,request,done){calls.push('send');callback=()=>done(reply==='ok'?{ok:true,request_id:request.request_id,payload:{id:'queued-1'}}:reply==='wrong'?{ok:true,request_id:'wrong'}:{ok:false});if(reply!=='timeout')callback();}},downloads:{pause(id,done){calls.push('pause');done();},resume(id,done){calls.push('resume');done();},cancel(id,done){calls.push('cancel');done();},search(q,done){done([item]);}}};
 return {calls,item,late:()=>callback(),capture:createCapture(chrome,{timeoutMs:timeout,uuid:()=> 'request-1'})};
}
test('capture pauses, waits for matching native acknowledgement then cancels',async()=>{const f=fixture();assert.equal(await f.capture.automatic(f.item),true);assert.deepEqual(f.calls,['pause','send','cancel']);});
for(const reply of ['error','wrong','timeout'])test(`capture resumes on ${reply} without cancellation`,async()=>{const f=fixture({reply});assert.equal(await f.capture.automatic(f.item),false);assert.deepEqual(f.calls,['pause','send','resume']);if(reply==='timeout'){f.late();assert.ok(!f.calls.includes('cancel'));}});
test('completed browser download or failed pause never hands off',async()=>{const f=fixture({paused:false});assert.equal(await f.capture.automatic(f.item),false);assert.deepEqual(f.calls,['pause']);});
test('unsafe, incognito, disabled downloads are left alone',async()=>{for(const extra of [{url:'blob:abc'},{incognito:true},{danger:'dangerous'},{state:'complete'}]){const f=fixture();await f.capture.automatic({...f.item,...extra});assert.deepEqual(f.calls,[]);}const f=fixture();f.capture.settings.autoCapture=false;await f.capture.automatic(f.item);assert.deepEqual(f.calls,[]);});
test('duplicate onCreated events cannot hand off twice',async()=>{const f=fixture();await Promise.all([f.capture.automatic(f.item),f.capture.automatic(f.item)]);assert.equal(f.calls.filter(x=>x==='send').length,1);});
test('browser completing during ack is never canceled',async()=>{const f=fixture({reply:'timeout'});const pending=f.capture.automatic(f.item);await new Promise(resolve=>setImmediate(resolve));f.item.state='complete';f.late();assert.equal(await pending,false);assert.ok(!f.calls.includes('cancel'));});

test('POST downloads never transfer ownership and headers require per-origin consent',async()=>{const f=fixture();f.capture.remember({url:f.item.url,method:'POST',requestHeaders:[]});await f.capture.automatic(f.item);assert.deepEqual(f.calls,[]);});
test('missing durable task id is not accepted',async()=>{const f=fixture({reply:'wrong'});await f.capture.automatic(f.item);assert.ok(f.calls.includes('resume'));});
test('credential headers are collected only after origin consent and revoked immediately',async()=>{
 const requests=[];const chrome={runtime:{sendNativeMessage(host,request,done){requests.push(request);done({ok:true,request_id:request.request_id,payload:{id:'task'}});}}};
 const c=createCapture(chrome,{uuid:()=> 'req',userAgent:()=>''});const details={url:'https://a.test/movie',method:'GET',requestHeaders:[{name:'Cookie',value:'session=secret'},{name:'Authorization',value:'Bearer secret'},{name:'X-Unsafe',value:'no'}]};
 c.remember(details);await c.send({url:details.url});assert.equal(requests.at(-1).payload.headers,undefined);
 c.settings.credentials['https://a.test']=true;await c.send({url:details.url});assert.equal(requests.at(-1).payload.headers,undefined);
 c.remember(details);await c.send({url:details.url,filename:'C:\\Downloads\\movie.mp4'});assert.deepEqual(requests.at(-1).payload.headers,{Cookie:'session=secret',Authorization:'Bearer secret'});assert.equal(requests.at(-1).payload.filename,'movie.mp4');
 await c.send({url:'https://other.test/movie'});assert.equal(requests.at(-1).payload.headers,undefined);
 c.revoke('https://a.test');await c.send({url:details.url});assert.equal(requests.at(-1).payload.headers,undefined);
});
test('authenticated browser downloads without consent stay entirely in browser',async()=>{
 const f=fixture();f.capture.remember({url:f.item.url,method:'GET',requestHeaders:[{name:'Cookie',value:'private-cookie'},{name:'Authorization',value:'private-token'}]});
 assert.equal(await f.capture.automatic(f.item),false);assert.deepEqual(f.calls,[]);
});
test('auto capture uses the filename available after pause',async()=>{
 let sent;const current={id:9,state:'in_progress',paused:true,filename:'C:\\Downloads\\response-name.zip'};
 const chrome={runtime:{sendNativeMessage(host,request,done){sent=request;done({ok:true,request_id:request.request_id,payload:{id:'task'}});}},downloads:{pause(id,done){done();},search(query,done){done([current]);},cancel(id,done){done();}}};
 const capture=createCapture(chrome,{uuid:()=> 'req',userAgent:()=>''});await capture.automatic({id:9,url:'https://a.test/attachment',state:'in_progress',danger:'safe',filename:''});assert.equal(sent.payload.filename,'response-name.zip');
});
test('explicit handoff can obtain consented cookies without page reload',async()=>{
 const requests=[];const cookieCalls=[];const chrome={permissions:{async contains(){return true;}},cookies:{async getAll(details){cookieCalls.push(details.url);return [{name:'session',value:'current-value'},{name:'unsafe;name',value:'bad'}];}},runtime:{sendNativeMessage(host,request,done){requests.push(request);done({ok:true,request_id:request.request_id,payload:{id:'task'}});}}};
 const capture=createCapture(chrome,{uuid:()=> 'req',userAgent:()=>''});await capture.send({url:'https://a.test/video'});assert.equal(cookieCalls.length,0);assert.equal(requests[0].payload.headers,undefined);
 capture.settings.credentials['https://a.test']=true;await capture.send({url:'https://a.test/video'});assert.equal(cookieCalls.length,1);assert.deepEqual(requests[1].payload.headers,{Cookie:'session=current-value'});
});
test('cookie optional permission denial and revocation during lookup never leak cookies',async()=>{
 const requests=[];let allowed=false;let capture;const chrome={permissions:{async contains(){return allowed;}},cookies:{async getAll(){capture.revoke('https://a.test');return [{name:'session',value:'secret'}];}},runtime:{sendNativeMessage(host,request,done){requests.push(request);done({ok:true,request_id:request.request_id,payload:{id:'task'}});}}};
 capture=createCapture(chrome,{uuid:()=> 'req',userAgent:()=>''});capture.settings.credentials['https://a.test']=true;await capture.send({url:'https://a.test/video'});assert.equal(requests.length,0);
 allowed=true;assert.equal(await capture.send({url:'https://a.test/video'}),false);assert.equal(requests.length,0);
});
test('revoke then re-enable during cookie lookup aborts the old handoff',async()=>{
 let resolveCookies,started;const began=new Promise(resolve=>{started=resolve;});const requests=[];
 const chrome={permissions:{async contains(){return true;}},cookies:{getAll(){started();return new Promise(resolve=>{resolveCookies=resolve;});}},runtime:{sendNativeMessage(host,request,done){requests.push(request);done({ok:true,request_id:request.request_id,payload:{id:'task'}});}}};
 const c=createCapture(chrome);c.settings.credentials['https://a.test']=true;const pending=c.send({url:'https://a.test/video'});await began;c.revoke('https://a.test');c.settings.credentials['https://a.test']=true;resolveCookies([{name:'session',value:'stale-secret'}]);assert.equal(await pending,false);assert.equal(requests.length,0);
});
test('permission removal during cookie lookup resumes automatic browser download without native send',async()=>{
 let resolveCookies,started;const began=new Promise(resolve=>{started=resolve;});const calls=[];let allowed=true;
 const item={id:10,url:'https://a.test/file',danger:'safe',state:'in_progress',paused:true};
 const chrome={permissions:{async contains(){return allowed;}},cookies:{getAll(){started();return new Promise(resolve=>{resolveCookies=resolve;});}},runtime:{sendNativeMessage(){calls.push('send');}},downloads:{pause(id,done){calls.push('pause');done();},search(q,done){done([item]);},resume(id,done){calls.push('resume');done();},cancel(id,done){calls.push('cancel');done();}}};
 const c=createCapture(chrome);c.settings.credentials['https://a.test']=true;const pending=c.automatic(item);await began;allowed=false;c.permissionsRemoved();resolveCookies([{name:'session',value:'secret'}]);assert.equal(await pending,false);assert.deepEqual(calls,['pause','resume']);
});

test('automatic capture retries a transient onCreated pause error after filename assignment',async()=>{
 const calls=[];let attempts=0;const item={id:12,url:'https://a.test/file',state:'in_progress',danger:'safe',paused:false,filename:''};
 const chrome={runtime:{lastError:null,sendNativeMessage(host,request,done){calls.push(['send',request.payload.filename]);done({ok:true,request_id:request.request_id,payload:{id:'task'}});}},downloads:{pause(id,done){attempts++;calls.push(['pause']);if(attempts===1){chrome.runtime.lastError={message:'Download must be in progress'};done();chrome.runtime.lastError=null;item.filename='C:\\Downloads\\assigned.zip';}else{item.paused=true;done();}},search(q,done){done([{...item}]);},cancel(id,done){calls.push(['cancel']);done();}}};
 const c=createCapture(chrome,{pauseRetryMs:1});assert.equal(await c.automatic({...item}),true);assert.equal(attempts,2);assert.deepEqual(calls,[['pause'],['pause'],['send','assigned.zip'],['cancel']]);
});
test('pause retry stops if browser completes, and a failed first event does not poison its id',async()=>{
 let mayPause=false;let completed=true;let attempts=0;const item={id:15,url:'https://a.test/file',danger:'safe',state:'in_progress',paused:true};
 const chrome={runtime:{lastError:null,sendNativeMessage(host,request,done){done({ok:true,request_id:request.request_id,payload:{id:'task'}});}},downloads:{pause(id,done){attempts++;if(!mayPause)chrome.runtime.lastError={message:'Download must be in progress'};done();chrome.runtime.lastError=null;},search(q,done){done([{...item,state:completed?'complete':'in_progress'}]);},cancel(id,done){done();}}};
 const c=createCapture(chrome,{pauseRetryMs:1});assert.equal(await c.automatic(item),false);assert.equal(attempts,1);mayPause=true;completed=false;assert.equal(await c.automatic(item),true);assert.equal(attempts,2);
});
test('consented handoff derives only User-Agent and preserves actually observed Referer',async()=>{
 const requests=[];const chrome={runtime:{sendNativeMessage(host,request,done){requests.push(request);done({ok:true,request_id:request.request_id,payload:{id:'task'}});}}};
 const c=createCapture(chrome,{userAgent:()=> 'Chrome fixture'});const input={url:'https://cdn.test/movie.mp4',referrer:'https://page.test/watch?v=1#secret'};
 await c.send(input);assert.equal(requests[0].payload.headers,undefined);c.settings.credentials['https://cdn.test']=true;await c.send(input);assert.deepEqual(requests[1].payload.headers,{'User-Agent':'Chrome fixture'});
 c.remember({url:input.url,method:'GET',requestHeaders:[{name:'Referer',value:'https://observed.test/'},{name:'User-Agent',value:'Observed UA'}]});await c.send(input);assert.deepEqual(requests[2].payload.headers,{Referer:'https://observed.test/','User-Agent':'Observed UA'});
});

test('cross-origin page query secrets never become an invented Referer',async()=>{
 let request;const chrome={runtime:{sendNativeMessage(host,value,done){request=value;done({ok:true,request_id:value.request_id,payload:{id:'task'}});}}};
 const c=createCapture(chrome,{userAgent:()=> 'Browser UA'});c.settings.credentials['https://cdn.test']=true;await c.send({url:'https://cdn.test/movie.mp4',referrer:'https://private.test/watch?access_token=do-not-forward#fragment'});assert.equal(request.payload.headers.Referer,undefined);assert.equal(request.payload.headers['User-Agent'],'Browser UA');
});

