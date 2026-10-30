'use strict';

/**
 * Сборка установщика без npm-зависимостей.
 *
 * npm install в этом окружении обрывается (ECONNRESET на tarball'ах), поэтому
 * electron-builder не используется: скрипт сам раскладывает Electron, кладёт
 * приложение в app.asar, переименовывает exe, ставит иконку и собирает NSIS.
 *
 * Запуск: node build/make-installer.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const VENDOR = path.join(ROOT, 'vendor');
const OUT = path.join(ROOT, 'dist');
const STAGE = path.join(BUILD, 'app');

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const VERSION = pkg.version;
const APP_NAME = 'YTDownloader';
const EXE_NAME = `${APP_NAME}.exe`;

function log(message) {
  process.stdout.write(`${message}\n`);
}

function rmrf(target) {
  fs.rmSync(target, { recursive: true, force: true });
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, entry.name);
    const dst = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(src, dst);
    else fs.copyFileSync(src, dst);
  }
}

// ------------------------------------------------------------------ asar

/**
 * Упаковка app.asar.
 *
 * Самодельный упаковщик не подошёл: Electron 45 отказывается разбирать архив
 * («Failed to parse header size»). Поэтому используется @electron/asar,
 * положенный в vendor вместе с зависимостями — без npm install.
 */
function buildAsar(sourceDir, outFile) {
  // Отдельный процесс: @electron/asar оставляет открытые дескрипторы, и makensis
  // в том же процессе не может открыть только что созданный архив.
  execFileSync(process.execPath, [path.join(__dirname, 'pack-asar.js'), sourceDir, outFile], {
    stdio: 'inherit'
  });
  return outFile;
}

// ------------------------------------------------------------- подготовка

async function stageElectron() {
  const electronDir = path.join(VENDOR, 'electron');
  if (!fs.existsSync(path.join(electronDir, 'electron.exe'))) {
    throw new Error(`Нет vendor/electron — распакуйте туда electron-v*-win32-x64.zip`);
  }

  rmrf(STAGE);
  copyDir(electronDir, STAGE);

  // resources/bin должен лежать рядом с asar, а не внутри: yt-dlp.exe и ffmpeg.exe
  // запускаются как отдельные процессы, из архива это невозможно.
  const resBin = path.join(STAGE, 'resources', 'bin');
  fs.mkdirSync(resBin, { recursive: true });
  for (const exe of ['yt-dlp.exe', 'ffmpeg.exe']) {
    fs.copyFileSync(path.join(ROOT, 'resources', 'bin', exe), path.join(resBin, exe));
  }

  // Иконка приложения рядом с asar — её показывает окно и установщик
  fs.copyFileSync(path.join(ROOT, 'resources', 'icon.ico'), path.join(STAGE, 'resources', 'icon.ico'));

  // Исходники приложения во временной папке: asar собирается из неё,
  // а не из корня проекта, иначе в архив попали бы build/, vendor/ и dist/.
  const appSource = path.join(BUILD, 'app-source');
  rmrf(appSource);
  copyDir(path.join(ROOT, 'main'), path.join(appSource, 'main'));
  copyDir(path.join(ROOT, 'renderer'), path.join(appSource, 'renderer'));
  fs.copyFileSync(path.join(ROOT, 'package.json'), path.join(appSource, 'package.json'));

  const appAsar = path.join(STAGE, 'resources', 'app.asar');
  buildAsar(appSource, appAsar);
  rmrf(appSource);
  log(`app.asar: ${(fs.statSync(appAsar).size / 1024).toFixed(0)} КБ`);

  // exe переименовываем: Electron ищет app.asar в resources рядом с собой
  const renamed = path.join(STAGE, EXE_NAME);
  fs.renameSync(path.join(STAGE, 'electron.exe'), renamed);
  return renamed;
}

/** Иконка и свойства exe: без этого в Проводнике остаётся иконка Electron. */
function patchExeIcon(exePath) {
  const rcedit = path.join(VENDOR, 'rcedit-x64.exe');
  if (!fs.existsSync(rcedit)) {
    log('rcedit не найден — иконка exe останется стандартной');
    return;
  }

  try {
    execFileSync(rcedit, [
      exePath,
      '--set-icon', path.join(ROOT, 'resources', 'icon.ico'),
      '--set-version-string', 'ProductName', APP_NAME,
      '--set-version-string', 'FileDescription', 'YouTube Downloader для Windows',
      '--set-version-string', 'CompanyName', 'Vladislav',
      '--set-file-version', VERSION,
      '--set-product-version', VERSION
    ], { stdio: 'pipe' });
    log('иконка и свойства exe обновлены');
  } catch (e) {
    log(`rcedit не сработал: ${String(e.message).split('\n')[0]}`);
  }
}

function buildInstaller() {
  const makensis = path.join(VENDOR, 'nsis', 'makensis.exe');
  if (!fs.existsSync(makensis)) {
    throw new Error('Нет vendor/nsis/makensis.exe');
  }

  fs.mkdirSync(OUT, { recursive: true });
  const outFile = path.join(OUT, `${APP_NAME}-${VERSION}-setup.exe`);

  // Проверяем входные файлы заранее: makensis сообщает лишь «failed opening file»
  const asarFile = path.join(STAGE, 'resources', 'app.asar');
  if (!fs.existsSync(asarFile)) throw new Error(`Нет ${asarFile}`);
  log(`app.asar перед упаковкой: ${fs.statSync(asarFile).size} байт`);

  const args = [
    '/V2',
    `/DAPP_VERSION=${VERSION}`,
    `/DOUT_FILE=${outFile}`,
    `/DAPP_DIR=${STAGE}`,
    `/DICON_FILE=${path.join(ROOT, 'resources', 'icon.ico')}`,
    path.join(BUILD, 'installer.nsi')
  ];

  // Сразу после записи asar антивирус может ненадолго заблокировать файл,
  // и makensis падает с «failed opening file». Пробуем несколько раз.
  let lastError = null;
  for (let attempt = 1; attempt <= 4; attempt++) {
    try {
      execFileSync(makensis, args, { stdio: 'inherit' });
      lastError = null;
      break;
    } catch (e) {
      lastError = e;
      log(`makensis: попытка ${attempt} не удалась, повтор через 2 с...`);
      // Синхронная пауза: скрипт сборки последовательный
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2000);
    }
  }
  if (lastError) throw lastError;

  const size = fs.statSync(outFile).size;
  log(`\nГотово: ${outFile} (${(size / 1024 / 1024).toFixed(1)} МБ)`);
  return outFile;
}

// -------------------------------------------------------------------- main

log(`Сборка ${APP_NAME} ${VERSION}`);
stageElectron()
  .then((exe) => {
    patchExeIcon(exe);
    buildInstaller();
  })
  .catch((e) => {
    console.error(`Сборка не удалась: ${e.message}`);
    process.exit(1);
  });
