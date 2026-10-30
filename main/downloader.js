'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { EventEmitter } = require('node:events');
const paths = require('./paths');
const settings = require('./settings');
const auth = require('./auth');
const quality = require('./quality');
const ytdlp = require('./ytdlp');
const storage = require('./storage');
const formatters = require('./formatters');

/**
 * Скачивание и постобработка.
 *
 * Аналог DownloadController.kt: контроллер живёт в главном процессе, окно только
 * подписывается на события и отписывается при закрытии — сама загрузка от этого
 * не зависит. Окно можно свернуть или перезапустить, прогресс не потеряется.
 */

const EVENTS = new EventEmitter();

const state = {
  running: false,
  percent: 0,
  statusText: null,
  outcome: null // { ok: true } | { ok: false, message }
};

function emitProgress(percent, text) {
  state.percent = percent;
  state.statusText = text;
  EVENTS.emit('progress', { percent, text });
}

function emitCompleted() {
  state.statusText = null;
  state.outcome = { ok: true };
  EVENTS.emit('completed');
}

function emitFailed(message) {
  state.statusText = message;
  state.outcome = { ok: false, message };
  EVENTS.emit('failed', { message });
}

/** Отдаёт итог один раз: иначе каждое возвращение в окно показывало бы то же сообщение. */
function consumeOutcome() {
  const outcome = state.outcome;
  state.outcome = null;
  return outcome;
}

function snapshot() {
  return {
    running: state.running,
    percent: state.percent,
    statusText: state.statusText
  };
}

/**
 * @param {string} url исходная ссылка: webpageUrl у некоторых экстракторов пустой
 * @param {object} video метаданные из yt-dlp
 * @param {object} preset пункт качества
 * @param {object} [opts] { startedAt } — откуда продолжать нумерацию временных папок
 */
function start(url, video, preset, opts = {}) {
  if (state.running) return false;

  state.running = true;
  state.percent = 0;
  state.statusText = null;
  state.outcome = null;

  runDownload(url, video, preset, opts).catch((e) => {
    emitFailed(ytdlp.cleanError(e && e.message, 'Ошибка скачивания'));
  }).finally(() => {
    state.running = false;
    EVENTS.emit('idle');
  });

  return true;
}

function cancel() {
  if (!state.running) return false;
  ytdlp.cancel();
  return true;
}

function tempDirFor() {
  const dir = path.join(paths.tmpRoot(), String(Date.now()));
  storage.ensureDir(dir);
  return dir;
}

async function runDownload(url, video, preset, opts) {
  const tempDir = tempDirFor();
  const cookiesFile = auth.cookiesArg();
  const durationSec = Number(video.duration) || 0;

  try {
    emitProgress(0, 'Скачивание видео: 0%');

    const saved = await downloadFiles(url, video, preset, tempDir, cookiesFile, durationSec);
    if (!saved) return;

    emitCompleted();
  } catch (e) {
    emitFailed(ytdlp.cleanError(e && e.message, 'Ошибка скачивания'));
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {
      // временная папка уберётся при следующем запуске
    }
  }
}

/**
 * Скачивает в temp и сохраняет результат в папку загрузок.
 * @returns {Promise<Array<{path: string, name: string}>|null>} null — ошибка уже отправлена
 */
async function downloadFiles(url, video, preset, tempDir, cookiesFile, durationSec) {
  const args = ytdlp.downloadArgs(url, preset, tempDir, cookiesFile);

  let audioStage = false;
  let lastPercent = 0;
  let merging = false;

  const { done } = ytdlp.run(args, {
    onLine: (line) => {
      // Вторая дорожка (m4a/opus) или сброс прогресса — признак, что видео уже скачано
      if (
        /\.m4a|\.mp3|\.opus/i.test(line) ||
        /\[Merger\]|Merging formats/i.test(line) ||
        (lastPercent > 75 && /\[download\]\s+(\d+(\.\d+)?)%/.test(line) &&
          Number.parseFloat(line.match(/\[download\]\s+([\d.]+)%/)[1]) < 25)
      ) {
        audioStage = true;
      }

      if (/\[Merger\]|Merging formats/i.test(line)) merging = true;

      const parsed = ytdlp.parseProgress(line);
      if (!parsed) return;

      lastPercent = parsed.percent;
      reportProgress(parsed.percent, parsed.eta, audioStage, merging, preset);
    }
  });

  const result = await done;

  if (result.code !== 0) {
    // Отмена пользователем — не ошибка с точки зрения текста
    if (result.code === null || result.code === undefined) {
      emitFailed('Скачивание отменено');
      return null;
    }
    throw new Error(result.stderr || 'Ошибка скачивания');
  }

  const downloaded = fs.readdirSync(tempDir)
    .filter((name) => storage.isMediaFile(name))
    .map((name) => path.join(tempDir, name));

  if (downloaded.length === 0) {
    emitFailed('Не удалось сохранить файл в папку загрузок');
    return null;
  }

  const filesToSave = preset.kind === quality.KIND_AVI
    ? [await convertToAvi(downloaded[0], tempDir, durationSec)]
    : downloaded;

  if (filesToSave.some((f) => !f)) return null;

  const saved = [];
  for (const file of filesToSave) {
    const entry = storage.save(file, path.basename(file), {
      durationSec,
      title: video.title,
      uploader: video.uploader
    });
    if (entry) saved.push(entry);
  }

  if (saved.length === 0) {
    emitFailed('Не удалось сохранить файл в папку загрузок');
    return null;
  }

  return saved;
}

