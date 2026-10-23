/* Native ownership transfer: browser remains the fallback until a durable matching ACK. */
(function(root){
  const httpUrl=value=>{try{const u=new URL(value);return ['http:','https:'].includes(u.protocol)&&!u.username&&!u.password?u.href:null;}catch{return null;}};
  function createCapture(chrome,{timeoutMs=5000,pauseRetryMs=50,userAgent=()=>root.navigator?.userAgent||'',uuid=()=>crypto.randomUUID(),onStatus=()=>{}}={}){
    const settings={autoCapture:true,credentials:{}};const handled=new Set();const pausing=new Set();const requests=new Map();
    const consentEpochs=new Map();let permissionEpoch=0;
    const context=origin=>({origin,consent:settings.credentials[origin]===true,consentEpoch:consentEpochs.get(origin)||0,permissionEpoch});
    const validContext=stamp=>stamp.consentEpoch===(consentEpochs.get(stamp.origin)||0)&&stamp.permissionEpoch===permissionEpoch&&stamp.consent===(settings.credentials[stamp.origin]===true);
    async function permissionAllowed(stamp){
      if(!stamp.consent||!chrome.permissions)return true;
      let timer;try{return await Promise.race([chrome.permissions.contains({permissions:['cookies'],origins:[stamp.origin+'/*']}),new Promise(resolve=>{timer=setTimeout(()=>resolve(false),1000);})])&&validContext(stamp);}catch{return false;}finally{clearTimeout(timer);}
    }
    function call(method,...args){return new Promise(resolve=>{try{chrome.downloads[method](...args,result=>resolve(chrome.runtime.lastError?null:{result}));}catch{resolve(null);}});}
    async function pauseWhenReady(id){
      for(let attempt=0;attempt<9;attempt++){
        if(attempt){const fresh=(await call('search',{id}))?.result?.[0];if(!fresh||fresh.state!=='in_progress'||fresh.danger!=='safe'||fresh.incognito||fresh.paused)return false;}
        if(await call('pause',id))return true;
        const fresh=(await call('search',{id}))?.result?.[0];
        if(!fresh||fresh.state!=='in_progress'||fresh.danger!=='safe'||fresh.incognito||fresh.paused)return false;
        if(attempt<8)await new Promise(resolve=>setTimeout(resolve,pauseRetryMs));
      }return false;
    }
    function remember(details){
      const url=httpUrl(details.url);if(!url)return;
      const consent=settings.credentials[new URL(url).origin]===true;
      const headers={};if(consent)for(const h of details.requestHeaders||[]){if(/^(referer|user-agent|authorization|cookie)$/i.test(h.name)&&typeof h.value==='string'&&h.value.length<=16384)headers[h.name]=h.value;}
      const hasCredentials=(details.requestHeaders||[]).some(h=>/^(cookie|authorization)$/i.test(h.name)&&Boolean(h.value));
      requests.delete(url);requests.set(url,{method:details.method,headers,hasCredentials,at:Date.now()});
      while(requests.size>128)requests.delete(requests.keys().next().value);
    }
    function inferredMediaType(value, requested){
      if(requested)return requested;
      let url;try{url=new URL(value);}catch{return undefined;}
      if(/\.mpd$/i.test(url.pathname))return 'dash';
      const host=url.hostname.toLowerCase();let id;
      if(['youtube.com','www.youtube.com','m.youtube.com'].includes(host))id=url.pathname==='/watch'?url.searchParams.get('v'):/^\/shorts\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
      else if(host==='youtu.be')id=/^\/([A-Za-z0-9_-]{11})\/?$/.exec(url.pathname)?.[1];
      return /^[A-Za-z0-9_-]{11}$/.test(id||'')?'youtube':undefined;
    }
    function payload(input){
      const url=httpUrl(input.url);if(!url)return null;
      const mediaType=inferredMediaType(url,input.mediaType);
      const record=requests.get(url);const consent=settings.credentials[new URL(url).origin]===true;
      const headers=consent&&record&&Date.now()-record.at<60000?{...record.headers}:{};
      if(consent){
        const has=name=>Object.keys(headers).some(key=>key.toLowerCase()===name);
        const agent=userAgent();if(!has('user-agent')&&typeof agent==='string'&&agent.length<=2048&&!/[\u0000-\u001f\u007f]/.test(agent)&&agent)headers['User-Agent']=agent;
      }
      return {url,...(input.filename?{filename:input.filename.split(/[\\/]/).pop()}:{}),...(mediaType?{mediaType}:{}),...(Object.keys(headers).length?{headers}:{})};
    }
    async function cookieHeaders(url,stamp){
      if(!settings.credentials[new URL(url).origin]||!chrome.cookies||!chrome.permissions)return {};
      let timer;
      try{return await Promise.race([(async()=>{
        if(!await permissionAllowed(stamp)||!validContext(stamp))return {};
        const cookies=await chrome.cookies.getAll({url});if(!validContext(stamp))return {};
        const pairs=[];let size=0;
        for(const cookie of cookies){
          if(typeof cookie.name!=='string'||typeof cookie.value!=='string'||!/^[A-Za-z0-9_!#%&'*+.^|~-]+$/.test(cookie.name)||/[;\u0000-\u001f\u007f]/.test(cookie.value))continue;
          const pair=cookie.name+'='+cookie.value;size+=pair.length+2;if(size>16384)break;pairs.push(pair);
        }
        return pairs.length?{Cookie:pairs.join('; ')}:{};
      })(),new Promise(resolve=>{timer=setTimeout(()=>resolve({}),1000);})]);}catch{return {};}finally{clearTimeout(timer);}
    }
    async function send(input){
      let data=payload(input);if(!data)return false;const externalMedia=['dash','youtube'].includes(data.mediaType);if(externalMedia&&data.headers){data={...data};delete data.headers;}const stamp=context(new URL(data.url).origin);
      if(!externalMedia&&settings.credentials[new URL(data.url).origin]&&!Object.keys(data.headers||{}).some(name=>name.toLowerCase()==='cookie')){
        const cookies=await cookieHeaders(data.url,stamp);if(validContext(stamp)&&Object.keys(cookies).length)data={...data,headers:{...data.headers,...cookies}};
      }
      if(!externalMedia&&(!validContext(stamp)||!await permissionAllowed(stamp)||!validContext(stamp))){onStatus('Quyền đăng nhập đã thay đổi; trình duyệt tiếp tục tải. Hãy gửi lại sau khi kiểm tra quyền.');return false;}
      const request={schema:1,request_id:uuid(),op:'add',payload:data};
      return new Promise(resolve=>{let settled=false;const finish=(accepted,error)=>{if(settled)return;settled=true;clearTimeout(timer);onStatus(accepted?'Đã chuyển sang FlowDM':error||'FlowDM chưa xác nhận; trình duyệt tiếp tục tải.');resolve(accepted);};
        const timer=setTimeout(()=>finish(false,'Hết thời gian chờ FlowDM; kiểm tra hàng đợi trước khi gửi lại.'),timeoutMs);
        try{chrome.runtime.sendNativeMessage('local.flowdm.bridge',request,response=>{const error=chrome.runtime.lastError;finish(!error&&response?.ok===true&&response.request_id===request.request_id&&typeof response.payload?.id==='string'&&response.payload.id.length>0);});}catch{finish(false);}
      });
    }
    async function automatic(item){
      const url=httpUrl(item.finalUrl||item.url);const record=requests.get(url);
      if(!settings.autoCapture||!url||/\.mpd(?:$|[?#])/i.test(url)||item.incognito||item.state!=='in_progress'||item.danger!=='safe'||(record&&record.method!=='GET')||(handled.has(item.id)||pausing.has(item.id)))return false;
      if(record?.hasCredentials&&!settings.credentials[new URL(url).origin]){onStatus('Tải cần đăng nhập: bật quyền cho trang này để chuyển sang FlowDM. Trình duyệt tiếp tục tải.');return false;}
      const autoStamp=context(new URL(url).origin);
      pausing.add(item.id);let paused;try{paused=await pauseWhenReady(item.id);}finally{pausing.delete(item.id);}
      if(!paused)return false;
      handled.add(item.id);while(handled.size>512)handled.delete(handled.values().next().value);
      const current=(await call('search',{id:item.id}))?.result?.[0];
      if(!current?.paused||current.state!=='in_progress'){if(!current)await call('resume',item.id);return false;}
      if(!validContext(autoStamp)){await call('resume',item.id);return false;}
      const accepted=await send({url,filename:current.filename||item.filename});
      const latest=(await call('search',{id:item.id}))?.result?.[0];
      if(!latest?.paused||latest.state!=='in_progress'){if(!latest)await call('resume',item.id);return false;}
      if(accepted&&validContext(autoStamp)){const canceled=await call('cancel',item.id);if(canceled)return true;onStatus('FlowDM đã nhận; không hủy được tải trình duyệt. Kiểm tra hai hàng đợi.');}
      await call('resume',item.id);return false;
    }
    function revoke(origin){consentEpochs.set(origin,(consentEpochs.get(origin)||0)+1);delete settings.credentials[origin];for(const [url]of requests)if(new URL(url).origin===origin)requests.delete(url);}
    function grant(origin){consentEpochs.set(origin,(consentEpochs.get(origin)||0)+1);settings.credentials[origin]=true;}
    function permissionsRemoved(){permissionEpoch++;for(const origin of Object.keys(settings.credentials))revoke(origin);}
    return {settings,automatic,send,remember,revoke,grant,permissionsRemoved,context,current:validContext};
  }
  root.FlowDMCapture={createCapture,httpUrl};if(typeof module!=='undefined')module.exports=root.FlowDMCapture;
})(globalThis);










