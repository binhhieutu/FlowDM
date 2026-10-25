'use strict';
(() => {
  const byId = id => document.getElementById(id);
  let inspected = null, inspectedUrl = '', generation = 0;
  const formatLabel = format => {
    const quality = format.hasVideo ? `${format.height || '?'}p${format.fps ? ` · ${format.fps} fps` : ''}` : 'Âm thanh';
    const codecs = [format.hasVideo ? format.vcodec : '', format.hasAudio ? format.acodec : ''].filter(Boolean).map(value => value.split('.')[0]).join(' + ');
    const size = format.estimatedBytes ? ` · ~${(format.estimatedBytes / 1024 ** 2).toFixed(1)} MiB` : '';
    return `${quality} · ${codecs} · ${format.ext.toUpperCase()}${size}`;
  };
  function error(message) { byId('form-error').textContent = message; byId('form-error').hidden = false; }
  function reset() {
    generation++; inspected = null; inspectedUrl = '';
    byId('media-catalog').hidden = true; byId('inspect-media').disabled = false;
    byId('submit-download').disabled = byId('add-form').dataset.busy === 'true'; byId('filename').disabled = false; byId('start-at').disabled = false;
    byId('media-inspect-status').textContent = '';
    byId('playlist-entries').replaceChildren(); byId('media-subtitles').replaceChildren();
  }
  function options(select, formats) {
    select.replaceChildren(...formats.map(format => new Option(formatLabel(format), format.id)));
  }
  function updateMode() {
    if (!inspected || inspected.entries.length) return;
    const audioOnly = byId('media-mode').value === 'audio';
    const video = inspected.formats.find(format => format.id === byId('media-video-format').value);
    byId('media-video-field').hidden = audioOnly;
    byId('media-audio-format').disabled = !audioOnly && !!video?.hasAudio;
    byId('media-subtitle-field').hidden = audioOnly;
    if (audioOnly) for (const checkbox of byId('media-subtitles').querySelectorAll('input')) checkbox.checked = false;
    byId('media-selection-hint').textContent = audioOnly ? 'Chỉ tải track âm thanh đã chọn, không đổi chất lượng âm thầm.' : 'Chọn đúng video và âm thanh. Khi chọn phụ đề, kết quả là một tệp MKV có phụ đề nhúng.';
  }
  function showSingle(catalog) {
    byId('media-format-fields').hidden = false; byId('media-playlist-fields').hidden = true;
    const videos = catalog.formats.filter(format => format.hasVideo).sort((a, b) => (b.height || 0) - (a.height || 0) || (b.fps || 0) - (a.fps || 0));
    const audios = catalog.formats.filter(format => format.hasAudio && !format.hasVideo).sort((a, b) => Number(b.ext === 'm4a') - Number(a.ext === 'm4a'));
    options(byId('media-video-format'), videos); options(byId('media-audio-format'), audios);
    const compatible = videos.find(format => format.height <= 1080 && /^(avc|h264)/i.test(format.vcodec));
    if (compatible) byId('media-video-format').value = compatible.id;
    byId('media-mode').value = videos.length ? 'video' : 'audio';
    byId('media-mode').querySelector('[value="video"]').disabled = !videos.length;
    byId('media-mode').querySelector('[value="audio"]').disabled = !audios.length;
    byId('media-subtitles').replaceChildren(...catalog.subtitles.map(track => {
      const label = document.createElement('label'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = track.id;
      label.append(checkbox, document.createTextNode(`${track.language}${track.automatic ? ' (tự động)' : ' (thủ công)'}`)); return label;
    }));
    if (!catalog.subtitles.length) byId('media-subtitles').textContent = 'Nguồn này chưa cung cấp phụ đề VTT/SRT phù hợp.';
    updateMode();
  }
  function showPlaylist(catalog) {
    byId('media-format-fields').hidden = true; byId('media-playlist-fields').hidden = false;
    byId('filename').disabled = true; byId('start-at').disabled = true;
    byId('playlist-entries').replaceChildren(...catalog.entries.map(entry => {
      const label = document.createElement('label'); const checkbox = document.createElement('input'); checkbox.type = 'checkbox'; checkbox.value = entry.id;
      label.append(checkbox, document.createTextNode(entry.title || entry.id)); return label;
    }));
    byId('playlist-hint').textContent = `${catalog.entries.length} video công khai đầu tiên (tối đa 100). Chọn các mục cần tải; tên tệp theo tiêu đề, chất lượng mặc định của ứng dụng. Tác vụ lỗi không hủy các video khác.`;
  }
  byId('inspect-media').addEventListener('click', async () => {
    if (byId('add-form').dataset.busy === 'true') return;
    reset(); const request = generation, url = byId('url').value.trim();
    byId('inspect-media').disabled = true; byId('submit-download').disabled = true; byId('form-error').hidden = true;
    byId('media-inspect-status').textContent = 'Đang kiểm tra định dạng và danh sách video…';
    try {
      const input = { url }; const kind = byId('media-type').value;
      if (['dash', 'youtube'].includes(kind)) input.mediaType = kind;
      const result = await window.flow.inspectMedia(input);
      if (request !== generation || byId('url').value.trim() !== url) return;
      if (!result.ok) throw Error(result.error);
      const catalog = result.data;
      if (!catalog.formats.length && !catalog.entries.length) throw Error('Không tìm thấy định dạng hoặc video công khai có thể tải.');
      inspected = catalog; inspectedUrl = url; byId('media-catalog-title').textContent = catalog.title || 'Lựa chọn tải';
      byId('media-catalog').hidden = false;
      if (catalog.entries.length) showPlaylist(catalog); else showSingle(catalog);
    } catch (failure) { if (request === generation) error(failure.message); }
    finally {
      if (request === generation) { byId('inspect-media').disabled = false; byId('submit-download').disabled = byId('add-form').dataset.busy === 'true'; byId('media-inspect-status').textContent = ''; }
    }
  });
  byId('media-mode').addEventListener('change', updateMode); byId('media-video-format').addEventListener('change', updateMode);
  byId('url').addEventListener('input', reset); byId('media-type').addEventListener('change', reset);
  byId('clear-media-selection').addEventListener('click', reset);
  byId('playlist-select-all').addEventListener('click', () => {
    const boxes = [...byId('playlist-entries').querySelectorAll('input')]; const value = boxes.some(box => !box.checked); for (const box of boxes) box.checked = value;
  });
  window.mediaChoice = {
    reset,
    optionsForUrl(url) {
      if (!inspected) return {};
      if (url !== inspectedUrl) throw Error('Liên kết đã thay đổi. Hãy kiểm tra lại chất lượng.');
      if (inspected.entries.length) {
        const entryIds = [...byId('playlist-entries').querySelectorAll('input:checked')].map(box => box.value);
        if (!entryIds.length) throw Error('Chọn ít nhất một video trong playlist.');
        return { playlist: true, catalogId: inspected.catalogId, entryIds };
      }
      const mode = byId('media-mode').value;
      const selection = { mode, subtitleIds: [...byId('media-subtitles').querySelectorAll('input:checked')].map(box => box.value) };
      if (mode === 'video') {
        selection.videoFormatId = byId('media-video-format').value;
        if (!byId('media-audio-format').disabled) selection.audioFormatId = byId('media-audio-format').value;
      } else selection.audioFormatId = byId('media-audio-format').value;
      return { catalogId: inspected.catalogId, selection };
    }
  };
})();
