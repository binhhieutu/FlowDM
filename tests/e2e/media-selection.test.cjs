'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { _electron } = require('playwright');

function command(tool, args, timeout = 30000, cwd) {
  const result = spawnSync(tool, args, { encoding: 'utf8', windowsHide: true, timeout, ...(cwd ? { cwd } : {}) });
  assert.equal(result.status, 0, result.stderr || result.error?.message); return result.stdout;
}
async function until(check, description, timeout = 120000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await check(); if (value) return value; await new Promise(resolve => setTimeout(resolve, 50)); }
  throw Error('Timeout: ' + description);
}
async function launch(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'));
  const app = await _electron.launch({ executablePath: process.env.FLOWDM_EXECUTABLE || require('electron'), args: process.env.FLOWDM_EXECUTABLE ? [] : ['.'], env: { ...env, ...(process.env.FLOWDM_COVERAGE_DIR ? { NODE_V8_COVERAGE: process.env.FLOWDM_COVERAGE_DIR } : {}), FLOWDM_DATA_DIR: path.join(root, 'state'), FLOWDM_DOWNLOAD_DIR: path.join(root, 'files') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000);
  const errors = []; page.on('pageerror', error => errors.push(error.message));
  if (process.env.FLOWDM_COVERAGE_DIR) { await page.coverage.startJSCoverage({ resetOnNavigation: false }); await page.reload(); }
  await page.waitForFunction(() => !!window.flow); return { app, page, errors };
}
async function inspectForm(page, url) {
  await page.getByRole('button', { name: 'Thêm liên kết', exact: true }).click();
  await page.locator('#url').fill(url); await page.locator('#inspect-media').click();
  await page.locator('#media-catalog').waitFor({ state: 'visible', timeout: 90000 });
  await until(async () => page.locator('#media-video-format option').count(), 'video format choices');
}
async function complete(page, filename) {
  const task = await until(async () => {
    const result = await page.evaluate(() => window.flow.list());
    return result.data.find(row => row.filename?.startsWith(filename) && ['completed', 'failed'].includes(row.status));
  }, 'selected format download');
  assert.equal(task.status, 'completed', JSON.stringify(task)); return task;
}
function verify(task, mode) {
  const probe = JSON.parse(command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', task.path]));
  assert.deepEqual(probe.streams.map(stream => stream.codec_type).sort(), mode === 'video' ? ['audio', 'video'] : ['audio']);
  if (mode === 'video') { const video = probe.streams.find(stream => stream.codec_type === 'video'); assert.equal(video.width, 3840); assert.equal(video.height, 2160); }
  command('ffmpeg', ['-v', 'error', '-xerror', '-i', task.path, '-f', 'null', '-']);
  return { streams: probe.streams.map(stream => ({ type: stream.codec_type, codec: stream.codec_name, width: stream.width, height: stream.height })), duration: Number(probe.format.duration), wholeFileDecoded: true };
}

test('actual DASH catalog GUI selects 4K video and audio-only, validates formats and fully decodes outputs', { timeout: 240000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-media-selection-')); let desktop;
  const fixture = path.join(root, 'fixture'); await fs.mkdir(fixture);
  command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=3840x2160:rate=1:duration=2', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=2', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-crf', '30', '-g', '1', '-c:a', 'aac', '-b:a', '64k', '-shortest', '-f', 'dash', '-seg_duration', '1', path.join(fixture, 'manifest.mpd')], 60000, fixture);
  const requests = [];
  const server = http.createServer(async (req, res) => {
    const name = new URL(req.url, 'http://fixture').pathname.slice(1);
    if (!/^[A-Za-z0-9_.-]+$/.test(name)) return res.writeHead(404).end();
    try {
      const body = await fs.readFile(path.join(fixture, name)); requests.push(name);
      res.writeHead(200, { 'Content-Length': body.length, 'Content-Type': name.endsWith('.mpd') ? 'application/dash+xml' : 'video/mp4' }); res.end(body);
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    if (desktop) {
      if (process.env.FLOWDM_COVERAGE_DIR) {
        const results = await desktop.page.coverage.stopJSCoverage();
        await fs.mkdir(process.env.FLOWDM_COVERAGE_DIR, { recursive: true });
        await fs.writeFile(path.join(process.env.FLOWDM_COVERAGE_DIR, 'coverage-renderer-' + crypto.randomUUID() + '.json'), JSON.stringify({ result: results.map(({scriptId,url,functions}) => ({scriptId,url,functions})) }));
      }
      await desktop.app.close();
    } server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    assert.ok(path.dirname(root) === os.tmpdir() && path.basename(root).startsWith('flowdm-media-selection-'));
    await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });
  desktop = await launch(root); const page = desktop.page;
  t.after(() => { if (desktop.errors.length) t.diagnostic(JSON.stringify({ pageErrors: desktop.errors })); });
  const url = 'http://127.0.0.1:' + server.address().port + '/manifest.mpd';
  await inspectForm(page, url);
  const inspected = await page.evaluate(url => window.flow.inspectMedia({ url, mediaType: 'dash' }), url);
  assert.equal(inspected.ok ?? inspected.success, true, JSON.stringify(inspected));
  const payload = inspected.data, catalog = payload.catalog || payload;
  const video = catalog.formats.find(format => format.hasVideo && format.height === 2160);
  const audio = catalog.formats.find(format => format.hasAudio && !format.hasVideo);
  assert.ok(video, JSON.stringify(catalog)); assert.ok(audio, JSON.stringify(catalog));
  assert.ok(!JSON.stringify(payload).includes('http_headers'));
  const rejected = await page.evaluate(({url,catalogId}) => window.flow.add({url,mediaType:'dash',filename:'invalid.mp4',catalogId,selection:{mode:'video',videoFormatId:'missing'}}), {url,catalogId:payload.catalogId});
  assert.equal(rejected.ok ?? rejected.success, false); assert.equal((await page.evaluate(()=>window.flow.list())).data.length,0);
  await page.locator('#media-mode').selectOption('video'); await page.locator('#media-video-format').selectOption(video.id); await page.locator('#media-audio-format').selectOption(audio.id);
  await page.locator('#filename').fill('selected-4k.mp4'); await page.locator('#connections').selectOption('4'); await page.locator('#add-form').evaluate(form=>form.requestSubmit());
  const videoTask = await complete(page,'selected-4k'); assert.equal(videoTask.selection.videoFormatId,video.id); assert.equal(videoTask.selection.audioFormatId,audio.id);
  const rows = [{ mode:'video', filename:videoTask.filename, sha256:videoTask.sha256, ...verify(videoTask,'video') }];
  await inspectForm(page,url); await page.locator('#media-mode').selectOption('audio'); await page.locator('#media-audio-format').selectOption(audio.id);
  await page.locator('#filename').fill('selected-audio.mp4'); await page.locator('#add-form').evaluate(form=>form.requestSubmit());
  const audioTask=await complete(page,'selected-audio'); assert.equal(audioTask.selection.mode,'audio'); assert.equal(audioTask.selection.videoFormatId,undefined);
  rows.push({mode:'audio', filename:audioTask.filename, sha256:audioTask.sha256, ...verify(audioTask,'audio')});
  for(const task of [videoTask,audioTask]) assert.equal(crypto.createHash('sha256').update(await fs.readFile(task.path)).digest('hex'),task.sha256);
  await fs.mkdir('test-results',{recursive:true}); const suffix=process.env.FLOWDM_EXECUTABLE?'packaged':'source';
  await page.screenshot({path:'test-results/media-selection-v8-'+suffix+'.png'});
  assert.deepEqual(desktop.errors, []);
  await fs.writeFile('test-results/media-selection-v8-'+suffix+'.json',JSON.stringify({at:new Date().toISOString(),actualGenerated4K:true,invalidFormatRefused:true,rows,requests},null,2)); t.diagnostic(JSON.stringify(rows));
});


function probePublic(task, mode, video, subtitles = false) {
  const media = JSON.parse(command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', task.path]));
  assert.deepEqual(media.streams.filter(stream => stream.codec_type !== 'subtitle').map(stream => stream.codec_type).sort(), mode === 'video' ? ['audio', 'video'] : ['audio']);
  if (video) { const actual = media.streams.find(stream => stream.codec_type === 'video'); assert.equal(actual.height, video.height); assert.equal(actual.width, video.width); }
  if (subtitles) { assert.equal(path.extname(task.path), '.mkv'); const subtitle=media.streams.find(stream => stream.codec_type === 'subtitle'); assert.ok(subtitle); if(task.selection.subtitleIds.some(id=>id.endsWith(':en'))) assert.ok(['en','eng'].includes(subtitle.tags?.language),JSON.stringify(subtitle.tags)); }
  command('ffmpeg', ['-v', 'error', '-xerror', '-i', task.path, ...(mode === 'audio' ? ['-map', '0:a:0'] : ['-map', '0:v:0', '-map', '0:a:0']), '-f', 'null', '-'], 300000);
  return { streams: media.streams.map(stream => ({ type: stream.codec_type, codec: stream.codec_name, width: stream.width, height: stream.height })), duration: Number(media.format.duration), wholeFileDecoded: true };
}
async function publicCatalog(page, url) {
  const response = await page.evaluate(url => window.flow.inspectMedia({ url, mediaType: 'youtube' }), url);
  assert.equal(response.ok, true, JSON.stringify(response)); return response.data;
}
async function selectPublic(page, url, catalog, mode, filename, subtitleId, maxHeight = 1080) {
  await inspectForm(page, url); await page.locator('#media-mode').selectOption(mode);
  const video = catalog.formats.filter(format => format.hasVideo && !format.hasAudio && format.height <= maxHeight && /^(avc1|h264)/.test(format.vcodec)).sort((a,b) => Number(b.protocol === 'm3u8_native') - Number(a.protocol === 'm3u8_native') || b.height-a.height || (b.fps||0)-(a.fps||0))[0];
  const audio = catalog.formats.find(format => format.id === '140' && format.hasAudio && !format.hasVideo) || catalog.formats.find(format => format.hasAudio && !format.hasVideo && format.ext === 'm4a' && /^mp4a/.test(format.acodec));
  assert.ok(audio, 'No AAC audio-only format in public source');
  if (mode === 'video') { assert.ok(video, 'No supported public H264 video'); await page.locator('#media-video-format').selectOption(video.id); }
  await page.locator('#media-audio-format').selectOption(audio.id);
  if (subtitleId) await page.locator('#media-subtitles input[value="' + subtitleId + '"]').check();
  await page.locator('#filename').fill(filename); await page.locator('#connections').selectOption('4'); await page.locator('#speed-limit').fill('4096');
  await page.locator('#add-form').evaluate(form=>form.requestSubmit()); return { video, audio };
}
async function publicFinished(page, prefix, timeout = 700000) {
  const task=await until(async()=>{const result=await page.evaluate(()=>window.flow.list());return result.data.find(item=>item.filename.startsWith(prefix)&&['completed','failed'].includes(item.status));},'public selected media',timeout);
  assert.equal(task.status,'completed',JSON.stringify({filename:task.filename,status:task.status,error:task.error,selection:task.selection})); return task;
}

test('public YouTube GUI selects video, audio-only and available embedded subtitles with real full decoding', { skip: !process.env.FLOWDM_LIVE_YOUTUBE && !process.env.FLOWDM_SUBTITLE_ONLY, timeout: 900000 }, async t => {
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'flowdm-selection-public-')); let desktop;
  const sourceUrl=process.env.FLOWDM_SUBTITLE_ONLY?process.env.FLOWDM_SUBTITLE_YOUTUBE:process.env.FLOWDM_LIVE_YOUTUBE;
  const rows=[], report={at:new Date().toISOString(),url:sourceUrl,rows};
  const suffix=process.env.FLOWDM_EXECUTABLE?'packaged':'source'; const evidence='test-results/media-selection-v8-public-'+(process.env.FLOWDM_SUBTITLE_ONLY?'caption-':'')+suffix;
  t.after(async()=>{
    if (!report.status) report.status='failed';
    await fs.mkdir('test-results',{recursive:true}); await fs.writeFile(evidence+'.json',JSON.stringify(report,null,2));
    if(desktop) { await desktop.page.screenshot({path:evidence+'.png'}).catch(()=>{}); await desktop.app.close(); }
    assert.equal(path.dirname(root),os.tmpdir()); assert.ok(path.basename(root).startsWith('flowdm-selection-public-')); await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  });
  desktop=await launch(root); const page=desktop.page; const catalog=await publicCatalog(page,sourceUrl);
  const output=path.resolve('downloads/verification-v8'); await fs.mkdir(output,{recursive:true});
  for(const mode of (process.env.FLOWDM_SUBTITLE_ONLY?[]:['video','audio'])) {
    const prefix='public-selected-'+mode+'-'+Date.now();
    const picked=await selectPublic(page,sourceUrl,catalog,mode,prefix+'.mp4');
    const done=await publicFinished(page,prefix); const checked=probePublic(done,mode,mode==='video'?picked.video:null);
    assert.equal(crypto.createHash('sha256').update(await fs.readFile(done.path)).digest('hex'),done.sha256);
    const saved=path.join(output,done.filename); await fs.copyFile(done.path,saved);
    const row={mode,filename:done.filename,path:saved,bytes:done.totalBytes,sha256:done.sha256,selection:done.selection,...checked}; rows.push(row); t.diagnostic(JSON.stringify(row));
  }
  const subtitleUrl=process.env.FLOWDM_SUBTITLE_YOUTUBE||sourceUrl;
  const subtitleCatalog=subtitleUrl===sourceUrl?catalog:await publicCatalog(page,subtitleUrl);
  const track=subtitleCatalog.subtitles.find(track=>!track.automatic&&track.language==='en')||subtitleCatalog.subtitles.find(track=>!track.automatic)||subtitleCatalog.subtitles.find(track=>track.language==='en')||subtitleCatalog.subtitles[0];
  if (process.env.FLOWDM_SUBTITLE_ONLY) assert.ok(track,'Subtitle proof requires an available public VTT/SRT track');
  if(!track) { report.subtitles={status:'unavailable',url:subtitleUrl,reason:'Public source returned no supported VTT/SRT caption tracks'}; t.diagnostic(JSON.stringify(report.subtitles)); }
  else {
    const prefix='public-selected-subtitle-'+Date.now(); report.subtitles={status:'attempting',url:subtitleUrl,trackId:track.id};
    const picked=await selectPublic(page,subtitleUrl,subtitleCatalog,'video',prefix+'.mp4',track.id,360);
    const done=await publicFinished(page,prefix); const checked=probePublic(done,'video',picked.video,true); const saved=path.join(output,done.filename); await fs.copyFile(done.path,saved);
    report.subtitles={status:'passed',url:subtitleUrl,trackId:track.id}; assert.equal(crypto.createHash('sha256').update(await fs.readFile(done.path)).digest('hex'),done.sha256); const row={mode:'subtitles',filename:done.filename,path:saved,bytes:done.totalBytes,sha256:done.sha256,selection:done.selection,...checked}; rows.push(row); t.diagnostic(JSON.stringify(row));
  }
  assert.deepEqual(desktop.errors,[]); report.status='passed';
});

test('public playlist preview GUI validates bounded entries and selection without batch downloading', {skip:!process.env.FLOWDM_LIVE_PLAYLIST,timeout:120000},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'flowdm-selection-playlist-'));let desktop;
  t.after(async()=>{if(desktop)await desktop.app.close();assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('flowdm-selection-playlist-'));await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});});
  desktop=await launch(root);const page=desktop.page;
  await page.getByRole('button',{name:'Thêm liên kết',exact:true}).click();await page.locator('#url').fill(process.env.FLOWDM_LIVE_PLAYLIST);await page.locator('#inspect-media').click();
  await page.locator('#media-playlist-fields').waitFor({state:'visible',timeout:90000});const boxes=page.locator('#playlist-entries input');const count=await boxes.count();assert.ok(count>0&&count<=100);
  const ids=await boxes.evaluateAll(boxes=>boxes.map(box=>box.value));assert.equal(new Set(ids).size,count);assert.ok(ids.every(id=>/^[A-Za-z0-9_-]{11}$/.test(id)));
  await page.locator('#playlist-select-all').click();assert.equal(await page.locator('#playlist-entries input:checked').count(),count);await page.locator('#playlist-select-all').click();assert.equal(await page.locator('#playlist-entries input:checked').count(),0);
  assert.equal((await page.evaluate(()=>window.flow.list())).data.length,0);
  await boxes.first().check(); const choice=await page.evaluate(url=>window.mediaChoice.optionsForUrl(url),process.env.FLOWDM_LIVE_PLAYLIST);
  assert.equal(choice.playlist,true);assert.deepEqual(choice.entryIds,[ids[0]]);
  const invalid=await page.evaluate(catalogId=>window.flow.addPlaylist({catalogId,entryIds:['not-listed'],connections:4,speedLimit:0}),choice.catalogId);
  assert.equal(invalid.ok,false);assert.equal((await page.evaluate(()=>window.flow.list())).data.length,0);
  assert.deepEqual(desktop.errors,[]);await fs.mkdir('test-results',{recursive:true});await page.screenshot({path:'test-results/media-selection-v8-playlist.png'});await fs.writeFile('test-results/media-selection-v8-playlist.json',JSON.stringify({at:new Date().toISOString(),url:process.env.FLOWDM_LIVE_PLAYLIST,entries:count,ids,selectAllToggled:true,chosenEntryIds:choice.entryIds,invalidEntryRefused:true,downloadsCreated:0},null,2));
});


