'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { normalizeCatalog, validateSelection, selectionFormat } = require('../../src/media/catalog.cjs');
const info = { id:'aqz-KE-bpKQ', title:'Example', duration:12, formats:[
 {format_id:'18',ext:'mp4',vcodec:'avc1.42001E',acodec:'mp4a.40.2',height:720},
 {format_id:'137',ext:'mp4',vcodec:'avc1.640028',acodec:'none',height:1080},
 {format_id:'401',ext:'mp4',vcodec:'av01.0.12M.08',acodec:'none',height:2160},
 {format_id:'313',ext:'webm',vcodec:'vp9',acodec:'none',height:2160},
 {format_id:'140',ext:'m4a',vcodec:'none',acodec:'mp4a.40.2'},
 {format_id:'251',ext:'webm',vcodec:'none',acodec:'opus'}],
 subtitles:{en:[{ext:'json3',url:'secret'},{ext:'vtt',url:'secret'}]}, automatic_captions:{en:[{ext:'vtt',url:'secret'}]} };
const catalog = () => normalizeCatalog(info, {sourceUrl:'https://www.youtube.com/watch?v=aqz-KE-bpKQ',mediaType:'youtube'});
test('catalog exposes codecs and 4K without raw URLs or credentials', () => {
 const dto = normalizeCatalog({...info, http_headers:{Cookie:'secret'}, formats:info.formats.map(f=>({...f,url:'secret',http_headers:{Authorization:'secret'}}))});
 assert.equal(dto.formats.find(f=>f.id==='401').height,2160); assert.equal(dto.formats.find(f=>f.id==='18').hasAudio,true);
 assert.ok(!JSON.stringify(dto).includes('secret')); assert.equal(dto.formats.length,6);
 assert.deepEqual(dto.subtitles,[{id:'manual:en',language:'en',automatic:false,ext:'vtt'},{id:'auto:en',language:'en',automatic:true,ext:'vtt'}]);
});
test('selection pins exact IDs and codec compatible containers', () => {
 assert.equal(selectionFormat({mode:'video',videoFormatId:'18'},catalog()).extension,'mp4');
 assert.deepEqual(selectionFormat({mode:'video',videoFormatId:'137',audioFormatId:'140'},catalog()).format,'137+140');
 assert.equal(selectionFormat({mode:'video',videoFormatId:'313',audioFormatId:'251'},catalog()).extension,'webm');
 assert.equal(selectionFormat({mode:'video',videoFormatId:'401',audioFormatId:'251'},catalog()).extension,'mkv');
 assert.equal(selectionFormat({mode:'audio',audioFormatId:'140'},catalog()).extension,'m4a');
 assert.equal(selectionFormat({mode:'audio',audioFormatId:'251'},catalog()).extension,'webm');
});
test('selection rejects absent or incompatible format combinations', () => {
 for (const value of [{mode:'video',videoFormatId:'137'},{mode:'video',videoFormatId:'18',audioFormatId:'140'},{mode:'audio',audioFormatId:'18'},{mode:'audio',audioFormatId:'140',videoFormatId:'137'},{mode:'video',videoFormatId:'missing'}]) assert.throws(()=>validateSelection(value,catalog()));
 assert.throws(()=>selectionFormat({mode:'video',videoFormatId:'137',audioFormatId:'140'}, {...catalog(),formats:[]}));
});
test('selection rejects selector syntax, unknown keys and excessive subtitles', () => {
 for(const id of ['best','137+140','137/18','x[height>0]','../x','x\n','a'.repeat(129)]) {
  if(id==='best') continue;
  assert.throws(()=>validateSelection({mode:'video',videoFormatId:id}));
 }
 assert.throws(()=>validateSelection({mode:'audio',audioFormatId:'140',url:'secret'}));
 assert.throws(()=>validateSelection({mode:'audio',audioFormatId:'140',subtitleIds:Array(9).fill('manual:en')}));
 assert.throws(()=>validateSelection({mode:'audio',audioFormatId:'140',subtitleIds:['manual:xx']},catalog()));
 assert.deepEqual(validateSelection({mode:'video',videoFormatId:'18',subtitleIds:['manual:en','auto:en']},catalog()).subtitleIds,['manual:en','auto:en']);
});
test('playlist canonicalizes public YouTube IDs, drops credentials and nested entries, dedupes and caps 100', () => {
 const entries=[{id:'aqz-KE-bpKQ',title:'one',url:'https://www.youtube.com/watch?v=aqz-KE-bpKQ&token=secret'}, {id:'aqz-KE-bpKQ'}, {id:'bad',url:'https://evil.test/video'}, {id:'AAAAAAAAAAA',url:'https://u:p@youtube.com/watch?v=AAAAAAAAAAA'}, {_type:'playlist',id:'BBBBBBBBBBB',entries:[{id:'CCCCCCCCCCC'}]}];
 entries.push(...Array.from({length:110},(_,i)=>({id:String(i).padStart(11,'0'),title:'entry'})));
 const dto=normalizeCatalog({entries},{mediaType:'youtube'}); assert.equal(dto.entries.length,100); assert.equal(dto.entries[0].url,'https://www.youtube.com/watch?v=aqz-KE-bpKQ');
 assert.ok(!JSON.stringify(dto).includes('secret')); assert.ok(!dto.entries.some(e=>['AAAAAAAAAAA','BBBBBBBBBBB','CCCCCCCCCCC'].includes(e.id)));
});
test('normalization is bounded, deterministic and drops malformed or DRM formats',()=>{
 const dto=normalizeCatalog({formats:[...info.formats,info.formats[0],{format_id:'evil+id'},{format_id:'drm',has_drm:true},{format_id:'no-media',vcodec:'none',acodec:'none'}],subtitles:{'../bad':[{ext:'vtt'}]}});
 assert.equal(dto.formats.length,6); assert.deepEqual(dto.subtitles,[]); assert.deepEqual(normalizeCatalog(null).formats,[]);
 assert.throws(()=>validateSelection(null)); assert.throws(()=>validateSelection({mode:'other',videoFormatId:'18'}));
});

