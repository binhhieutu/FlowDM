(function(root){
 function classify(value,mime=''){
  let u;try{u=new URL(value);if(!['http:','https:'].includes(u.protocol)||u.username||u.password)return null;}catch{return null;}
  if(/\.m3u8$/i.test(u.pathname)||/mpegurl/i.test(mime))return 'hls';
  if(/\.mpd$/i.test(u.pathname)||/dash\+xml/i.test(mime))return 'dash';
  return /^(video|audio)\//i.test(mime)||/\.(mp4|webm|m4v|mov|mp3|m4a|ogg|opus|wav)$/i.test(u.pathname)?'direct':null;
 }
 function createMediaStore({now=()=>Date.now(),ttl=300000,maxItems=30}={}){
  const tabs=new Map();
  function list(tabId){const items=(tabs.get(tabId)||[]).filter(x=>now()-x.seenAt<ttl);tabs.set(tabId,items);return items.map(x=>({...x}));}
  function add(tabId,item){if(!Number.isInteger(tabId)||tabId<0)return;const mediaType=classify(item.url,item.mime);if(!mediaType)return;
   const u=new URL(item.url);u.hash='';const row={url:u.href,mediaType,title:typeof item.title==='string'?item.title.slice(0,160):'',seenAt:now()};
   const prior=list(tabId);tabs.delete(tabId);tabs.set(tabId,[...prior.filter(x=>x.url!==row.url),row].slice(-maxItems));while(tabs.size>100)tabs.delete(tabs.keys().next().value);
  }
  function snapshot(){return Array.from(tabs.keys(),tabId=>[tabId,list(tabId)]).filter(([,items])=>items.length);}
  function restore(entries){for(const [id,items]of (Array.isArray(entries)?entries:[]).slice(-100)){if(!Number.isInteger(id)||!Array.isArray(items))continue;for(const item of items.slice(-maxItems)){if(typeof item.seenAt!=='number'||now()-item.seenAt>=ttl)continue;add(id,item);const rows=tabs.get(id);if(rows?.length)rows[rows.length-1]={...rows[rows.length-1],seenAt:item.seenAt};}}}
  return {list,add,snapshot,restore,clear:tabId=>tabs.delete(tabId)};
 }
 root.FlowDMMedia={classify,createMediaStore};if(typeof module!=='undefined')module.exports=root.FlowDMMedia;
})(globalThis);


