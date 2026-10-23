const {test}=require('node:test');
const assert=require('node:assert/strict');
const vm=require('node:vm');
const fs=require('node:fs/promises');
const os=require('node:os');
const path=require('node:path');
test('extension explicitly sends link or media and reports host absence without interception',async()=>{
  const source=await fs.readFile(path.resolve('extension/background.js'),'utf8');
  let installed,clicked;const messages=[],titles=[],menus=[];
  const chrome={runtime:{onInstalled:{addListener(fn){installed=fn;}},lastError:null,sendNativeMessage(host,request,done){messages.push({host,request});chrome.runtime.lastError={message:'host absent'};done();chrome.runtime.lastError=null;}},contextMenus:{create(value){menus.push(value);},onClicked:{addListener(fn){clicked=fn;}}},action:{setBadgeText(){},setBadgeBackgroundColor(){},setTitle(value){titles.push(value.title);}}};
  vm.runInNewContext(source,{chrome,crypto:require('node:crypto').webcrypto,URL});installed();
  assert.equal(menus[0].title,'Tải bằng FlowDM');
  clicked({menuItemId:'flowdm-add',linkUrl:'https://example.com/file'});
  assert.equal(messages[0].host,'local.flowdm.bridge');assert.equal(messages[0].request.payload.url,'https://example.com/file');
  assert.match(titles[0],/FlowDM/);
  clicked({menuItemId:'flowdm-add',srcUrl:'blob:abc'});assert.equal(messages.length,1);
});
test('bundle helper writes only requested destination and exact extension origin',async t=>{
  const {generateBundle}=require('../../src/bridge/install.cjs');
  const output=await fs.mkdtemp(path.join(os.tmpdir(),'flowdm-install-'));t.after(()=>fs.rm(output,{recursive:true,force:true}));
  const manifestPath=await generateBundle({outputDir:output,dataDir:output,extensionId:'a'.repeat(32),nodePath:process.execPath});
  const manifest=JSON.parse(await fs.readFile(manifestPath,'utf8'));
  assert.deepEqual(manifest.allowed_origins,[`chrome-extension://${'a'.repeat(32)}/`]);assert.equal(manifest.name,'local.flowdm.bridge');
  assert.ok((await fs.stat(manifest.path)).isFile());
  await assert.rejects(generateBundle({outputDir:output,dataDir:output,extensionId:'*',nodePath:process.execPath}));
});
