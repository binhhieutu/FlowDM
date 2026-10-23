(function(root){
 function youtubeUrl(value){
  let u;try{u=new URL(value);}catch{return null;}
  if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return null;
  const host=u.hostname.toLowerCase();let id;let outputHost='www.youtube.com';let pathname;
  if(['youtube.com','www.youtube.com','m.youtube.com'].includes(host)){
   if(u.pathname==='/watch')id=u.searchParams.get('v');
   else {const match=/^\/shorts\/([A-Za-z0-9_-]{11})\/?$/.exec(u.pathname);id=match?.[1];pathname=id?`/shorts/${id}`:null;}
   if(!id||!/^[A-Za-z0-9_-]{11}$/.test(id))return null;
   return pathname?`https://${outputHost}${pathname}`:`https://${outputHost}/watch?v=${id}`;
  }
  if(host==='youtu.be'){
   const match=/^\/([A-Za-z0-9_-]{11})\/?$/.exec(u.pathname);if(!match)return null;
   return `https://youtu.be/${match[1]}`;
  }
  return null;
 }
 function classify(value,mime=''){
  let u;try{u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return null;}catch{return null;}
  if(/\.m3u8$/i.test(u.pathname)||/mpegurl/i.test(mime))return 'hls';
  if(/\.mpd$/i.test(u.pathname)||/dash\+xml/i.test(mime))return 'dash';
  return /^(video|audio)\//i.test(mime)||/\.(mp4|webm|m4v|mov|mp3|m4a|ogg|opus|wav)$/i.test(u.pathname)?'direct':null;
 }
 function createMediaStore({now=()=>Date.now(),ttl=300000,maxItems=30}={}){
  const tabs=new Map();
  function list(tabId){const items=(tabs.get(tabId)||[]).filter(x=>now()-x.seenAt<ttl);tabs.set(tabId,items);return items.map(x=>({...x}));}
  function add(tabId,item){if(!Number.isInteger(tabId)||tabId<0)return;const explicitYoutube=item?.mediaType==='youtube'?youtubeUrl(item.url):null;const mediaType=explicitYoutube?'youtube':classify(item.url,item.mime);if(!mediaType)return;
   const u=new URL(explicitYoutube||item.url);u.hash='';const row={url:u.href,mediaType,title:typeof item.title==='string'?item.title.slice(0,160):'',seenAt:now()};
   const prior=list(tabId);tabs.delete(tabId);tabs.set(tabId,[...prior.filter(x=>x.url!==row.url),row].slice(-maxItems));while(tabs.size>100)tabs.delete(tabs.keys().next().value);
  }
  function reconcileYoutube(tabId,url){
   if(!Number.isInteger(tabId)||tabId<0)return list(tabId);const prior=list(tabId);const kept=prior.filter(item=>item.mediaType!=='youtube');
   if(url){const old=prior.find(item=>item.mediaType==='youtube'&&item.url===url);kept.push(old||{url,mediaType:'youtube',title:'',seenAt:now()});}
   tabs.set(tabId,kept.slice(-maxItems));return list(tabId);
  }
  function snapshot(){return Array.from(tabs.keys(),tabId=>[tabId,list(tabId)]).filter(([,items])=>items.length);}
  function restore(entries){for(const [id,items]of (Array.isArray(entries)?entries:[]).slice(-100)){if(!Number.isInteger(id)||!Array.isArray(items))continue;for(const item of items.slice(-maxItems)){if(typeof item.seenAt!=='number'||now()-item.seenAt>=ttl)continue;add(id,item);const rows=tabs.get(id);if(rows?.length)rows[rows.length-1]={...rows[rows.length-1],seenAt:item.seenAt};}}}
  return {list,add,reconcileYoutube,snapshot,restore,clear:tabId=>tabs.delete(tabId)};
 }
 root.FlowDMMedia={classify,youtubeUrl,createMediaStore};if(typeof module!=='undefined')module.exports=root.FlowDMMedia;
})(globalThis);


