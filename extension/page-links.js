/* Read-only page discovery. Neither collection nor preview starts a download. */
(function(root){
 'use strict';
 const MAX_LINKS=1000,MAX_BYTES=512*1024;
 function normalize(value,base){
  try{if(typeof value!=='string'||value.length>32768||/[\r\n]/.test(value))return null;
   const url=new URL(value,base);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)return null;
   url.hash='';return url.href.length<=32768?url.href:null;
  }catch{return null;}
 }
 function collect(document,pageUrl){
  const urls=[],seen=new Set();let bytes=0,truncated=false,scanned=0;
  for(const anchor of document.getElementsByTagName('a')){
   if(++scanned>10000){truncated=true;break;}
   const value=anchor.getAttribute('href');if(!value?.trim())continue;
   const url=normalize(anchor.href||value,document.baseURI||pageUrl);if(!url||seen.has(url))continue;
   if(urls.length>=MAX_LINKS||bytes+url.length+1>MAX_BYTES){truncated=true;break;}
   seen.add(url);urls.push(url);bytes+=url.length+1;
  }
  return {urls,truncated};
 }
 root.FlowDMPageLinks={normalize,collect,MAX_LINKS,MAX_BYTES};
 if(typeof module==='object')module.exports=root.FlowDMPageLinks;
})(typeof globalThis==='object'?globalThis:this);
