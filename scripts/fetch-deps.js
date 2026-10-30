'use strict';

/**
 * Скачивание зависимостей сборки без npm.
 *
 * Бинарники в репозитории не лежат: ffmpeg.exe весит 100.5 МБ, а GitHub
 * отклоняет файлы больше 100 МБ, да и хранить 480 МБ в истории незачем.
 * Скрипт кладёт всё в те же места, что ждёт make-installer.js, поэтому
 * после него сборка запускается как обычно.
 *
 * Каждый файл сверяется с закреплённым SHA-256 — версии зафиксированы, чтобы
 * сборка была воспроизводимой, а подмена по дороге не прошла незамеченной.
 *
 * Запуск: node scripts/fetch-deps.js
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const TMP = path.join(ROOT, 'build', '.deps');

const ELECTRON_VERSION = '45.1.0';
const FFMPEG_VERSION = '9.0.2';
const NSIS_VERSION = '3.10';
const RCEDIT_VERSION = '2.0.0';
const YTDLP_VERSION = '2026.10.26';

/**
 * Что скачать и куда положить.
 *
 * `sha256` — от закреплённого файла, а не от «последней версии»: URL не
 * меняются, поэтому и хэш остаётся верным. Для архивов проверяется сам
 * архив, для отдельных файлов — сам файл.
 */
const DEPS = [
  {
    name: `Electron ${ELECTRON_VERSION}`,
    url: `https://github.com/electron/electron/releases/download/v${ELECTRON_VERSION}/electron-v${ELECTRON_VERSION}-win32-x64.zip`,
    file: 'electron.zip',
    sha256: '55eaba17abff7b5bba6c3bbc85068967379024fe742fe9c7fdba9118922ccbe2',
    extract: { zip: true, to: 'vendor/electron', strip: 0 }
  },
  {
    name: `ffmpeg ${FFMPEG_VERSION}`,
    url: `https://github.com/GyanD/codexffmpeg/releases/download/${FFMPEG_VERSION}/ffmpeg-${FFMPEG_VERSION}-essentials_build.zip`,
    file: 'ffmpeg.zip',
    sha256: '60f467265b1e312373dbcd92200c2618a74850f98d3d078e94296bb3fa2047ba',
    // Из архива нужен только ffmpeg.exe; ffplay и ffprobe весят по 100 МБ зря
    extract: { zip: true, to: 'resources/bin', only: `ffmpeg-${FFMPEG_VERSION}-essentials_build/bin/ffmpeg.exe` }
  },
  {
    name: `yt-dlp ${YTDLP_VERSION}`,
    url: `https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/yt-dlp.exe`,
    file: 'yt-dlp.exe',
    sha256: 'f5389d3698ecde4ef06f4e6b1ce0294fe9ac1396228c8990b8d3416d6d177a7d',
    extract: { to: 'resources/bin' }
  },
  {
    name: `NSIS ${NSIS_VERSION}`,
    // downloads.sourceforge.net стабильнее, чем редирект через /download:
    // тот иногда обрывает соединение на середине (ECONNRESET)
    url: `https://downloads.sourceforge.net/project/nsis/NSIS%203/${NSIS_VERSION}/nsis-${NSIS_VERSION}.zip`,
    file: 'nsis.zip',
    sha256: 'fcdce3229717a2a148e7cda0ab5bdb667f39d8fb33ede1da8dabc336bd5ad110',
    extract: { zip: true, to: 'vendor/nsis', strip: 1 }
  },
  {
    name: `rcedit ${RCEDIT_VERSION}`,
    url: `https://github.com/electron/rcedit/releases/download/v${RCEDIT_VERSION}/rcedit-x64.exe`,
    file: 'rcedit-x64.exe',
    sha256: '3e7801db1a5edbec91b49a24a094aad776cb4515488ea5a4ca2289c400eade2a',
    extract: { to: 'vendor', as: 'rcedit-x64.exe' }
  }
];

// @electron/asar с зависимостями (commander, glob, minimatch) весит 595 КБ
// и лежит в репозитории: тащить его сюда значило бы разрешать дерево
// транзитивных зависимостей вручную ради экономии полумегабайта.

function log(message) {
  process.stdout.write(`${message}\n`);
}

/**
 * Скачивание через системный curl.
 *
 * Встроенный https-клиент Node не проходит проверку Cloudflare на SourceForge:
 * соединение рвётся с ECONNRESET ещё до ответа, и повторы не помогают.
 * curl.exe входит в Windows 10 1803+ и умеет сам следовать редиректам.
 */
