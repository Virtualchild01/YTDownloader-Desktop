'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const paths = require('./paths');

/**
 * Файлы на диске: сохранение скачанного, список для галереи, удаление, превью.
 *
 * Аналог DownloadStorage.kt. На Android файлы складывались в MediaStore
 * (Movies/Music), здесь — в одну папку, которую пользователь выбирает в настройках.
 * Внутри папки приложение ведёт свой индекс: он помнит длительность и дату
 * скачивания, которых у файловой системы нет, и не даёт галерее показывать
 * чужие файлы, случайно оказавшиеся в той же папке.
 */

const MEDIA_EXTENSIONS = new Set([
  'mp4', 'mkv', 'webm', 'avi', 'mov', 'm4a', 'mp3', 'opus', 'ogg', 'aac', 'flac', 'wav'
]);

const MIME = {
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mkv: 'video/x-matroska',
  webm: 'video/webm',
  avi: 'video/x-msvideo',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/mp4',
  opus: 'audio/opus',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  wav: 'audio/wav'
};

function extensionOf(name) {
  const idx = name.lastIndexOf('.');
  return idx > 0 ? name.slice(idx + 1).toLowerCase() : '';
}

function isMediaFile(name) {
  return MEDIA_EXTENSIONS.has(extensionOf(name));
}

function mimeFromName(name) {
  return MIME[extensionOf(name)] || 'application/octet-stream';
}

/**
 * Приводит название ролика к имени файла.
 *
 * Windows запрещает \ / : * ? " < > | и управляющие символы, а имя не может
 * кончаться точкой или пробелом. Список тот же, что у Android-версии, плюс
 * хвостовая точка — без неё Проводник не даёт создать файл.
 */
