const {test}=require('node:test');const assert=require('node:assert/strict');const vm=require('node:vm');const fs=require('node:fs');const path=require('node:path');
test('content detector reports dynamic media, deduplicates overlay and offers a real click download',async()=>{
 let observer;const messages=[];const buttons=[];const element={tagName:'VIDEO',currentSrc:'https://a.test/first.mp4',src:'',querySelectorAll(){return [];},insertAdjacentElement(_,button){buttons.push(button);}};
 const document={title:'A film',documentElement:{},querySelectorAll(){return [element];},addEventListener(){},createElement(){return {dataset:{},style:{},addEventListener(name,fn){this[name]=fn;}};}};
 const context=vm.createContext({document,MutationObserver:class{constructor(fn){observer=fn;}observe(){}},queueMicrotask,URL,chrome:{runtime:{async sendMessage(value){messages.push(value);return {ok:true};}}}});
 for(const name of ['media.js','content.js'])vm.runInContext(fs.readFileSync(path.resolve('extension',name),'utf8'),context,{filename:path.resolve('extension',name)});
 assert.equal(buttons.length,1);assert.equal(messages[0].items[0].url,element.currentSrc);
 element.currentSrc='https://a.test/second.mp4';observer();await new Promise(r=>setImmediate(r));assert.equal(buttons.length,1);assert.equal(messages.at(-1).items[0].url,element.currentSrc);
 const before=messages.length;await buttons[0].click({isTrusted:false});assert.equal(messages.length,before);await buttons[0].click({isTrusted:true});assert.equal(messages.at(-1).url,element.currentSrc);assert.equal(messages.at(-1).type,'flowdm:download');assert.match(buttons[0].textContent,/Đã chuyển/);
});

