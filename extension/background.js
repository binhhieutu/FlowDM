importScripts('capture.js','media.js');
let status='Sẵn sàng';
const capture=FlowDMCapture.createCapture(chrome,{onStatus:text=>{
 status=text;chrome.action.setBadgeText({text:text.startsWith('Đã')?'✓':'!'});
 chrome.action.setBadgeBackgroundColor({color:text.startsWith('Đã')?'#087f8c':'#aa5a10'});
 chrome.action.setTitle({title:`FlowDM: ${text}`});
}});
const media=FlowDMMedia.createMediaStore();
const ready=Promise.all([chrome.storage.local.get({autoCapture:true,credentials:{}}),chrome.storage.session.get({detectedMedia:[]})]).then(async([saved,session])=>{
 Object.assign(capture.settings,saved);media.restore(session.detectedMedia);
 const allowed=await chrome.permissions.contains({permissions:['cookies']});
 if(!allowed)capture.settings.credentials={};
});
function persistMedia(){return chrome.storage.session.set({detectedMedia:media.snapshot()});}
async function stateItems(tabId, extensionPage){
 const items=media.list(tabId);if(!extensionPage||!Number.isInteger(tabId)||!chrome.tabs.get)return items;
 try{
  const tab=await chrome.tabs.get(tabId);const youtube=!tab?.incognito&&FlowDMMedia.youtubeUrl(tab?.url);
  const reconciled=media.reconcileYoutube(tabId,youtube||null);if(JSON.stringify(items)!==JSON.stringify(reconciled))await persistMedia();return reconciled;
 }catch{}
 return items;
}
chrome.runtime.onInstalled.addListener(()=>chrome.contextMenus.create({id:'flowdm-add',title:'Tải bằng FlowDM',contexts:['link','video','audio'],targetUrlPatterns:['http://*/*','https://*/*']}));
chrome.contextMenus.onClicked.addListener(async info=>{if(info.menuItemId==='flowdm-add'){await ready;await capture.send({url:info.linkUrl||info.srcUrl});}});
chrome.downloads.onCreated.addListener(async item=>{await ready;await capture.automatic(item);});
chrome.webRequest.onBeforeSendHeaders.addListener(details=>{if(!details.incognito)capture.remember(details);},{urls:['http://*/*','https://*/*']},['requestHeaders','extraHeaders']);
chrome.webRequest.onHeadersReceived.addListener(async details=>{
 await ready;
 if(details.incognito)return;
 const mime=details.responseHeaders?.find(h=>h.name.toLowerCase()==='content-type')?.value||'';
 media.add(details.tabId,{url:details.url,mime});await persistMedia();
},{urls:['http://*/*','https://*/*']},['responseHeaders']);
chrome.tabs.onUpdated.addListener(async(id,change)=>{await ready;if(change.status==='loading'){media.clear(id);await persistMedia();}});
chrome.tabs.onRemoved.addListener(async id=>{await ready;media.clear(id);await persistMedia();});
chrome.permissions.onRemoved.addListener(async()=>{capture.permissionsRemoved();await ready;capture.permissionsRemoved();await chrome.storage.local.set(capture.settings);});
chrome.runtime.onMessage.addListener((message,sender,respond)=>{
 (async()=>{
  await ready;
  const extensionPage=sender.id===chrome.runtime.id&&typeof sender.url==='string'&&sender.url.startsWith('chrome-extension://'+chrome.runtime.id+'/');
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
  if(message?.type==='flowdm:state')return {settings:capture.settings,status,items:await stateItems(message.tabId,extensionPage)};
  if(message?.type==='flowdm:settings'){
   if(typeof message.autoCapture==='boolean')capture.settings.autoCapture=message.autoCapture;
   const origin=FlowDMCapture.httpUrl(message.origin);
   if(origin&&typeof message.credentials==='boolean'){
    const key=new URL(origin).origin;
    if(message.credentials){const stamp=capture.context(key);const allowed=await chrome.permissions.contains({permissions:['cookies'],origins:[`${key}/*`]});if(allowed&&capture.current(stamp))capture.grant(key);}
    else capture.revoke(key);
   }
   await chrome.storage.local.set(capture.settings);return {ok:true};
  }
  if(message?.type==='flowdm:download'){
   if(sender.tab&&!extensionPage){if(sender.tab.incognito)return {ok:false};message={...message,tabId:sender.tab.id};}
   if(!['hls','direct','dash','youtube'].includes(message.mediaType))return {ok:false,error:'Loại video chưa được hỗ trợ.'};
   const url=FlowDMCapture.httpUrl(message.url);if(!url)return {ok:false};const normalized=new URL(url);normalized.hash='';
   if(message.mediaType==='youtube'){
    try{const tab=await chrome.tabs.get(message.tabId);if(tab?.incognito||FlowDMMedia.youtubeUrl(tab?.url)!==normalized.href)return {ok:false};}catch{return {ok:false};}
   }
   if(!media.list(message.tabId).some(x=>x.url===normalized.href&&x.mediaType===message.mediaType))return {ok:false};
   return {ok:await capture.send(message)};
  }
  return {ok:false};
 })().then(respond,()=>respond({ok:false,error:'Không thể kết nối FlowDM.'}));return true;
});