test('subtitles force a single embedded MKV and are refused for audio only', () => {
 assert.equal(selectionFormat({mode:'video',videoFormatId:'18',subtitleIds:['manual:en']},catalog()).extension,'mkv');
 assert.throws(()=>validateSelection({mode:'audio',audioFormatId:'140',subtitleIds:['auto:en']},catalog()),/subtitle/i);
 for(const id of ['best','bestaudio','worstvideo']) assert.throws(()=>validateSelection({mode:'video',videoFormatId:id}));
});

test('exact format IDs refuse every yt-dlp selector alias and ambiguous leading characters', () => {
 const aliases=['b','bv','ba','w','wv','wa','best','bestvideo','bestaudio','worst','worstvideo','worstaudio','all','mergeall','b.2','bv.2','ba.2','w.2','wv.2','wa.2','best.2','worstvideo.2','ALL','MergeAll','BV.2','-1','-option','.', '..', '...'];
 for(const id of aliases){
  assert.throws(()=>validateSelection({mode:'video',videoFormatId:id}),undefined,'accepted video alias '+id);
  assert.throws(()=>validateSelection({mode:'audio',audioFormatId:id}),undefined,'accepted audio alias '+id);
 }
 const normalized=normalizeCatalog({formats:[...aliases.map(format_id=>({format_id,ext:'mp4',vcodec:'avc1',acodec:'mp4a'})),{format_id:'139-drc',ext:'m4a',vcodec:'none',acodec:'mp4a.40.5'},{format_id:'b144p',ext:'mp4',vcodec:'avc1',acodec:'mp4a'},{format_id:'137',ext:'mp4',vcodec:'avc1',acodec:'mp4a'}]});
 assert.deepEqual(normalized.formats.map(format=>format.id),['139-drc','b144p','137']);
 assert.equal(validateSelection({mode:'audio',audioFormatId:'139-drc'},normalized).audioFormatId,'139-drc');
 assert.equal(selectionFormat({mode:'video',videoFormatId:'b144p'},normalized).format,'b144p');
});
