if(typeof importScripts==='function')importScripts('capture.js','media.js','page-links.js');
const extensionAPI=globalThis.browser||chrome;
const captureAPI=globalThis.browser?{runtime:chrome.runtime,downloads:chrome.downloads,get permissions(){return extensionAPI.permissions;},get cookies(){return extensionAPI.cookies;}}:chrome;
const extensionBase=extensionAPI.runtime.getURL?extensionAPI.runtime.getURL(''):'chrome-extension://'+extensionAPI.runtime.id+'/';
const extensionAction=extensionAPI.action||extensionAPI.browserAction;
const credentialRequestsCache=new Map();
const pageLinkCache=new Map(),pageLinkEpochs=new Map();
let status='Sẵn sàng';
const capture=FlowDMCapture.createCapture(captureAPI,{automaticMode:extensionBase.startsWith('moz-extension://')?'ack-before-cancel':'pause-before-ack',onStatus:text=>{
 status=text;extensionAction.setBadgeText({text:text.startsWith('Đã')?'✓':'!'});
 extensionAction.setBadgeBackgroundColor({color:text.startsWith('Đã')?'#087f8c':'#aa5a10'});
 extensionAction.setTitle({title:`FlowDM: ${text}`});
}});
const media=FlowDMMedia.createMediaStore();
const ready=Promise.all([extensionAPI.storage.local.get({autoCapture:true,credentials:{},connections:4}),extensionAPI.storage.session.get({detectedMedia:[]})]).then(async([saved,session])=>{
 Object.assign(capture.settings,saved);media.restore(session.detectedMedia);
 capture.settings.connections=Number.isInteger(capture.settings.connections)&&capture.settings.connections>=1&&capture.settings.connections<=16?capture.settings.connections:4;
 const allowed=await extensionAPI.permissions.contains({permissions:['cookies']});
 if(!allowed)capture.settings.credentials={};
});
function persistMedia(){return extensionAPI.storage.session.set({detectedMedia:media.snapshot()});}
function clearCredentialRequests(tabId){for(const [key,value]of credentialRequestsCache)if(value.tabId===tabId)credentialRequestsCache.delete(key);}
async function currentCredentialTab(tabId,origin){
 if(!Number.isInteger(tabId)||tabId<0||!FlowDMCapture.httpUrl(origin)||new URL(origin).origin!==origin||!extensionAPI.tabs.query)return false;
 try{const tabs=await extensionAPI.tabs.query({active:true,currentWindow:true});return tabs.some(tab=>tab.id===tabId&&!tab.incognito&&FlowDMCapture.httpUrl(tab.url)&&new URL(tab.url).origin===origin);}catch{return false;}
}
async function credentialsMessage(message){
 const list=message.type==='flowdm:credentialRequests';
 const keys=list?['type','origin','tabId']:['type','origin','tabId','taskId','requestId'];
 if(Object.keys(message).some(key=>!keys.includes(key))||!await currentCredentialTab(message.tabId,message.origin))return {ok:false};
 const key=message.tabId+':'+message.origin;
 if(list){
  credentialRequestsCache.delete(key);const stamp=capture.context(message.origin);
  const result=await capture.listCredentialRequests(message.origin,{isCurrent:()=>currentCredentialTab(message.tabId,message.origin)});
  if(!result.ok||!capture.current(stamp))return {ok:false,error:result.error};
  while(credentialRequestsCache.size>=16)credentialRequestsCache.delete(credentialRequestsCache.keys().next().value);
  credentialRequestsCache.set(key,{tabId:message.tabId,stamp,requests:result.requests});return result;
 }
 const saved=credentialRequestsCache.get(key);const challenge=saved?.requests.find(value=>value.requestId===message.requestId&&value.taskId===message.taskId);
 if(!challenge||!capture.current(saved.stamp))return {ok:false,error:'Yêu cầu đã hết hạn. Tìm lại tác vụ trong FlowDM.'};
 credentialRequestsCache.set(key,{...saved,requests:saved.requests.filter(value=>value!==challenge)});
 return capture.rebindCredentials(challenge,{isCurrent:async()=>capture.current(saved.stamp)&&await currentCredentialTab(message.tabId,message.origin)});
}
async function stateItems(tabId, extensionPage){
 const items=media.list(tabId);if(!extensionPage||!Number.isInteger(tabId)||!extensionAPI.tabs.get)return items;
 try{
  const tab=await extensionAPI.tabs.get(tabId);const youtube=!tab?.incognito&&FlowDMMedia.youtubeUrl(tab?.url);
  const reconciled=media.reconcileYoutube(tabId,youtube||null);if(JSON.stringify(items)!==JSON.stringify(reconciled))await persistMedia();return reconciled;
 }catch{}
 return items;
}
extensionAPI.runtime.onInstalled.addListener(()=>extensionAPI.contextMenus.create({id:'flowdm-add',title:'Tải bằng FlowDM',contexts:['link','video','audio'],targetUrlPatterns:['http://*/*','https://*/*']}));
extensionAPI.contextMenus.onClicked.addListener(async info=>{if(info.menuItemId==='flowdm-add'){await ready;await capture.send({url:info.linkUrl||info.srcUrl});}});
extensionAPI.downloads.onCreated.addListener(async item=>{await ready;await capture.automatic(item);});
extensionAPI.webRequest.onBeforeSendHeaders.addListener(details=>{if(!details.incognito)capture.remember(details);},{urls:['http://*/*','https://*/*']},extensionBase.startsWith('moz-extension://')?['requestHeaders']:['requestHeaders','extraHeaders']);
extensionAPI.webRequest.onHeadersReceived.addListener(async details=>{
 await ready;
 if(details.incognito)return;
 const mime=details.responseHeaders?.find(h=>h.name.toLowerCase()==='content-type')?.value||'';
 media.add(details.tabId,{url:details.url,mime});await persistMedia();
},{urls:['http://*/*','https://*/*']},['responseHeaders']);
extensionAPI.tabs.onUpdated.addListener(async(id,change)=>{if(change.status==='loading'){clearCredentialRequests(id);pageLinkCache.delete(id);pageLinkEpochs.set(id,(pageLinkEpochs.get(id)||0)+1);}await ready;if(change.status==='loading'){media.clear(id);await persistMedia();}});
extensionAPI.tabs.onRemoved.addListener(async id=>{clearCredentialRequests(id);pageLinkCache.delete(id);pageLinkEpochs.delete(id);await ready;media.clear(id);await persistMedia();});
extensionAPI.permissions.onRemoved.addListener(async()=>{credentialRequestsCache.clear();capture.permissionsRemoved();await ready;capture.permissionsRemoved();await extensionAPI.storage.local.set(capture.settings);});
extensionAPI.runtime.onMessage.addListener((message,sender,respond)=>{
 (async()=>{
  await ready;
  const extensionPage=sender.id===extensionAPI.runtime.id&&typeof sender.url==='string'&&sender.url.startsWith(extensionBase);
  if(message?.type==='flowdm:media'){
   if(sender.tab&&!sender.tab.incognito)for(const item of (Array.isArray(message.items)?message.items:[]).slice(0,30))media.add(sender.tab.id,item);
   await persistMedia();return {ok:true};
  }
  if(message?.type==='flowdm:youtube'){
   if(!sender.tab||sender.tab.incognito)return {ok:false};
   const requested=FlowDMMedia.youtubeUrl(message.url);const page=FlowDMMedia.youtubeUrl(sender.tab.url);
   if(!requested||requested!==page)return {ok:false};
   media.add(sender.tab.id,{url:requested,mediaType:'youtube',title:message.title});await persistMedia();return {ok:true};
  }
  if(message?.type==='flowdm:options')return {items:sender.tab&&!sender.tab.incognito?media.list(sender.tab.id):[]};
  // Content scripts may request only a previously detected media URL for their own tab.
  if(!extensionPage&&message?.type!=='flowdm:download')return {ok:false};
  if(['flowdm:collectPageLinks','flowdm:previewBatch'].includes(message?.type))return pageLinksMessage(message);
  if(['flowdm:credentialRequests','flowdm:rebindCredentials'].includes(message?.type))return credentialsMessage(message);
  if(message?.type==='flowdm:state')return {settings:capture.settings,status,items:await stateItems(message.tabId,extensionPage)};
  if(message?.type==='flowdm:settings'){
   if(Object.hasOwn(message,'connections')){if(!Number.isInteger(message.connections)||message.connections<1||message.connections>16)return {ok:false};capture.settings.connections=message.connections;}
   if(typeof message.autoCapture==='boolean')capture.settings.autoCapture=message.autoCapture;
   const origin=FlowDMCapture.httpUrl(message.origin);
   if(origin&&typeof message.credentials==='boolean'){
    const key=new URL(origin).origin;
    if(message.credentials){const stamp=capture.context(key);const allowed=await extensionAPI.permissions.contains({permissions:['cookies'],origins:[`${key}/*`]});if(allowed&&capture.current(stamp))capture.grant(key);}
    else {capture.revoke(key);for(const [cacheKey,saved]of credentialRequestsCache)if(saved.stamp.origin===key)credentialRequestsCache.delete(cacheKey);}
   }
   await extensionAPI.storage.local.set(capture.settings);return {ok:true};
  }
  if(message?.type==='flowdm:download'){
   if(sender.tab&&!extensionPage){if(sender.tab.incognito)return {ok:false};message={...message,tabId:sender.tab.id};}
   if(!['hls','direct','dash','youtube'].includes(message.mediaType))return {ok:false,error:'Loại video chưa được hỗ trợ.'};
   const url=FlowDMCapture.httpUrl(message.url);if(!url)return {ok:false};const normalized=new URL(url);normalized.hash='';
   if(message.mediaType==='youtube'){
    try{const tab=await extensionAPI.tabs.get(message.tabId);if(tab?.incognito||FlowDMMedia.youtubeUrl(tab?.url)!==normalized.href)return {ok:false};}catch{return {ok:false};}
   }
   if(!media.list(message.tabId).some(x=>x.url===normalized.href&&x.mediaType===message.mediaType))return {ok:false};
   return {ok:await capture.send(message)};
  }
  return {ok:false};
 })().then(respond,()=>respond({ok:false,error:'Không thể kết nối FlowDM.'}));return true;
});
async function currentPageLinksTab(tabId){
 if(!Number.isInteger(tabId)||tabId<0||!extensionAPI.tabs.query)return null;
 const tabs=await extensionAPI.tabs.query({active:true,currentWindow:true});
 const tab=tabs.find(value=>value.id===tabId&&!value.incognito&&FlowDMPageLinks.normalize(value.url));
 return tab?{id:tab.id,url:tab.url}:null;
}
async function pageLinksMessage(message){
 const collecting=message.type==='flowdm:collectPageLinks';
 const keys=collecting?['type','tabId']:['type','tabId','urls'];
 if(Object.keys(message).some(key=>!keys.includes(key)))return {ok:false};
 const tab=await currentPageLinksTab(message.tabId);if(!tab)return {ok:false,error:'Mở lại tiện ích trên trang HTTP(S) đang hoạt động.'};
 if(collecting){
  pageLinkCache.delete(tab.id);const epoch=pageLinkEpochs.get(tab.id)||0;
  const result=await extensionAPI.tabs.sendMessage(tab.id,{type:'flowdm:readPageLinks'},{frameId:0});
  const current=await currentPageLinksTab(tab.id);
  if(!current||current.url!==tab.url||(pageLinkEpochs.get(tab.id)||0)!==epoch)return {ok:false,error:'Trang đã thay đổi. Lấy lại liên kết.'};
  if(!Array.isArray(result?.urls)||result.urls.length>1000)return {ok:false};
  const urls=result.urls.filter(url=>FlowDMPageLinks.normalize(url)===url);
  if(new Set(urls).size!==urls.length||urls.join('\n').length>512*1024)return {ok:false};
  while(pageLinkCache.size>=32)pageLinkCache.delete(pageLinkCache.keys().next().value);
  pageLinkCache.set(tab.id,{pageUrl:tab.url,urls});return {ok:true,urls,truncated:result.truncated===true};
 }
 const saved=pageLinkCache.get(tab.id),urls=message.urls;
 if(!saved||saved.pageUrl!==tab.url||!Array.isArray(urls)||!urls.length||urls.length>1000||new Set(urls).size!==urls.length||urls.some(url=>!saved.urls.includes(url))||urls.join('\n').length>512*1024)return {ok:false,error:'Chọn liên kết đã lấy từ trang hiện tại.'};
 const request_id=crypto.randomUUID();
 const request={schema:1,request_id,op:'previewBatch',payload:{urls:[...urls]}};
 return new Promise(resolve=>{
  let done=false;const finish=value=>{if(done)return;done=true;clearTimeout(timer);resolve(value);};
  const timer=setTimeout(()=>finish({ok:false,error:'FlowDM chưa trả lời. Mở ứng dụng rồi thử lại.'}),5000);
  try{captureAPI.runtime.sendNativeMessage('local.flowdm.bridge',request,response=>{
   const error=captureAPI.runtime.lastError;
   if(error||response?.ok!==true||response.request_id!==request_id||typeof response.payload?.previewId!=='string'||!response.payload.previewId||response.payload.count!==urls.length)return finish({ok:false,error:'Chưa mở được bản xem trước. Mở FlowDM và kiểm tra cầu nối.'});
   finish({ok:true,previewId:response.payload.previewId,count:response.payload.count});
  });}catch{finish({ok:false,error:'Không thể kết nối FlowDM.'});}
 });
}
