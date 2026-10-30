'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const paths = require('./paths');
const settings = require('./settings');
const auth = require('./auth');
const quality = require('./quality');

/**
 * Всё общение с yt-dlp: сборка запросов, запуск процесса, разбор прогресса и ошибок.
 *
 * Аналог YtDlpEngine.kt. На Android движок жил в библиотеке youtubedl-android;
 * здесь это обычный yt-dlp.exe рядом с приложением, но набор опций и логика
 * выбора формата повторяют мобильную версию, чтобы результат скачивания совпадал.
 */

/** Как часто подтягивать свежий yt-dlp. YouTube ломает старые версии примерно раз в месяц. */
const UPDATE_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Активный процесс — чтобы загрузку можно было отменить. */
let currentChild = null;

function binaryPath() {
  return paths.ytDlpPath();
}

function ffmpegLocation() {
  return path.dirname(paths.ffmpegPath());
}

/** Проверка, что обе программы на месте; иначе понятная ошибка вместо «spawn ENOENT». */
function assertBinaries() {
  const ytDlp = paths.ytDlpPath();
  const ffmpeg = paths.ffmpegPath();
  if (!fs.existsSync(ytDlp)) {
    const err = new Error(`Не найден yt-dlp.exe (${ytDlp}). Переустановите приложение.`);
    err.code = 'YTDLP_MISSING';
    throw err;
  }
  if (!fs.existsSync(ffmpeg)) {
    const err = new Error(`Не найден ffmpeg.exe (${ffmpeg}). Переустановите приложение.`);
    err.code = 'FFMPEG_MISSING';
    throw err;
  }
}

/**
 * Раз в сутки пробует обновить yt-dlp.
 *
 * Приложение поставляет свою сборку движка, а YouTube регулярно меняет плеер:
 * старая версия начинает отвечать 403 и «Sign in to confirm you're not a bot»
 * даже с валидными cookies. Дата ставится до попытки — иначе без сети
 * обновление запрашивалось бы на каждом запуске.
 */
async function updateEngineIfStale() {
  const s = settings.read();
  const now = Date.now();
  if (now - (s.lastEngineUpdateAt || 0) < UPDATE_INTERVAL_MS) {
    return { updated: false, reason: 'fresh' };
  }

  settings.write({ lastEngineUpdateAt: now });

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(binaryPath(), ['-U'], { windowsHide: true });
    } catch (e) {
      resolve({ updated: false, reason: e.message });
      return;
    }

    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('error', (e) => resolve({ updated: false, reason: e.message }));
    child.on('close', (code) => resolve({ updated: code === 0, output: out.trim().slice(-400) }));
  });
}

/**
 * Опции JS-рантайма для решения `n challenge` на YouTube.
 *
 * Без решённого challenge YouTube отдаёт только раскадровку, и любая загрузка
 * падает с «Requested format is not available». Своё решение требует JS-рантайма;
 * yt-dlp по умолчанию ищет только deno, которого у пользователя нет.
 *
 * Отдельный Node в сборку не кладём: Electron — это тот же Node (v24), и в режиме
 * ELECTRON_RUN_AS_NODE он исполняет скрипты солвера. Скрипт берётся из самого
 * yt-dlp (пакет yt_dlp_ejs), поэтому сеть для него не нужна.
 */
function jsRuntimeArgs() {
  const exe = paths.exePath();
  if (!exe) return [];
  return ['--js-runtimes', `node:${exe}`];
}

/** Базовые опции, общие для метаданных и скачивания. */
function baseArgs(url) {
  const args = [
    '--no-playlist',
    '--no-check-certificates',
    '-4',
    '--no-warnings',
    '--ffmpeg-location', ffmpegLocation(),
    ...jsRuntimeArgs()
  ];
  const cookies = auth.cookiesArg();
  if (cookies) args.push('--cookies', cookies);
  args.push(url);
  return args;
}

/**
 * Запускает yt-dlp.
 *
 * Вывод отдаётся построчно: yt-dlp пишет прогресс через `\r`, поэтому строки
 * режутся по `\r` и `\n` — иначе процент приходил бы одним куском в конце.
 * Строки режутся только при построчной обработке ([splitLines]); сырой stdout
 * при этом копится целиком, потому что JSON метаданных может содержать `\r`
 * внутри строк, и разбиение по нему сломало бы разбор.
 *
 * @param {string[]} args
 * @param {{onLine?: (line: string, isError: boolean) => void, splitLines?: boolean}} handlers
 */
