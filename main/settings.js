'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const paths = require('./paths');

/**
 * Настройки в JSON-файле: тема, папка загрузок, служебные отметки движка.
 *
 * SharedPreferences на Android заменяет обычный JSON: файл маленький, читается
 * целиком при старте, а запись атомарная (через временный файл), чтобы
 * выключение питания не оставило пустой settings.json.
 */

const DEFAULTS = {
  theme: 'auto',            // auto | dark | light
  downloadDir: null,        // null — папка по умолчанию (Загрузки/YTDownloader)
  lastEngineUpdateAt: 0,    // когда последний раз обновляли yt-dlp
  lastUrl: ''               // ссылка из прошлого запуска
};

let cache = null;

function read() {
  if (cache) return cache;

  let stored = {};
  try {
    stored = JSON.parse(fs.readFileSync(paths.settingsPath(), 'utf8'));
  } catch (e) {
    stored = {};
  }

  cache = { ...DEFAULTS, ...(stored && typeof stored === 'object' ? stored : {}) };
  return cache;
}

function write(patch) {
  cache = { ...read(), ...patch };

  const file = paths.settingsPath();
  const tmp = `${file}.tmp`;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf8');
    fs.renameSync(tmp, file);
  } catch (e) {
    // Настройки не критичны для работы: продолжаем с тем, что уже в памяти
  }
  return cache;
}

/** Текущая папка загрузок с учётом пользовательской настройки. */
function downloadDir() {
  const custom = read().downloadDir;
  return custom && typeof custom === 'string' ? custom : paths.defaultDownloadDir();
}

/**
 * Версия приложения из package.json.
 *
 * app.getVersion() берёт версию Electron, если package.json не попал в сборку
 * или приложение запущено не из своей папки, поэтому читаем файл сами.
 */
function appVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8'));
    return pkg.version || '1.0.0';
  } catch (e) {
    return app.getVersion();
  }
}

/** Всё, что нужно отрисовать экрану настроек. */
function publicSettings() {
  const s = read();
  return {
    theme: s.theme,
    downloadDir: downloadDir(),
    defaultDownloadDir: paths.defaultDownloadDir(),
    isDefaultDir: !s.downloadDir,
    version: appVersion()
  };
}

module.exports = { read, write, downloadDir, publicSettings, appVersion, DEFAULTS };
