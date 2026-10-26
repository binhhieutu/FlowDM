'use strict';
const fs=require('node:fs/promises'),path=require('node:path');
const mode=process.argv[2],root=process.argv[3];
if(!path.isAbsolute(root)||!path.basename(root).startsWith('flowdm-crash-core-'))throw Error('Unsafe worker root');
const partial=path.join(root,'partial.bin'),destination=path.join(root,'final.bin'),journal=path.join(root,'downloads.json');
const wait=stage=>new Promise(()=>{setInterval(()=>{},1000);process.send({stage});});
(async()=>{
 const link=fs.link,unlink=fs.unlink,rename=fs.rename,open=fs.open;
 if(mode==='before-publication')fs.link=async(source,target)=>{if(target===destination)await wait('before-publication');return link(source,target);};
 if(mode==='after-publication')fs.unlink=async(filename)=>{if(filename===partial)await wait('after-publication');return unlink(filename);};
 if(mode==='after-data-sync')fs.open=async(filename,...args)=>{const handle=await open(filename,...args);if(String(filename).includes('.flowdm-')&&String(filename).endsWith('.tmp'))return{sync:async()=>{await handle.sync();await wait('after-data-sync');},close:handle.close.bind(handle)};return handle;};
 if(mode==='before-journal-replace'||mode==='after-journal-replace')fs.rename=async(source,target)=>{if(target===journal){if(mode==='before-journal-replace')await wait(mode);await rename(source,target);await wait(mode);}return rename(source,target);};
 const {publish,atomicJournal}=require('../../../src/core/storage.cjs');
 if(mode.includes('journal'))await atomicJournal(journal,[{new:true}]);else await publish(partial,destination);
 throw Error('Expected crash boundary was not reached');
})().catch(error=>{console.error(error.message);process.exitCode=1;});