function reportProgress(progress, etaSeconds, audioStage, merging, preset) {
  // Проценты скачивания закончились, yt-dlp склеивает дорожки через FFmpeg
  const isMerging = preset.kind !== quality.KIND_AUDIO && (merging || (audioStage && progress >= 99));

  const stage = preset.kind === quality.KIND_AUDIO
    ? 'Скачивание аудио'
    : isMerging
      ? 'Объединение видео и аудио (FFmpeg)...'
      : audioStage
        ? 'Скачивание аудио'
        : 'Скачивание видео';

  const percent = Math.max(0, Math.min(100, Math.round(progress)));
  const eta = formatters.eta(etaSeconds);

  const text = isMerging
    ? stage
    : eta
      ? `${stage}: ${percent}% (~${eta})`
      : `${stage}: ${percent}%`;

  emitProgress(percent, text);
}

/**
 * Конвертация в AVI (Xvid + MP3) для старых телевизоров и DVD-плееров.
 *
 * Аргументы повторяют AviConverter.kt: тот же профиль совместимости, тот же
 * потолок 720p, тот же fallback с libxvid, если mpeg4 почему-то не завёлся.
 *
 * @returns {Promise<string|null>} путь к AVI или null (ошибка уже отправлена)
 */
function convertToAvi(source, tempDir, durationSec) {
  const target = path.join(tempDir, `${path.basename(source, path.extname(source))}.avi`);

  return runEncoder(source, target, durationSec, 'mpeg4').then(async (ok) => {
    if (ok) {
      try { fs.unlinkSync(source); } catch (e) { /* уже удалён */ }
      return target;
    }
    const fallback = await runEncoder(source, target, durationSec, 'libxvid');
    if (fallback) {
      try { fs.unlinkSync(source); } catch (e) { /* уже удалён */ }
      return target;
    }
    emitFailed('Конвертация не удалась');
    return null;
  });
}

function runEncoder(input, output, durationSec, encoder) {
  try { fs.unlinkSync(output); } catch (e) { /* файла ещё нет */ }

  const args = [
    '-y', '-hide_banner', '-nostats', '-loglevel', 'error', '-progress', 'pipe:1',
    '-i', input,
    '-vf', 'scale=-2:trunc(min(720\\,ih)/2)*2',
    '-c:v', encoder
  ];
  // mpeg4 умеет slice-многопоточность, libxvid — нет (FFmpeg всё равно сбросит в 1)
  if (encoder === 'mpeg4') args.push('-threads', '0');
  args.push(
    '-b:v', '2200k', '-pix_fmt', 'yuv420p',
    // B-кадры в упакованном bitstream ломают часть старых плееров
    '-bf', '0', '-vtag', 'XVID',
    '-c:a', 'libmp3lame', '-b:a', '128k', '-ar', '44100', '-ac', '2',
    '-f', 'avi', output
  );

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(paths.ffmpegPath(), args, { windowsHide: true });
    } catch (e) {
      resolve(false);
      return;
    }

    let buffer = '';
    const parse = (line) => {
      if (durationSec <= 0) return;
      const key = line.slice(0, line.indexOf('='));
      const value = line.slice(line.indexOf('=') + 1).trim();

      let seconds = null;
      if (key === 'out_time_us' || key === 'out_time_ms') seconds = Number(value) / 1e6;
      else if (key === 'out_time') {
        const parts = value.split(':').map(Number);
        if (parts.length === 3 && parts.every(Number.isFinite)) {
          seconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
        }
      }
      if (seconds == null || !Number.isFinite(seconds)) return;

      const percent = Math.max(0, Math.min(99, Math.round((seconds / durationSec) * 100)));
      emitProgress(percent, `Конвертация в AVI: ${percent}%`);
    };

    child.stdout.on('data', (d) => {
      buffer += d.toString('utf8');
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop();
      lines.forEach(parse);
    });

    // Без чтения stderr процесс упрётся в полный буфер и зависнет
    child.stderr.on('data', () => {});

    child.on('error', () => resolve(false));
    child.on('close', (code) => {
      let size = 0;
      try { size = fs.statSync(output).size; } catch (e) { size = 0; }
      resolve(code === 0 && size > 0);
    });
  });
}

module.exports = {
  EVENTS,
  start,
  cancel,
  snapshot,
  consumeOutcome
};
