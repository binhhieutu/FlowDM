/* This isolated content script never starts a transfer until its button is clicked. */
(()=>{
 const buttons=new WeakMap();let queued=false;
 const mime=element=>element.tagName==='VIDEO'?'video/mp4':'audio/mpeg';
 function sources(element){return [element.currentSrc,element.src,...Array.from(element.querySelectorAll('source'),s=>s.src)].filter(url=>FlowDMMedia.classify(url,mime(element)));}
 async function download(element,button){
  button.disabled=true;
  try{
   const urls=sources(element);
   await chrome.runtime.sendMessage({type:'flowdm:media',items:urls.map(url=>({url,mime:mime(element),title:document.title}))});
   const pageYoutube=FlowDMMedia.youtubeUrl(globalThis.location?.href||'');
   if(pageYoutube)await chrome.runtime.sendMessage({type:'flowdm:youtube',url:pageYoutube,title:document.title});
   const options=await chrome.runtime.sendMessage({type:'flowdm:options'});
   const selected=pageYoutube?{url:pageYoutube,mediaType:'youtube'}:urls.length?{url:urls[0],mediaType:FlowDMMedia.classify(urls[0],mime(element))}:(options.items||[]).find(item=>['hls','dash','direct'].includes(item.mediaType));
   if(!selected){button.textContent='Chưa phát hiện liên kết tải; hãy phát video';return;}
   const result=await chrome.runtime.sendMessage({type:'flowdm:download',url:selected.url,mediaType:selected.mediaType});
   button.textContent=result.ok?'Đã chuyển sang FlowDM':'Mở FlowDM và kiểm tra cầu nối';
  }catch{button.textContent='Chưa kết nối được FlowDM';}finally{button.disabled=false;}
 }
 function report(){
  queued=false;const items=[];
  for(const element of document.querySelectorAll('video,audio')){
   const urls=sources(element);
   for(const url of urls)items.push({url,mime:mime(element),title:document.title});
   let button=buttons.get(element);
   if(!button){
    button=document.createElement('button');button.type='button';button.textContent='Tải video bằng FlowDM';button.dataset.testid='flowdm-media-overlay';
    button.style.cssText='position:relative;z-index:2147483647;background:#16324f;color:white;border:0;padding:8px 12px;border-radius:5px;cursor:pointer';
    button.addEventListener('click',event=>{if(event.isTrusted)return download(element,button);});element.insertAdjacentElement('afterend',button);buttons.set(element,button);
   }
  }
  if(items.length)chrome.runtime.sendMessage({type:'flowdm:media',items:items.slice(0,30)}).catch(()=>{});
  const pageYoutube=FlowDMMedia.youtubeUrl(globalThis.location?.href||'');if(pageYoutube&&document.querySelector('video'))chrome.runtime.sendMessage({type:'flowdm:youtube',url:pageYoutube,title:document.title}).catch(()=>{});
 }
 function schedule(){if(!queued){queued=true;queueMicrotask(report);}}
 new MutationObserver(schedule).observe(document.documentElement,{childList:true,subtree:true,attributes:true,attributeFilter:['src','type']});
 document.addEventListener('loadedmetadata',schedule,true);report();
})();