function run(args, handlers = {}) {
  assertBinaries();

  const child = spawn(binaryPath(), args, {
    windowsHide: true,
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      // Без неё Electron запускает окно вместо интерпретатора, и солвер не работает
      ELECTRON_RUN_AS_NODE: '1'
    }
  });
  currentChild = child;

  const splitLines = handlers.splitLines !== false;
  let stderr = '';
  let stdout = '';

  // Буфер неполной строки: чанк может оборваться посреди строки, и тогда
  // склеенные половины дали бы битую строку прогресса.
  let lineBuffer = '';

  const handle = (chunk, isError) => {
    const text = chunk.toString('utf8');
    if (isError) stderr += text; else stdout += text;
    if (!splitLines || !handlers.onLine) return;

    lineBuffer += text;
    const lines = lineBuffer.split(/\r\n|\r|\n/);
    lineBuffer = lines.pop();
    for (const line of lines) {
      if (line.trim()) handlers.onLine(line, isError);
    }
  };

  child.stdout.on('data', (d) => handle(d, false));
  child.stderr.on('data', (d) => handle(d, true));

  const done = new Promise((resolve) => {
    child.on('error', (e) => {
      if (currentChild === child) currentChild = null;
      resolve({ code: -1, error: e, stderr, stdout });
    });
    child.on('close', (code) => {
      if (currentChild === child) currentChild = null;
      resolve({ code, error: null, stderr, stdout });
    });
  });

  return { child, done };
}

/** Прерывает текущую загрузку. */
function cancel() {
  if (!currentChild) return false;
  try {
    currentChild.kill();
  } catch (e) {
    return false;
  }
  return true;
}

function isRunning() {
  return currentChild !== null;
}

// --------------------------------------------------------------- метаданные

/**
 * Метаданные ролика (`-J`).
 *
 * JSON приходит в stdout целиком, поэтому копим его и разбираем после выхода.
 * Строки здесь не режутся (splitLines: false): в названиях роликов встречается
 * `\r`, и построчная склейка ломала бы JSON.
 *
 * @returns {Promise<object>}
 */
async function fetchInfo(url) {
  const args = ['-J', '--no-progress', ...baseArgs(url)];

  const { done } = run(args, { splitLines: false });

  const result = await done;
  const stdout = result.stdout;

  if (result.code !== 0) {
    const err = new Error(cleanError(result.stderr, 'Не удалось получить информацию'));
    err.raw = result.stderr;
    throw err;
  }

  try {
    return JSON.parse(stdout);
  } catch (e) {
    const err = new Error('Не удалось разобрать ответ YouTube');
    err.raw = stdout.slice(0, 500);
    throw err;
  }
}

/**
 * Доступные разрешения ролика.
 *
 * Форматы без видеодорожки (audio-only) не считаются: иначе ролик, у которого
 * нет 4K, но есть аудио с большим `height`, показал бы лишние пункты.
 */
function availableResolutions(info) {
  const fromFormats = (info.formats || [])
    .filter((f) => f.vcodec && f.vcodec !== 'none')
    .map((f) => [f.width || 0, f.height || 0])
    .filter(([w, h]) => w > 0 || h > 0);

  const root = [info.width || 0, info.height || 0];
  return root[0] > 0 || root[1] > 0 ? [...fromFormats, root] : fromFormats;
}

/** Кодек VP9.2 / AV1 с битностью 10 — признаки HDR-потока на YouTube. */
function isHdrFormat(format) {
  const note = format.format_note || '';
  if (/hdr/i.test(note)) return true;

  const codec = (format.vcodec || '').toLowerCase();
  if (codec.startsWith('vp9.2') || codec.startsWith('vp09.02')) return true;

  // av01.PPMM.LL…: поле LL — битность (08 = 8 бит SDR, 10 = 10 бит HDR)
  if (codec.startsWith('av01.')) {
    const parts = codec.split('.');
    if (parts[3] === '10') return true;
  }
  return false;
}

