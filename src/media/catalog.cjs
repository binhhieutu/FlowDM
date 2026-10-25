'use strict';
const FORMAT_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const LANGUAGE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
// yt-dlp treats these names as selectors even when a source uses the same ID.
const RESERVED_ID = /^(?:(?:best|worst|b|w)(?:video|audio|v|a)?|all|mergeall)(?:\.\d+)?$/i;
const text = (value, limit = 512) => typeof value === 'string' ? value.replace(/[\x00-\x1f\x7f]/g, '').slice(0, limit) : '';
const positive = value => Number.isFinite(value) && value > 0 ? value : null;
const safeId = value => typeof value === 'string' && FORMAT_ID.test(value) && !RESERVED_ID.test(value);
const codecPresent = value => typeof value === 'string' && value !== 'none' && value !== '';

function normalizeFormat(raw) {
  if (!raw || !safeId(raw.format_id) || raw.has_drm) return null;
  const hasVideo = codecPresent(raw.vcodec), hasAudio = codecPresent(raw.acodec);
  if (!hasVideo && !hasAudio) return null;
  return { id: raw.format_id, ext: text(raw.ext, 16).toLowerCase(), protocol: text(raw.protocol, 64),
    vcodec: text(raw.vcodec, 128), acodec: text(raw.acodec, 128), width: positive(raw.width),
    height: positive(raw.height), fps: positive(raw.fps), estimatedBytes: positive(raw.filesize) || positive(raw.filesize_approx), hasVideo, hasAudio };
}

function subtitleTracks(info) {
  const tracks = [];
  for (const [automatic, source] of [[false, info.subtitles], [true, info.automatic_captions]]) {
    if (!source || typeof source !== 'object' || Array.isArray(source)) continue;
    for (const language of Object.keys(source).sort().slice(0, 200)) {
      if (!LANGUAGE.test(language) || !Array.isArray(source[language])) continue;
      const ext = ['vtt', 'srt'].find(candidate => source[language].some(track => track && track.ext === candidate));
      if (ext) tracks.push({ id: (automatic ? 'auto:' : 'manual:') + language, language, automatic, ext });
    }
  }
  return tracks.slice(0, 200);
}

function entryUrl(raw) {
  const candidate = raw.webpage_url || raw.url;
  if (!candidate || candidate === raw.id) return YOUTUBE_ID.test(raw.id || '') ? raw.id : null;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'https:' || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    if (host === 'youtu.be') return YOUTUBE_ID.test(url.pathname.slice(1)) ? url.pathname.slice(1) : null;
    if (!['youtube.com', 'www.youtube.com', 'm.youtube.com'].includes(host)) return null;
    const id = url.pathname === '/watch' ? url.searchParams.get('v') : /^\/(?:shorts|embed)\/([A-Za-z0-9_-]{11})$/.exec(url.pathname)?.[1];
    return YOUTUBE_ID.test(id || '') ? id : null;
  } catch { return null; }
}

function playlistEntries(info, mediaType) {
  if (mediaType && mediaType !== 'youtube') return [];
  const seen = new Set(), entries = [];
  for (const raw of Array.isArray(info.entries) ? info.entries.slice(0, 10000) : []) {
    if (!raw || raw._type === 'playlist' || raw._type === 'multi_video' || raw.entries) continue;
    const id = entryUrl(raw);
    if (!id || seen.has(id) || (raw.id && YOUTUBE_ID.test(raw.id) && raw.id !== id)) continue;
    seen.add(id); entries.push({ id, title: text(raw.title) || id, url: 'https://www.youtube.com/watch?v=' + id });
    if (entries.length === 100) break;
  }
  return entries;
}

function normalizeCatalog(info, options = {}) {
  info = info && typeof info === 'object' && !Array.isArray(info) ? info : {};
  const formats = [], seen = new Set();
  const source = Array.isArray(info.formats) ? info.formats : info.format_id ? [info] : [];
  for (const raw of source.slice(0, 2000)) {
    const format = normalizeFormat(raw);
    if (format && !seen.has(format.id)) { seen.add(format.id); formats.push(format); }
  }
  return { sourceId: text(info.id, 128), title: text(info.title), duration: positive(info.duration),
    formats, subtitles: subtitleTracks(info), entries: playlistEntries(info, options.mediaType) };
}

