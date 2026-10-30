'use strict';

const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { app } = require('electron');

/**
 * Пути приложения и настройки.
 *
 * Портативная и установленная версии ведут себя одинаково: настройки лежат
 * в %APPDATA%/YTDownloader, а не рядом с exe, иначе после обновления через
 * установщик пользователь терял бы тему и папку загрузок.
 */

const APP_DIR_NAME = 'YTDownloader';

/** Имя exe-файла в установленной версии. */
const EXE_NAME = 'YTDownloader.exe';

/** Папка загрузок по умолчанию — та же, что у Android-версии («Загрузки/YTDownloader»). */
function defaultDownloadDir() {
  const downloads = app.getPath('downloads');
  return path.join(downloads, APP_DIR_NAME);
}

function settingsPath() {
  return path.join(app.getPath('userData'), 'settings.json');
}

/** Служебные файлы приложения: индекс загрузок, превью, cookies. */
function appDataDir() {
  return app.getPath('userData');
}

function cookiesPath() {
  return path.join(app.getPath('userData'), 'youtube_cookies.txt');
}

function tmpRoot() {
  return path.join(app.getPath('temp'), 'YTDownloader');
}

/**
 * Папка с yt-dlp.exe и ffmpeg.exe.
 *
 * В установленной версии они лежат в resources/bin рядом с asar-архивом,
 * в портативной — в resources/bin рядом с exe. Первый существующий путь
 * и выигрывает, чтобы обе сборки работали от одного кода.
 */
function binDir() {
  const candidates = [
    // process.resourcesPath есть только внутри Electron — вне его шаг пропускаем
    process.resourcesPath ? path.join(process.resourcesPath, 'bin') : null,
    path.join(path.dirname(app.getPath('exe')), 'resources', 'bin'),
    path.join(__dirname, '..', 'resources', 'bin')
  ].filter(Boolean);

  return candidates.find((dir) => fs.existsSync(path.join(dir, 'yt-dlp.exe'))) || candidates[candidates.length - 1];
}

function ytDlpPath() {
  return path.join(binDir(), 'yt-dlp.exe');
}

function ffmpegPath() {
  return path.join(binDir(), 'ffmpeg.exe');
}

/** Путь к exe, который нужно перезапустить при смене темы/языка не требуется — только для справки. */
function exePath() {
  return app.getPath('exe');
}

module.exports = {
  APP_DIR_NAME,
  EXE_NAME,
  defaultDownloadDir,
  settingsPath,
  appDataDir,
  cookiesPath,
  tmpRoot,
  binDir,
  ytDlpPath,
  ffmpegPath,
  exePath,
  homeDir: () => os.homedir()
};
