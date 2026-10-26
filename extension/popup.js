(async()=>{
 const extensionAPI=globalThis.browser||chrome;
 const find=name=>document.querySelector(`[data-testid="${name}"]`);
 const [tab]=await extensionAPI.tabs.query({active:true,currentWindow:true});
 const toOrigin=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)?u.origin:undefined;}catch{return undefined;}};
 const pageOrigin=toOrigin(tab?.url);let origin=pageOrigin;let settings;let credentialGeneration=0;
 find('site-origin').textContent=origin||'Trang này không hỗ trợ quyền đăng nhập.';
 find('credentials').disabled=!origin||tab?.incognito;
 function resetCredentialRequests(){
  credentialGeneration++;find('credential-requests').replaceChildren();
  const allowed=!!pageOrigin&&origin===pageOrigin&&!tab?.incognito&&settings?.credentials?.[pageOrigin]===true;
  find('find-credential-requests').disabled=!allowed;
  find('credential-status').textContent=allowed?'Trong FlowDM, chọn Kết nối lại từ trình duyệt cho tác vụ đang dừng, rồi tìm tác vụ tại đây.':'Mở trang gốc và cấp quyền đăng nhập cho tên miền của trang để kết nối lại.';
 }
 async function refresh(){
  const state=await extensionAPI.runtime.sendMessage({type:'flowdm:state',tabId:tab?.id});
  settings=state.settings;
  find('connections').value=String(settings.connections||4);
  const origins=[...new Set([pageOrigin,...state.items.map(item=>toOrigin(item.url))].filter(Boolean))];
  if(!origins.includes(origin))origin=origins[0];
  const selector=find('credential-origin');selector.replaceChildren();
  for(const value of origins){const option=document.createElement('option');option.value=value;option.textContent=value;selector.append(option);}
  selector.value=origin||'';selector.disabled=!origins.length||!!tab?.incognito;
  find('site-origin').textContent=origin?'Quyền áp dụng cho: '+origin:'Trang này không hỗ trợ quyền đăng nhập.';
  find('credentials').disabled=!origin||!!tab?.incognito;
  find('auto-capture').checked=state.settings.autoCapture;
  find('credentials').checked=!!state.settings.credentials[origin];
  resetCredentialRequests();
  find('capture-status').textContent=state.status;
  const list=find('media-list');list.replaceChildren();
  if(!state.items.length)list.textContent='Chưa phát hiện. Hãy phát video rồi mở lại tiện ích.';
  for(const item of state.items){
   const row=document.createElement('div');row.className='media';row.dataset.mediaType=item.mediaType;
   const title=document.createElement('p');let name;try{name=new URL(item.url).pathname.split('/').pop();}catch{}
   title.textContent=`${item.mediaType.toUpperCase()} · ${item.title||name||'Video / âm thanh'}`;
   const button=document.createElement('button');button.dataset.testid='download-media';button.textContent='Tải bằng FlowDM';button.disabled=false;
   button.onclick=async()=>{button.disabled=true;const result=await extensionAPI.runtime.sendMessage({type:'flowdm:download',tabId:tab.id,url:item.url,mediaType:item.mediaType});await refresh();if(!result.ok)find('capture-status').textContent=result.error||'Chưa chuyển được. Mở FlowDM và kiểm tra cầu nối.';};
   row.append(title,button);list.append(row);
  }
 }
 find('credential-origin').onchange=event=>{origin=event.target.value;find('credentials').checked=!!settings.credentials[origin];find('site-origin').textContent='Quyền áp dụng cho: '+origin;resetCredentialRequests();};
 find('find-credential-requests').onclick=async()=>{
  if(find('find-credential-requests').disabled)return;
  const generation=++credentialGeneration;find('find-credential-requests').disabled=true;find('credential-requests').replaceChildren();
  find('credential-status').textContent='Đang tìm tác vụ trong FlowDM…';
  try{
   const result=await extensionAPI.runtime.sendMessage({type:'flowdm:credentialRequests',tabId:tab.id,origin:pageOrigin});
   if(generation!==credentialGeneration)return;
   if(!result?.ok||!Array.isArray(result.requests))throw Error(result?.error||'Không thể tìm tác vụ. Hãy mở FlowDM và kiểm tra quyền đăng nhập.');
   find('credential-status').textContent=result.requests.length?'Chọn tác vụ cần cấp lại phiên đăng nhập.':'Chưa có yêu cầu cho trang này. Chọn Kết nối lại từ trình duyệt trong FlowDM trước.';
   for(const request of result.requests){
    const row=document.createElement('div');row.className='media';const title=document.createElement('p');title.textContent=request.filename;
    const button=document.createElement('button');button.textContent='Kết nối lại';button.dataset.testid='rebind-credentials';
    button.onclick=async()=>{
     if(button.disabled)return;button.disabled=true;find('credential-status').textContent='Đang kiểm tra phiên đăng nhập…';
     try{
      const reply=await extensionAPI.runtime.sendMessage({type:'flowdm:rebindCredentials',tabId:tab.id,origin:pageOrigin,taskId:request.taskId,requestId:request.requestId});
      if(generation!==credentialGeneration)return;
      find('credential-status').textContent=reply?.ok?'Đã kết nối lại. Nhấn Tiếp tục trong FlowDM để tải.':reply?.error||'Chưa kết nối lại. Tìm lại tác vụ và kiểm tra quyền đăng nhập.';
     }catch{find('credential-status').textContent='Không thể kết nối FlowDM. Mở ứng dụng rồi tìm lại tác vụ.';}
    };
    row.append(title,button);find('credential-requests').append(row);
   }
  }catch(error){if(generation===credentialGeneration)find('credential-status').textContent=error.message;}
  finally{if(generation===credentialGeneration)find('find-credential-requests').disabled=false;}
 };
 find('auto-capture').onchange=async event=>{await extensionAPI.runtime.sendMessage({type:'flowdm:settings',autoCapture:event.target.checked});await refresh();};
 find('connections').onchange=async event=>{await extensionAPI.runtime.sendMessage({type:'flowdm:settings',connections:Number(event.target.value)});await refresh();};
 find('credentials').onchange=async event=>{
  const enable=event.target.checked;
  if(enable&&!await extensionAPI.permissions.request({permissions:['cookies'],origins:[`${origin}/*`]})){event.target.checked=false;return;}
  await extensionAPI.runtime.sendMessage({type:'flowdm:settings',origin,credentials:enable});await refresh();
 };
 await refresh();
})().catch(()=>{
 const extensionAPI=globalThis.browser||chrome;document.querySelector('[data-testid="capture-status"]').textContent='Không thể đọc tiện ích. Hãy tải lại tiện ích.';});

