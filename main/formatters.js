'use strict';

/**
 * Форматирование размеров и длительности — аналог Formatters.kt.
 * Правило одно на всё приложение: у Android-версии когда-то было две копии
 * формата размера с разными правилами, и цифры в списке и в галерее расходились.
 */

const BYTES_IN_MB = 1024 * 1024;
const MB_IN_GB = 1024;

/** «12 МБ», «1.35 ГБ». */
function size(bytes) {
  if (!bytes || bytes <= 0) return '—';
  const mb = bytes / BYTES_IN_MB;
  return mb >= MB_IN_GB ? `${(mb / MB_IN_GB).toFixed(2)} ГБ` : `${mb.toFixed(1)} МБ`;
}

/** Предварительная оценка размера для списка качества: «≈ 42.1 МБ». */
function estimatedSize(bytes) {
  const text = size(bytes);
  return text === '—' ? text : `≈ ${text}`;
}

/** Приблизительный размер из длительности и битрейта. */
function estimateBytes(durationSec, bitrateBps) {
  return durationSec > 0 ? Math.round((durationSec * bitrateBps) / 8) : 0;
}

/** «45 с», «8 мин 20 с», «1 ч 15 мин». */
function eta(seconds) {
  if (!seconds || seconds <= 0) return '';
  if (seconds >= 3600) {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    return minutes > 0 ? `${hours} ч ${minutes} мин` : `${hours} ч`;
  }
  if (seconds >= 60) {
    const minutes = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return secs > 0 ? `${minutes} мин ${secs} с` : `${minutes} мин`;
  }
  return `${seconds} с`;
}

/** Таймкод плеера: «1:05:09» или «5:09». */
function timecode(milliseconds) {
  const total = Math.floor((milliseconds || 0) / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

module.exports = { size, estimatedSize, estimateBytes, eta, timecode };
