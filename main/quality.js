'use strict';

/**
 * Варианты качества — те же, что в Android-версии (QualityPreset.kt).
 *
 * Данные лежат рядом с подписью: сравнение русских подписей через contains("720")
 * когда-то ломало и выбор формата, и фильтрацию по доступности.
 */

const KIND_VIDEO = 'VIDEO';
const KIND_AUDIO = 'AUDIO';
const KIND_AVI = 'AVI';

/**
 * @typedef {Object} QualityPreset
 * @property {string} id          стабильный идентификатор для UI
 * @property {string} label       подпись пункта списка
 * @property {string} kind        VIDEO | AUDIO | AVI
 * @property {number} minLongEdge длинная сторона кадра, которую должен уметь отдать ролик (0 — без фильтра)
 * @property {number} maxHeight   потолок высоты для -f (0 — без ограничения)
 * @property {number} bitrate     битрейт для предварительной оценки размера
 */

/** HDR имеет смысл только для видео: в mp3 его нет, а AVI перекодируется в Xvid 8 бит. */
function supportsHdr(preset) {
  return preset.kind === KIND_VIDEO;
}

/**
 * Значение для `-f`. Для аудио не используется — там достаточно `bestaudio`.
 *
 * HDR отдельным фильтром не запрашивается намеренно: yt-dlp сортирует форматы
 * по `res`, а `hdr` идёт следующим полем, поэтому при равном разрешении он сам берёт
 * HDR-поток, а при его отсутствии — SDR. Если поставить HDR первым фильтром, ролик,
 * у которого HDR есть только в 1080p, скачался бы в 1080p вместо доступного 4K.
 */
function formatSelector(preset) {
  if (preset.kind === KIND_AUDIO) return 'bestaudio';
  const h = preset.maxHeight;
  return (
    `bestvideo[height<=${h}][ext=mp4]+bestaudio[ext=m4a]` +
    `/bestvideo[height<=${h}]+bestaudio` +
    `/best[height<=${h}]/best`
  );
}

const PRESETS = [
  { id: 'uhd8640', label: '16K Ultra HD (8640p)', kind: KIND_VIDEO, minLongEdge: 15360, maxHeight: 8640, bitrate: 120000000 },
  { id: 'uhd4320', label: '8K Ultra HD (4320p)', kind: KIND_VIDEO, minLongEdge: 7680, maxHeight: 4320, bitrate: 45000000 },
  { id: 'uhd2160', label: '4K Ultra HD (2160p)', kind: KIND_VIDEO, minLongEdge: 3840, maxHeight: 2160, bitrate: 18000000 },
  { id: 'qhd1440', label: '2K Quad HD (1440p)', kind: KIND_VIDEO, minLongEdge: 2560, maxHeight: 1440, bitrate: 9000000 },
  { id: 'fhd1080', label: '1080p Full HD', kind: KIND_VIDEO, minLongEdge: 1920, maxHeight: 1080, bitrate: 3500000 },
  { id: 'hd720', label: '720p HD', kind: KIND_VIDEO, minLongEdge: 1280, maxHeight: 720, bitrate: 2000000 },
  { id: 'sd480', label: '480p SD', kind: KIND_VIDEO, minLongEdge: 854, maxHeight: 480, bitrate: 1000000 },
  { id: 'sd360', label: '360p', kind: KIND_VIDEO, minLongEdge: 640, maxHeight: 360, bitrate: 600000 },
  { id: 'mp3', label: 'Аудио (MP3)', kind: KIND_AUDIO, minLongEdge: 0, maxHeight: 0, bitrate: 160000 },
  // Потолок 720p: перекодировать 4K в Xvid бессмысленно — старые плееры его
  // не потянут, а конвертация займёт в разы больше времени.
  { id: 'avi', label: 'AVI для старых ТВ (Xvid)', kind: KIND_AVI, minLongEdge: 0, maxHeight: 720, bitrate: 2400000 }
];

const DEFAULT_ID = 'hd720';

function byId(id) {
  return PRESETS.find((p) => p.id === id) || PRESETS.find((p) => p.id === DEFAULT_ID);
}

/** Есть ли в ролике разрешение, достаточное для этого пункта. */
function isAvailableIn(preset, resolutions) {
  if (!preset.minLongEdge) return true;
  return resolutions.some(([w, h]) => Math.max(w, h) >= preset.minLongEdge);
}

/** Только те пункты, которые реально доступны для этого ролика. */
function availableIn(resolutions) {
  if (!resolutions || resolutions.length === 0) return PRESETS.slice();
  const filtered = PRESETS.filter((p) => isAvailableIn(p, resolutions));
  return filtered.length ? filtered : PRESETS.slice();
}

module.exports = {
  KIND_VIDEO,
  KIND_AUDIO,
  KIND_AVI,
  PRESETS,
  DEFAULT_ID,
  byId,
  availableIn,
  formatSelector,
  supportsHdr
};
