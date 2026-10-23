chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({id:'flowdm-add',title:'Tải bằng FlowDM',contexts:['link','video','audio'],targetUrlPatterns:['http://*/*','https://*/*']});
});
chrome.contextMenus.onClicked.addListener(info => {
  if(info.menuItemId!=='flowdm-add')return;
  const url=info.linkUrl || info.srcUrl;
  try {if(!['http:','https:'].includes(new URL(url).protocol))return;}catch{return;}
  const request={schema:1,request_id:crypto.randomUUID(),op:'add',payload:{url}};
  chrome.runtime.sendNativeMessage('local.flowdm.bridge',request,response=>{
    const error=chrome.runtime.lastError;
    const accepted=!error && response?.ok===true && response.request_id===request.request_id;
    chrome.action.setBadgeText({text:accepted?'✓':'!'});
    chrome.action.setBadgeBackgroundColor({color:accepted?'#087f8c':'#aa5a10'});
    chrome.action.setTitle({title:accepted?'FlowDM: đã thêm vào hàng đợi':'FlowDM: chưa xác nhận. Mở ứng dụng và kiểm tra cài đặt cầu nối / danh sách tải trước khi gửi lại.'});
  });
});
