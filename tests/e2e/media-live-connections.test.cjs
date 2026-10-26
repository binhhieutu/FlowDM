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
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const digest = body => crypto.createHash('sha256').update(body).digest('hex');
function command(tool, args, cwd) {
  const result = spawnSync(tool, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 60000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message); return result.stdout;
}
async function until(check, description, timeout = 90000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { const value = await check(); if (value) return value; await sleep(25); }
  throw Error('Timeout: ' + description);
}
async function launch(root) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([name]) => name.toUpperCase() !== 'ELECTRON_RUN_AS_NODE'));
  const app = await _electron.launch({ chromiumSandbox: true, executablePath: process.env.FLOWDM_EXECUTABLE || require('electron'), args: process.env.FLOWDM_EXECUTABLE ? [] : ['.'], env: { ...env, FLOWDM_DATA_DIR: path.join(root, 'state'), FLOWDM_DOWNLOAD_DIR: path.join(root, 'files') } });
  const page = await app.firstWindow(); page.setDefaultTimeout(15000); await page.waitForFunction(() => !!window.flow); return { app, page };
}
async function current(page, id) {
  const task = (await page.evaluate(() => window.flow.list())).data.find(item => item.id === id);
  assert.notEqual(task?.status, 'failed', JSON.stringify(task)); return task;
}
async function add(page, url, type, filename, selected = false) {
  await page.getByRole('button', { name: 'Thêm liên kết', exact: true }).click(); await page.locator('#url').fill(url);
  if (selected) {
    await page.locator('#inspect-media').click(); await page.locator('#media-catalog').waitFor({ state: 'visible' });
    await until(async () => page.locator('#media-video-format option').count(), 'DASH catalog choices');
    const inspected = await page.evaluate(url => window.flow.inspectMedia({ url, mediaType: 'dash' }), url); assert.equal(inspected.ok, true, JSON.stringify(inspected));
    const catalog = inspected.data.catalog || inspected.data;
    const video = catalog.formats.find(format => format.hasVideo); const audio = catalog.formats.find(format => format.hasAudio && !format.hasVideo);
    assert.ok(video && audio); await page.locator('#media-video-format').selectOption(video.id); await page.locator('#media-audio-format').selectOption(audio.id);
  }
  await page.locator('#filename').fill(filename); await page.locator('#connections').selectOption('1'); await page.locator('#add-form').evaluate(form => form.requestSubmit());
  return until(async () => (await page.evaluate(() => window.flow.list())).data.find(task => task.url === url), 'new ' + type + ' task');
}
async function change(page, id, count) {
  await page.locator('#live-connections').waitFor({ state: 'visible' }); await page.locator('#live-connections').selectOption(String(count)); await page.locator('#apply-connections').click();
  return until(async () => { const task = await current(page, id); return task?.connections === count && task.status === 'downloading' ? task : false; }, 'live connections ' + count);
}
function decoded(filename) {
  const media = JSON.parse(command('ffprobe', ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', filename]));
  assert.deepEqual(media.streams.map(stream => stream.codec_type).sort(), ['audio', 'video']);
  assert.ok(Number(media.format.duration) >= 5.9 && Number(media.format.duration) < 6.6, media.format.duration);
  command('ffmpeg', ['-v', 'error', '-xerror', '-i', filename, '-map', '0:v:0', '-map', '0:a:0', '-f', 'null', '-']);
  return { duration: Number(media.format.duration), wholeFileDecoded: true };
}
async function fixtures(root) {
  const base = path.join(root, 'fixture'); await fs.mkdir(base); for (const type of ['hls', 'dash']) await fs.mkdir(path.join(base, type));
  command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=192x108:rate=10:duration=6', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=6', '-map', '0:v:0', '-map', '1:a:0', '-c:v', 'libx264', '-threads', '2', '-preset', 'ultrafast', '-g', '5', '-keyint_min', '5', '-sc_threshold', '0', '-c:a', 'aac', '-b:a', '64k', '-shortest', 'source.mp4'], base);
  command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', '../source.mp4', '-c', 'copy', '-f', 'hls', '-hls_time', '0.5', '-hls_list_size', '0', '-hls_segment_filename', 'segment%02d.ts', 'list.m3u8'], path.join(base, 'hls'));
  command('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-i', '../source.mp4', '-map', '0:v:0', '-map', '0:a:0', '-c', 'copy', '-f', 'dash', '-seg_duration', '0.5', 'manifest.mpd'], path.join(base, 'dash'));
  const list = await fs.readFile(path.join(base, 'hls', 'list.m3u8'), 'utf8'); const names = list.split(/\r?\n/).filter(line => line && !line.startsWith('#')); assert.ok(names.length >= 12);
  return { base, hlsHash: digest(Buffer.concat(await Promise.all(names.map(name => fs.readFile(path.join(base, 'hls', name)))))) };
}
async function network(base) {
  const logs = []; const active = new Map(); const peak = new Map();
  const server = http.createServer(async (req, res) => {
    const route = new URL(req.url, 'http://fixture').pathname; const match = /^\/(live|baseline)\/(hls|dash)\/([A-Za-z0-9_.-]+)$/.exec(route);
    if (!match) return res.writeHead(404).end();
    try {
      const body = await fs.readFile(path.join(base, match[2], match[3])); const manifest = /\.(mpd|m3u8)$/.test(match[3]);
      res.writeHead(200, { 'Content-Length': body.length, 'Content-Type': match[3].endsWith('.mpd') ? 'application/dash+xml' : match[3].endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp4' });
      if (manifest) return res.end(body);
      const key = match[1] + '/' + match[2]; const entry = { route, completed: false }; logs.push(entry); active.set(key, (active.get(key) || 0) + 1); peak.set(key, Math.max(peak.get(key) || 0, active.get(key)));
      res.once('finish', () => { entry.completed = true; }); const timer = setTimeout(() => res.end(body), 350);
      res.once('close', () => { clearTimeout(timer); active.set(key, active.get(key) - 1); });
    } catch { res.writeHead(404).end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); return { server, logs, active, peak, origin: 'http://127.0.0.1:' + server.address().port };
}
test('actual HLS and DASH GUI changes 1→4→1, preserves native fragments and selection across relaunch', { timeout: 240000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-media-live-v8-')); let desktop; let net;
  t.after(async () => { if (desktop) await desktop.app.close(); if (net) { net.server.closeAllConnections(); await new Promise(resolve => net.server.close(resolve)); } assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('flowdm-media-live-v8-')); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  const f = await fixtures(root); net = await network(f.base); desktop = await launch(root); const rows = [];
  for (const type of ['hls', 'dash']) {
    const resource = type === 'hls' ? 'list.m3u8' : 'manifest.mpd'; const key = 'live/' + type;
    const added = await add(desktop.page, net.origin + '/live/' + type + '/' + resource, type, type + '-live.mp4', type === 'dash');
    const initial = await until(async () => { const task = await current(desktop.page, added.id); assert.notEqual(task?.status, 'completed', type + ' completed before live change: ' + JSON.stringify(task)); const completed = task?.media?.completedResources || task?.media?.completedSegments || 0; return completed >= 2 && (type === 'hls' || task.media?.canResize === true) ? task : false; }, 'native media live resize eligibility');
    const durable = net.logs.filter(entry => entry.route.startsWith('/live/' + type + '/') && entry.completed).slice(0,2).map(entry => ({ route: entry.route, count: net.logs.filter(value => value.route === entry.route).length })); assert.equal(durable.length,2);
    await change(desktop.page, added.id,4); await until(() => net.active.get(key) >= 4, 'four actual ' + type + ' requests');
    await change(desktop.page, added.id,1); await until(() => net.active.get(key) <= 1, 'one actual ' + type + ' request after decrease');
    await desktop.page.locator('[data-task="' + added.id + '"]').getByRole('button', { name: 'Tạm dừng', exact: true }).click();
    const paused = await until(async () => { const task = await current(desktop.page, added.id); return task?.status === 'paused' ? task : false; }, 'paused media');
    await until(() => (net.active.get(key) || 0) === 0, 'settled resource requests'); assert.equal(paused.connections,1);
    await desktop.app.close(); desktop = null; desktop = await launch(root); const restored = await current(desktop.page,added.id);
    assert.equal(restored.status,'paused'); assert.equal(restored.connections,1); assert.deepEqual(restored.selection,initial.selection); assert.ok(restored.downloadedBytes >= paused.downloadedBytes);
    await desktop.page.locator('[data-task="' + added.id + '"]').getByRole('button', { name: 'Tiếp tục', exact: true }).click();
    const done = await until(async () => { const task = await current(desktop.page,added.id); return task?.status === 'completed' ? task : false; }, 'completed resized ' + type);
    assert.equal(digest(await fs.readFile(done.path)),done.sha256); for (const item of durable) assert.equal(net.logs.filter(entry => entry.route === item.route).length,item.count,'durable native resource replayed');
    const decode = decoded(done.path); let expected = f.hlsHash;
    if (type === 'dash') {
      const baseline = await add(desktop.page,net.origin + '/baseline/dash/' + resource,type,'dash-continuous.mp4',true);
      const continuous = await until(async () => { const task = await current(desktop.page,baseline.id); return task?.status === 'completed' ? task : false; },'independent continuous DASH reference'); expected = continuous.sha256; decoded(continuous.path);
    }
    assert.equal(done.sha256,expected); assert.ok(net.peak.get(key) >=4); assert.ok(net.peak.get(key) <=4);
    rows.push({mediaType:type,transitions:[1,4,1],peakServerConnections:net.peak.get(key),pausedBytes:paused.downloadedBytes,restoredBytes:restored.downloadedBytes,restoredConnections:restored.connections,selection:done.selection,durableResources:durable,bytes:done.totalBytes,sha256:done.sha256,referenceSha256:expected,...decode}); t.diagnostic(JSON.stringify(rows.at(-1)));
  }
  const label = process.env.FLOWDM_EXECUTABLE ? 'packaged':'source'; await fs.mkdir('test-results',{recursive:true}); await desktop.page.screenshot({path:'test-results/media-live-v8-' + label + '.png'}); await fs.writeFile('test-results/media-live-v8-' + label + '.json',JSON.stringify({at:new Date().toISOString(),rows,requests:net.logs},null,2)); t.diagnostic(JSON.stringify(rows));
});


test('public YouTube GUI changes native connections 1→4→1 and reuses exact selection after relaunch', { skip: !process.env.FLOWDM_LIVE_YOUTUBE, timeout: 900000 }, async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'flowdm-youtube-live-v8-')); let desktop;
  t.after(async () => { if (desktop) await desktop.app.close(); assert.equal(path.dirname(root), os.tmpdir()); assert.ok(path.basename(root).startsWith('flowdm-youtube-live-v8-')); await fs.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }); });
  desktop = await launch(root); const page = desktop.page; const url = process.env.FLOWDM_LIVE_YOUTUBE;
  await page.getByRole('button', { name: 'Thêm liên kết', exact: true }).click(); await page.locator('#url').fill(url); await page.locator('#inspect-media').click();
  await page.locator('#media-catalog').waitFor({ state: 'visible', timeout: 90000 }); await until(async () => page.locator('#media-video-format option').count(), 'public YouTube format choices');
  const inspected = await page.evaluate(url => window.flow.inspectMedia({ url, mediaType: 'youtube' }),url); assert.equal(inspected.ok,true,JSON.stringify(inspected));
  const catalog = inspected.data.catalog || inspected.data;
  const video = catalog.formats.filter(format => format.hasVideo && !format.hasAudio && format.height <=360 && /^avc1|^h264/.test(format.vcodec) && ['m3u8_native','http_dash_segments','dash'].includes(format.protocol)).sort((a,b)=>b.height-a.height)[0];
  const audio = catalog.formats.find(format => format.id === '140' && format.hasAudio && !format.hasVideo && /^mp4a|^aac/.test(format.acodec));
  assert.ok(video,'Public source lacks native H264 <=360p video'); assert.ok(audio,'Public source lacks exact AAC format140');
  await page.locator('#media-video-format').selectOption(video.id); await page.locator('#media-audio-format').selectOption(audio.id);
  await page.locator('#filename').fill('YouTube-native-live-v8.mp4'); await page.locator('#connections').selectOption('1'); await page.locator('#speed-limit').fill('512'); await page.locator('#add-form').evaluate(form=>form.requestSubmit());
  const added = await until(async()=> (await page.evaluate(()=>window.flow.list())).data.find(task=>task.url===url),'public selected native job');
  const initial = await until(async()=>{ const task=await current(page,added.id); assert.notEqual(task?.status,'completed'); return task?.media?.canResize && task.media.completedResources>=2 ? task:false; },'public native checkpoint ready',180000);
  const selected = initial.selection; assert.equal(selected.videoFormatId,video.id); assert.equal(selected.audioFormatId,audio.id);
  await change(page,added.id,4);
  const four=await until(async()=>{const task=await current(page,added.id);return task?.media?.canResize && task.media.reusedResources>=2 && task.media.reusedBytes>0 && task.media.completedResources>task.media.reusedResources ? task:false;},'public checkpoint reuse at N4',180000);
  assert.equal(four.id,added.id); assert.deepEqual(four.selection,selected);
  await change(page,added.id,1);
  const one=await until(async()=>{const task=await current(page,added.id);return task?.media?.canResize && task.media.reusedResources>=four.media.reusedResources && task.media.reusedBytes>0 && task.media.completedResources>task.media.reusedResources ? task:false;},'public checkpoint reuse at N1',180000);
  assert.equal(one.id,added.id); assert.deepEqual(one.selection,selected);
  await page.locator('[data-task="'+added.id+'"]').getByRole('button',{name:'Tạm dừng',exact:true}).click();
  const paused=await until(async()=>{const task=await current(page,added.id);return task?.status==='paused'?task:false;},'public paused');
  await desktop.app.close();desktop=null;desktop=await launch(root);const restored=await current(desktop.page,added.id);
  assert.equal(restored.status,'paused');assert.equal(restored.connections,1);assert.deepEqual(restored.selection,selected);assert.ok(restored.downloadedBytes>=paused.downloadedBytes);
  await desktop.page.locator('[data-task="'+added.id+'"]').getByRole('button',{name:'Tiếp tục',exact:true}).click();
  const done=await until(async()=>{const task=await current(desktop.page,added.id);return task?.status==='completed'?task:false;},'public selected video complete',600000);
  assert.ok(done.media.reusedResources>=one.media.reusedResources);assert.ok(done.media.reusedBytes>0);assert.deepEqual(done.selection,selected);assert.equal(done.connections,1);
  const media=JSON.parse(command('ffprobe',['-v','error','-show_streams','-show_format','-of','json',done.path]));
  assert.deepEqual(media.streams.map(stream=>stream.codec_type).sort(),['audio','video']);
  const actualVideo=media.streams.find(stream=>stream.codec_type==='video');const actualAudio=media.streams.find(stream=>stream.codec_type==='audio');assert.equal(actualVideo.height,video.height);assert.equal(actualVideo.codec_name,'h264');assert.equal(actualAudio.codec_name,'aac');assert.ok(Number(media.format.duration)>60);
  const full=spawnSync('ffmpeg',['-v','error','-xerror','-i',done.path,'-map','0:v:0','-map','0:a:0','-f','null','-'],{encoding:'utf8',windowsHide:true,timeout:300000});assert.equal(full.status,0,full.stderr);assert.equal(full.stderr,'');
  const body=await fs.readFile(done.path);assert.equal(digest(body),done.sha256);assert.equal(body.length,done.totalBytes);
  if(process.env.FLOWDM_EXPECTED_NATIVE_YOUTUBE_SHA256) assert.equal(done.sha256,process.env.FLOWDM_EXPECTED_NATIVE_YOUTUBE_SHA256,'Exact selected source differs from previously fully decoded sample');
  const label=process.env.FLOWDM_EXECUTABLE?'packaged':'source';await fs.mkdir('downloads/verification-v8',{recursive:true});const output=path.resolve('downloads/verification-v8','YouTube-native-live-'+label+'-'+Date.now()+'.mp4');await fs.writeFile(output,body);
  const report={at:new Date().toISOString(),version:(await desktop.page.evaluate(()=>window.flow.info())).data.version,packaged:!!process.env.FLOWDM_EXECUTABLE,url,transitions:[1,4,1],selection:selected,video:{id:video.id,codec:actualVideo.codec_name,width:actualVideo.width,height:actualVideo.height},audio:{id:audio.id,codec:actualAudio.codec_name},initialResources:initial.media.completedResources,reuseAtFour:{resources:four.media.reusedResources,bytes:four.media.reusedBytes},reuseAtOne:{resources:one.media.reusedResources,bytes:one.media.reusedBytes},pausedBytes:paused.downloadedBytes,restoredBytes:restored.downloadedBytes,restoredConnections:restored.connections,reusedResources:done.media.reusedResources,reusedBytes:done.media.reusedBytes,bytes:done.totalBytes,sha256:done.sha256,duration:Number(media.format.duration),wholeFileDecoded:true,matchesPreviouslyDecodedSample:process.env.FLOWDM_EXPECTED_NATIVE_YOUTUBE_SHA256?true:null,cdnRequestCountsAvailable:false,output};
  await fs.mkdir('test-results',{recursive:true});await desktop.page.screenshot({path:'test-results/youtube-native-live-v8-'+label+'.png'});await fs.writeFile('test-results/youtube-native-live-v8-'+label+'.json',JSON.stringify(report,null,2));t.diagnostic(JSON.stringify(report));
});
