const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');
function backgroundFixture(){
 const listeners={};const messages=[];const titles=[];const menus=[];const local={autoCapture:true,credentials:{}};const session={};
 const event=name=>({addListener(fn){listeners[name]=fn;}});
 const chrome={runtime:{id:'test-extension',onInstalled:event('installed'),onMessage:event('message'),lastError:null,sendNativeMessage(host,request,done){messages.push({host,request});done({ok:true,request_id:request.request_id,payload:{id:'task'}});}},contextMenus:{create(value){menus.push(value);},onClicked:event('clicked')},downloads:{onCreated:event('created')},action:{setBadgeText(){},setBadgeBackgroundColor(){},setTitle(value){titles.push(value.title);}},storage:{local:{async get(){return local;},async set(value){Object.assign(local,value);}},session:{async get(){return session;},async set(value){Object.assign(session,value);}}},webRequest:{onBeforeSendHeaders:event('request'),onHeadersReceived:event('headers')},tabs:{onUpdated:event('updated'),onRemoved:event('removed')},permissions:{async contains(){return true;},onRemoved:event('permissionRemoved')}};
 const context=vm.createContext({chrome,crypto:require('node:crypto').webcrypto,URL,setTimeout,clearTimeout});context.importScripts=(...files)=>files.forEach(file=>vm.runInContext(fs.readFileSync(path.resolve('extension',file),'utf8'),context,{filename:path.resolve('extension',file)}));vm.runInContext(fs.readFileSync(path.resolve('extension/background.js'),'utf8'),context,{filename:path.resolve('extension/background.js')});
 const message=(input,sender={id:'test-extension',url:'chrome-extension://test-extension/popup.html'})=>new Promise(resolve=>listeners.message(input,sender,resolve));
 return {chrome,listeners,messages,titles,menus,local,message};
}
module.exports={backgroundFixture};


