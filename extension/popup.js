(async()=>{
 const find=name=>document.querySelector(`[data-testid="${name}"]`);
 const [tab]=await chrome.tabs.query({active:true,currentWindow:true});
 const toOrigin=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)?u.origin:undefined;}catch{return undefined;}};
 const pageOrigin=toOrigin(tab?.url);let origin=pageOrigin;let settings;
 find('site-origin').textContent=origin||'Trang này không hỗ trợ quyền đăng nhập.';
 find('credentials').disabled=!origin||tab?.incognito;
 async function refresh(){
  const state=await chrome.runtime.sendMessage({type:'flowdm:state',tabId:tab?.id});
  settings=state.settings;
  const origins=[...new Set([pageOrigin,...state.items.map(item=>toOrigin(item.url))].filter(Boolean))];
  if(!origins.includes(origin))origin=origins[0];
  const selector=find('credential-origin');selector.replaceChildren();
  for(const value of origins){const option=document.createElement('option');option.value=value;option.textContent=value;selector.append(option);}
  selector.value=origin||'';selector.disabled=!origins.length||!!tab?.incognito;
  find('site-origin').textContent=origin?'Quyền áp dụng cho: '+origin:'Trang này không hỗ trợ quyền đăng nhập.';
  find('credentials').disabled=!origin||!!tab?.incognito;
  find('auto-capture').checked=state.settings.autoCapture;
  find('credentials').checked=!!state.settings.credentials[origin];
  find('capture-status').textContent=state.status;
  const list=find('media-list');list.replaceChildren();
  if(!state.items.length)list.textContent='Chưa phát hiện. Hãy phát video rồi mở lại tiện ích.';
  for(const item of state.items){
   const row=document.createElement('div');row.className='media';row.dataset.mediaType=item.mediaType;
   const title=document.createElement('p');let name;try{name=new URL(item.url).pathname.split('/').pop();}catch{}
   title.textContent=`${item.mediaType.toUpperCase()} · ${item.title||name||'Video / âm thanh'}`;
   const button=document.createElement('button');button.dataset.testid='download-media';button.textContent=item.mediaType==='dash'?'DASH chưa hỗ trợ':'Tải bằng FlowDM';button.disabled=item.mediaType==='dash';
   button.onclick=async()=>{button.disabled=true;const result=await chrome.runtime.sendMessage({type:'flowdm:download',tabId:tab.id,url:item.url,mediaType:item.mediaType});await refresh();if(!result.ok)find('capture-status').textContent=result.error||'Chưa chuyển được. Mở FlowDM và kiểm tra cầu nối.';};
   row.append(title,button);list.append(row);
  }
 }
 find('credential-origin').onchange=event=>{origin=event.target.value;find('credentials').checked=!!settings.credentials[origin];find('site-origin').textContent='Quyền áp dụng cho: '+origin;};
 find('auto-capture').onchange=async event=>{await chrome.runtime.sendMessage({type:'flowdm:settings',autoCapture:event.target.checked});await refresh();};
 find('credentials').onchange=async event=>{
  const enable=event.target.checked;
  if(enable&&!await chrome.permissions.request({permissions:['cookies'],origins:[`${origin}/*`]})){event.target.checked=false;return;}
  await chrome.runtime.sendMessage({type:'flowdm:settings',origin,credentials:enable});await refresh();
 };
 await refresh();
})().catch(()=>{document.querySelector('[data-testid="capture-status"]').textContent='Không thể đọc tiện ích. Hãy tải lại tiện ích.';});

