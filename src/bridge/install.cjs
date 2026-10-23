#!/usr/bin/env node
// Generates files in an explicit directory; never registers or installs anything.
const fs=require('node:fs/promises');
const path=require('node:path');
const quote=value=>`'${value.replace(/'/g,"'\\''")}'`;
async function createHostBundle({output,dataDir,extensionId,nodePath=process.execPath,electron=false}) {
  const outputDir=output;
  if(!/^[a-p]{32}$/.test(extensionId || ''))throw new Error('Expected exact Chrome/Edge extension ID');
  for(const value of [outputDir,dataDir,nodePath])if(typeof value!=='string' || !path.isAbsolute(value) || /["\u0000-\u001f\u007f%!]/.test(value))throw new Error('Expected safe absolute paths');
  if(typeof electron!=='boolean')throw new Error('Expected boolean electron option');
  await fs.mkdir(outputDir,{recursive:true,mode:0o700});
  const hostPath=path.join(outputDir,'host.cjs');
  for(const file of ['host.cjs','protocol.cjs','server.cjs','client.cjs'])await fs.copyFile(path.join(__dirname,file),path.join(outputDir,file),require('node:fs').constants.COPYFILE_EXCL);
  const wrapperPath=path.join(outputDir,process.platform==='win32'?'flowdm-host.cmd':'flowdm-host.sh');
  // Native messaging needs no browser-supplied arguments. Omitting %* avoids cmd injection.
  const wrapper=process.platform==='win32'?`@echo off\r\nsetlocal DisableDelayedExpansion\r\nset "ELECTRON_RUN_AS_NODE=1"\r\n"${nodePath}" "${hostPath}" --data-dir "${dataDir}"\r\n`:`#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${quote(nodePath)} ${quote(hostPath)} --data-dir ${quote(dataDir)}\n`;
  await fs.writeFile(wrapperPath,wrapper,{mode:0o700,flag:'wx'});
  const manifestPath=path.join(outputDir,'local.flowdm.bridge.json');
  const manifest={name:'local.flowdm.bridge',description:'FlowDM browser download handoff',path:wrapperPath,type:'stdio',allowed_origins:[`chrome-extension://${extensionId}/`]};
  await fs.writeFile(manifestPath,JSON.stringify(manifest,null,2),{mode:0o600,flag:'wx'});
  return {manifestPath,wrapperPath,hostPath};
}
async function generateBundle({outputDir,...options}) {return (await createHostBundle({output:outputDir,...options})).manifestPath;}
if(require.main===module) {
  const args=process.argv.slice(2);const value=name=>{const i=args.indexOf(name);return i<0?undefined:args[i+1];};
  generateBundle({outputDir:value('--output'),dataDir:value('--data-dir'),extensionId:value('--extension-id'),nodePath:value('--node'),electron:args.includes('--electron')}).then(result=>process.stdout.write(`${result}\n`)).catch(error=>{process.stderr.write(`${error.message}\n`);process.exitCode=1;});
}
module.exports={generateBundle,createHostBundle};