test('public playlist batch submit GUI creates one selected job and preserves it across app restart', {skip:!process.env.FLOWDM_LIVE_PLAYLIST_BATCH,timeout:180000},async t=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'flowdm-playlist-batch-'));let desktop;
  const suffix=process.env.FLOWDM_EXECUTABLE?'packaged':'source';const evidence='test-results/media-playlist-batch-v8-'+suffix;
  const report={at:new Date().toISOString(),url:process.env.FLOWDM_LIVE_PLAYLIST_BATCH,scope:'one job submitted, paused, app restarted, then canceled; no full batch download'};
  t.after(async()=>{
    if(!report.status)report.status='failed';await fs.mkdir('test-results',{recursive:true});await fs.writeFile(evidence+'.json',JSON.stringify(report,null,2));
    if(desktop){await desktop.page.screenshot({path:evidence+'.png'}).catch(()=>{});await desktop.app.close();}
    assert.equal(path.dirname(root),os.tmpdir());assert.ok(path.basename(root).startsWith('flowdm-playlist-batch-'));await fs.rm(root,{recursive:true,force:true,maxRetries:10,retryDelay:200});
  });
  desktop=await launch(root);let page=desktop.page;report.version=(await page.evaluate(()=>window.flow.info())).data.version;
  await page.getByRole('button',{name:'Thêm liên kết',exact:true}).click();await page.locator('#url').fill(process.env.FLOWDM_LIVE_PLAYLIST_BATCH);await page.locator('#inspect-media').click();
  await page.locator('#media-playlist-fields').waitFor({state:'visible',timeout:90000});const boxes=page.locator('#playlist-entries input');const count=await boxes.count();assert.ok(count>0&&count<=100);
  await boxes.first().check();const choice=await page.evaluate(url=>window.mediaChoice.optionsForUrl(url),process.env.FLOWDM_LIVE_PLAYLIST_BATCH);assert.equal(choice.entryIds.length,1);
  const selectedId=choice.entryIds[0],expectedUrl='https://www.youtube.com/watch?v='+selectedId;assert.equal((await page.evaluate(()=>window.flow.list())).data.length,0);
  await page.locator('#connections').selectOption('2');await page.locator('#speed-limit').fill('128');await page.locator('#add-form').evaluate(form=>form.requestSubmit());
  const added=await until(async()=>{const result=await page.evaluate(()=>window.flow.list());assert.ok(result.data.length<=1,'Playlist submitted more than selected job');return result.data[0];},'one selected playlist job');
  assert.equal(added.url,expectedUrl);assert.equal(added.connections,2);assert.ok(['queued','downloading'].includes(added.status),JSON.stringify({status:added.status,error:added.error}));
  await page.locator('[data-task="'+added.id+'"]').getByRole('button',{name:'Tạm dừng',exact:true}).click();
  const paused=await until(async()=>{const result=await page.evaluate(()=>window.flow.list());return result.data[0]?.status==='paused'?result.data[0]:false;},'selected playlist job paused');
  assert.deepEqual(desktop.errors,[]);await desktop.app.close();desktop=null;desktop=await launch(root);page=desktop.page;
  const restored=(await page.evaluate(()=>window.flow.list())).data;assert.equal(restored.length,1);assert.equal(restored[0].id,added.id);assert.equal(restored[0].url,expectedUrl);assert.equal(restored[0].connections,2);assert.equal(restored[0].status,'paused');
  await page.locator('[data-task="'+added.id+'"]').getByRole('button',{name:'Hủy',exact:true}).click();
  const canceled=await until(async()=>{const result=await page.evaluate(()=>window.flow.list());return result.data[0]?.status==='canceled'?result.data[0]:false;},'selected playlist job canceled');
  await assert.rejects(fs.stat(path.join(root,'state',added.id+'.media')),{code:'ENOENT'});await assert.rejects(fs.stat(canceled.path),{code:'ENOENT'});
  assert.deepEqual(desktop.errors,[]);Object.assign(report,{status:'passed',previewEntries:count,selectedEntryIds:[selectedId],createdJobs:1,canonicalUrl:expectedUrl,connections:2,pausedBytes:paused.downloadedBytes,restoredBytes:restored[0].downloadedBytes,pauseRestartStatePreserved:true,canceled:true,ownedCacheRemoved:true,fullVideoDownloaded:false});t.diagnostic(JSON.stringify(report));
});