function validateSelection(selection, catalog) {
  if (!selection || typeof selection !== 'object' || Array.isArray(selection) || ![Object.prototype, null].includes(Object.getPrototypeOf(selection))) throw Error('Invalid media selection');
  const allowed = new Set(['videoFormatId', 'audioFormatId', 'subtitleIds', 'mode']);
  if (Object.keys(selection).some(key => !allowed.has(key)) || !['video', 'audio'].includes(selection.mode)) throw Error('Invalid media selection fields');
  for (const key of ['videoFormatId', 'audioFormatId']) if (selection[key] !== undefined && !safeId(selection[key])) throw Error('Invalid exact format ID');
  if (selection.mode === 'video' && !selection.videoFormatId) throw Error('Choose a video format');
  if (selection.mode === 'audio' && (!selection.audioFormatId || selection.videoFormatId !== undefined)) throw Error('Choose only an audio format');
  const subtitleIds = selection.subtitleIds === undefined ? [] : selection.subtitleIds;
  if (!Array.isArray(subtitleIds) || subtitleIds.length > 8 || subtitleIds.some(id => typeof id !== 'string' || !/^(manual|auto):[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(id)) || new Set(subtitleIds).size !== subtitleIds.length) throw Error('Choose at most 8 distinct subtitle tracks');
  if (selection.mode === 'audio' && subtitleIds.length) throw Error('Subtitles require a video selection');
  if (catalog) validateAvailable(selection, subtitleIds, catalog);
  return { mode: selection.mode, ...(selection.videoFormatId ? {videoFormatId: selection.videoFormatId} : {}),
    ...(selection.audioFormatId ? {audioFormatId: selection.audioFormatId} : {}), subtitleIds: [...subtitleIds] };
}

function validateAvailable(selection, subtitleIds, catalog) {
  if (!Array.isArray(catalog.formats) || !Array.isArray(catalog.subtitles)) throw Error('Invalid media catalog');
  const video = catalog.formats.find(format => format.id === selection.videoFormatId);
  const audio = catalog.formats.find(format => format.id === selection.audioFormatId);
  if (selection.videoFormatId && (!video || !video.hasVideo)) throw Error('Selected video format is unavailable');
  if (selection.audioFormatId && (!audio || !audio.hasAudio || audio.hasVideo)) throw Error('Selected audio format is unavailable');
  if (video && !video.hasAudio && !audio) throw Error('Choose audio for the selected video format');
  if (video?.hasAudio && audio) throw Error('Muxed video already includes audio');
  if (subtitleIds.some(id => !catalog.subtitles.some(track => track.id === id))) throw Error('Selected subtitle is unavailable');
}

function selectionFormat(selection, catalog) {
  if (!catalog) throw Error('A fresh media catalog is required');
  const checked = validateSelection(selection, catalog);
  const video = catalog.formats.find(format => format.id === checked.videoFormatId);
  const audio = catalog.formats.find(format => format.id === checked.audioFormatId);
  let extension;
  if (!video) extension = ['m4a', 'webm', 'opus', 'mp3', 'aac', 'flac', 'wav', 'ogg'].includes(audio.ext) ? audio.ext : 'mka';
  else {
    const audioCodec = audio?.acodec || video.acodec;
    const mp4Video = /^(?:avc1|avc3|h264|hev1|hvc1|hevc|av01|av1)(?:[.\s]|$)/i.test(video.vcodec);
    const mp4Audio = /^(?:mp4a|aac|alac)(?:[.\s]|$)/i.test(audioCodec);
    const webmVideo = /^(?:vp0?8|vp0?9|av01|av1)(?:[.\s]|$)/i.test(video.vcodec);
    const webmAudio = /^(?:opus|vorbis)(?:[.\s]|$)/i.test(audioCodec);
    if (mp4Video && mp4Audio && ['mp4', 'm4v'].includes(video.ext) && (!audio || ['m4a', 'mp4', 'aac'].includes(audio.ext))) extension = 'mp4';
    else if (webmVideo && webmAudio && video.ext === 'webm' && (!audio || ['webm', 'opus', 'ogg'].includes(audio.ext))) extension = 'webm';
    else extension = 'mkv';
  }
  if (checked.subtitleIds.length) extension = 'mkv';
  return { format: [checked.videoFormatId, checked.audioFormatId].filter(Boolean).join('+'), extension, selection: checked };
}
module.exports = { normalizeCatalog, validateSelection, selectionFormat };