function sanitizeName(name) {
  const cleaned = String(name)
    .replace(/[\\/:*?"<>|\u0000-\u001F]/g, '_')
    .trim()
    .replace(/^\.+/, '')
    .replace(/[. ]+$/, '');
  return cleaned || `video_${Date.now()}`;
}

/** Свободное имя в папке: «Ролик.mp4» → «Ролик (1).mp4». */
function uniqueFile(dir, displayName) {
  const ext = path.extname(displayName);
  const base = displayName.slice(0, displayName.length - ext.length);

  let candidate = path.join(dir, displayName);
  let counter = 1;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base} (${counter})${ext}`);
    counter += 1;
  }
  return candidate;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// ------------------------------------------------------------------ индекс

function indexPath() {
  return path.join(paths.appDataDir(), 'downloads.json');
}

let indexCache = null;

function readIndex() {
  if (indexCache) return indexCache;
  try {
    const parsed = JSON.parse(fs.readFileSync(indexPath(), 'utf8'));
    indexCache = parsed && typeof parsed === 'object' ? parsed : {};
  } catch (e) {
    indexCache = {};
  }
  return indexCache;
}

function writeIndex() {
  try {
    fs.mkdirSync(path.dirname(indexPath()), { recursive: true });
    fs.writeFileSync(indexPath(), JSON.stringify(indexCache, null, 2), 'utf8');
  } catch (e) {
    // Индекс — подсказка, а не источник правды: файл всё равно виден в папке
  }
}

function rememberFile(filePath, meta) {
  const index = readIndex();
  index[filePath] = {
    ...(index[filePath] || {}),
    ...meta,
    addedAt: (index[filePath] && index[filePath].addedAt) || Date.now()
  };
  writeIndex();
}

function forgetFile(filePath) {
  const index = readIndex();
  if (index[filePath]) {
    delete index[filePath];
    writeIndex();
  }
}

// ---------------------------------------------------------------- запись

/**
 * Переносит готовый файл из временной папки в папку загрузок.
 * @returns {{path: string, name: string}|null}
 */
function save(sourcePath, displayName, extra = {}) {
  const dir = ensureDir(require('./settings').downloadDir());  const safeName = sanitizeName(displayName);
  const target = uniqueFile(dir, safeName);

  try {
    // rename в пределах тома мгновенный, но temp может лежать на другом диске
    try {
      fs.renameSync(sourcePath, target);
    } catch (e) {
      fs.copyFileSync(sourcePath, target);
      fs.unlinkSync(sourcePath);
    }
  } catch (e) {
    return null;
  }

  rememberFile(target, {
    durationMs: Math.round((extra.durationSec || 0) * 1000),
    title: extra.title || path.basename(target, path.extname(target)),
    uploader: extra.uploader || ''
  });

  return { path: target, name: path.basename(target) };
}

// ---------------------------------------------------------------- чтение

/**
 * Список скачанного в текущей папке.
 *
 * Берутся только файлы с медиа-расширением: в папку пользователя могут
 * попасть посторонние файлы, и галерея не должна их показывать.
 */
function list() {
  const dir = require('./settings').downloadDir();
  const index = readIndex();

  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch (e) {
    return [];
  }

  const items = [];
  for (const name of names) {
    if (!isMediaFile(name)) continue;

    const full = path.join(dir, name);
    let stat;
    try {
      stat = fs.statSync(full);
    } catch (e) {
      continue;
    }
    if (!stat.isFile()) continue;

    const meta = index[full] || {};
    items.push({
      path: full,
      name,
      sizeBytes: stat.size,
      dateAddedSec: Math.floor(((meta.addedAt || stat.mtimeMs) || 0) / 1000),
      durationMs: meta.durationMs || 0,
      mimeType: mimeFromName(name),
      isAudio: mimeFromName(name).startsWith('audio/')
    });
  }

  return items.sort((a, b) => b.dateAddedSec - a.dateAddedSec);
}

/**
 * Удаляет файл. Сначала в корзину: случайно удалённый ролик ещё можно вернуть.
 * @returns {Promise<boolean>}
 */
async function remove(filePath, shell) {
  try {
    if (shell && typeof shell.trashItem === 'function') {
      await shell.trashItem(filePath);
    } else {
      fs.unlinkSync(filePath);
    }
    forgetFile(filePath);
    return true;
  } catch (e) {
    // Файла нет — считаем, что цель достигнута
    if (e && e.code === 'ENOENT') {
      forgetFile(filePath);
      return true;
    }
    return false;
  }
}

// ---------------------------------------------------------------- превью

/**
 * Превью для плитки галереи: кадр из видео или обложка mp3.
 *
 * Кэшируется рядом с настройками по пути и mtime файла — иначе прокрутка
 * галереи запускала бы ffmpeg на каждую карточку при каждом открытии.
 *
 * @returns {Promise<string|null>} путь к PNG или null, если кадр не получился
 */
function thumbnail(filePath, durationMs) {
  const cacheDir = path.join(paths.appDataDir(), 'thumbs');
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (e) {
    return null;
  }

  const key = `${path.basename(filePath)}.${stat.size}.${Math.floor(stat.mtimeMs)}`
    .replace(/[^\w.-]+/g, '_');
  const target = path.join(cacheDir, `${key}.png`);
  if (fs.existsSync(target)) return Promise.resolve(target);

  const seekSec = durationMs > 0 ? Math.min(Math.max(durationMs / 1000 * 0.1, 0), 30) : 1;

  return new Promise((resolve) => {
    let child;
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      child = spawn(paths.ffmpegPath(), [
        '-y', '-hide_banner', '-loglevel', 'error',
        '-ss', String(Math.round(seekSec * 10) / 10),
        '-i', filePath,
        '-frames:v', '1',
        '-vf', 'scale=480:-2',
        '-q:v', '4',
        target
      ], { windowsHide: true });
    } catch (e) {
      resolve(null);
      return;
    }

    child.on('error', () => resolve(null));
    child.on('close', (code) => {
      resolve(code === 0 && fs.existsSync(target) ? target : null);
    });
  });
}

module.exports = {
  MEDIA_EXTENSIONS,
  ensureDir,
  isMediaFile,
  mimeFromName,
  sanitizeName,
  uniqueFile,
  save,
  list,
  remove,
  thumbnail,
  rememberFile
};