/**
 * Будет ли скачан HDR-поток при выборе пункта с потолком maxHeight.
 *
 * Повторяет то, что сделает сам yt-dlp: он сортирует по `res`, затем `fps`,
 * затем `hdr`, поэтому HDR выбирается только среди форматов с максимальным
 * разрешением и частотой кадров. Ролик, у которого HDR есть лишь в 1080p,
 * а 4K только в SDR, честно покажет «4K» без пометки HDR.
 *
 * Первая ветка селектора ограничена `[ext=mp4]`, поэтому mp4 проверяется
 * первым: иначе пометка стояла бы у ролика, где HDR есть только в webm.
 */
function willDownloadHdr(info, maxHeight) {
  const candidates = (info.formats || []).filter(
    (f) => f.vcodec && f.vcodec !== 'none' && f.height >= 1 && f.height <= maxHeight
  );

  const mp4 = candidates.filter((f) => f.ext === 'mp4');
  const pool = mp4.length ? mp4 : candidates;

  const score = (f) => [f.height || 0, f.fps || 0, isHdrFormat(f) ? 1 : 0];
  let best = null;
  for (const f of pool) {
    if (!best) { best = f; continue; }
    const a = score(f);
    const b = score(best);
    for (let i = 0; i < a.length; i++) {
      if (a[i] !== b[i]) {
        if (a[i] > b[i]) best = f;
        break;
      }
    }
  }
  return best ? isHdrFormat(best) : false;
}

// --------------------------------------------------------------- скачивание

/**
 * Аргументы скачивания.
 *
 * @param {string} url
 * @param {object} preset пункт из quality.js
 * @param {string} tempDir куда качать до сохранения
 * @param {string} [cookiesFile] подмена файла кук (используется при обновлении сессии)
 */
function downloadArgs(url, preset, tempDir, cookiesFile) {
  const args = ['--newline', '--no-mtime', '--progress', '-o', path.join(tempDir, '%(title)s.%(ext)s')];

  if (preset.kind === quality.KIND_AUDIO) {
    args.push('-x', '--audio-format', 'mp3', '-f', quality.formatSelector(preset));
  } else {
    args.push('--merge-output-format', 'mp4', '-f', quality.formatSelector(preset));
  }

  const base = baseArgs(url);
  if (cookiesFile) {
    const idx = base.indexOf('--cookies');
    if (idx >= 0) base.splice(idx, 2);
    base.splice(base.length - 1, 0, '--cookies', cookiesFile);
  }

  return [...args, ...base];
}

/**
 * Разбирает строку прогресса yt-dlp.
 * @returns {{percent: number, eta: number}|null}
 */
function parseProgress(line) {
  // [download]  42.3% of  123.45MiB at  1.23MiB/s ETA 00:12
  const match = line.match(/\[download\]\s+([\d.]+)%(?:\s+of\s+\S+)?(?:\s+at\s+\S+)?(?:\s+ETA\s+(\d+):(\d+))?/);
  if (!match) return null;

  const percent = Number.parseFloat(match[1]);
  const eta = match[2] != null ? Number(match[2]) * 60 + Number(match[3]) : 0;
  return { percent: Number.isFinite(percent) ? percent : 0, eta };
}

// ------------------------------------------------------------------ ошибки

/**
 * Достаёт из многословного вывода yt-dlp одну строку, пригодную для показа,
 * и подменяет типовые отказы YouTube понятным текстом.
 */
function cleanError(raw, fallback) {
  if (!raw || !raw.trim()) return fallback;

  const lines = raw.split(/\r?\n/).filter((l) => l.trim() && !l.startsWith('Usage:'));
  const errorLine =
    lines.find((l) => l.startsWith('ERROR:') || l.startsWith('yt-dlp: error:')) ||
    lines[0] ||
    raw;

  const forbidden =
    errorLine.includes('403') ||
    errorLine.includes('SABR') ||
    /not a bot/i.test(errorLine) ||
    /Sign in to confirm/i.test(errorLine) ||
    /confirm your age/i.test(errorLine);

  if (forbidden) {
    return 'YouTube отклонил запрос (403). Откройте «Аккаунт» и обновите вход.';
  }

  return errorLine
    .replace(/^ERROR:\s*/, '')
    .replace(/^yt-dlp: error:\s*/, '')
    .trim() || fallback;
}

module.exports = {
  binaryPath,
  ffmpegLocation,
  assertBinaries,
  updateEngineIfStale,
  baseArgs,
  downloadArgs,
  fetchInfo,
  availableResolutions,
  willDownloadHdr,
  parseProgress,
  cleanError,
  run,
  cancel,
  isRunning
};