function download(url, dest) {
  return new Promise((resolve, reject) => {
    const child = spawn('curl.exe', [
      '-L',                        // следовать редиректам (SourceForge отдаёт 302)
      '--fail',                    // ошибка вместо HTML-страницы при 4xx/5xx
      '--retry', '3',
      '--retry-delay', '2',
      '--connect-timeout', '30',
      '-A', 'YTDownloader-build',
      '-o', dest,
      url
    ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`curl завершился с кодом ${code}: ${stderr.trim().split('\n').pop() || ''}`));
    });
  });
}

/**
 * Скачивание с повторами.
 *
 * SourceForge регулярно обрывает соединение на середине файла (ECONNRESET),
 * поэтому одна неудача не должна валить всю подготовку.
 */
async function downloadWithRetry(url, dest, attempts = 3) {
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      await download(url, dest);
      return;
    } catch (e) {
      fs.rmSync(dest, { force: true });
      if (attempt === attempts) throw e;
      log(`\n  ${e.message} — повтор ${attempt + 1}/${attempts}...`);
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

function sha256(file) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(file));
  return hash.digest('hex');
}

/** Распаковка zip: PowerShell есть в Windows всегда, отдельные утилиты не нужны. */
function unzip(zipFile, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  execFileSync('powershell', [
    '-NoProfile', '-NonInteractive', '-Command',
    `Expand-Archive -LiteralPath '${zipFile}' -DestinationPath '${destDir}' -Force`
  ], { stdio: 'pipe' });
}

/**
 * Распаковка tar.gz.
 *
 * Берём tar из System32 явно: если в PATH раньше окажется GNU tar из Git
 * for Windows, он прочитает «C:\...» как имя удалённого хоста и упадёт.
 */
function untgz(file, destDir) {
  fs.mkdirSync(destDir, { recursive: true });
  const tar = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  execFileSync(tar, ['-x', '-z', '-f', file, '-C', destDir], { stdio: 'pipe' });
}

/**
 * Раскладывает скачанный файл по месту.
 *
 * strip срезает общий каталог архива (в zip-ах ffmpeg и NSIS он есть,
 * в tgz npm — тоже: package/…), иначе получилось бы vendor/nsis/nsis-3.10/…
 */
function place(dep, downloaded) {
  const { extract } = dep;
  const target = path.join(ROOT, extract.to);

  if (!extract.zip && !extract.tgz) {
    fs.mkdirSync(target, { recursive: true });
    const name = extract.as || path.basename(dep.file);
    fs.copyFileSync(downloaded, path.join(target, name));
    return;
  }

  const staging = path.join(TMP, `${dep.file}.d`);
  fs.rmSync(staging, { recursive: true, force: true });
  if (extract.zip) unzip(downloaded, staging);
  else untgz(downloaded, staging);

  if (extract.only) {
    fs.mkdirSync(target, { recursive: true });
    fs.copyFileSync(path.join(staging, extract.only), path.join(target, path.basename(extract.only)));
    fs.rmSync(staging, { recursive: true, force: true });
    return;
  }

  // Срезаем общий корневой каталог, если он единственный
  let source = staging;
  if (extract.strip > 0) {
    const entries = fs.readdirSync(staging);
    if (entries.length === 1 && fs.statSync(path.join(staging, entries[0])).isDirectory()) {
      source = path.join(staging, entries[0]);
    }
  }

  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(source, target, { recursive: true });
  fs.rmSync(staging, { recursive: true, force: true });
}

async function main() {
  fs.mkdirSync(TMP, { recursive: true });

  for (const dep of DEPS) {
    const downloaded = path.join(TMP, dep.file);

    if (fs.existsSync(downloaded) && sha256(downloaded) === dep.sha256) {
      log(`${dep.name}: уже скачан`);
    } else {
      log(`${dep.name}: скачивание...`);
      fs.rmSync(downloaded, { force: true });
      await downloadWithRetry(dep.url, downloaded);

      const actual = sha256(downloaded);
      if (actual !== dep.sha256) {
        fs.rmSync(downloaded, { force: true });
        throw new Error(
          `${dep.name}: SHA-256 не совпал\n  ожидался ${dep.sha256}\n  получен  ${actual}`
        );
      }
      log(`${dep.name}: скачан и проверен`);
    }

    place(dep, downloaded);
  }

  fs.rmSync(TMP, { recursive: true, force: true });
  log('\nЗависимости на месте. Сборка: node build/make-installer.js');
}

main().catch((e) => {
  console.error(`\nОшибка: ${e.message}`);
  process.exit(1);
});
