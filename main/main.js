'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, ipcMain, dialog, shell, session, protocol, net } = require('electron');

const paths = require('./paths');
const settings = require('./settings');
const auth = require('./auth');
const quality = require('./quality');
const ytdlp = require('./ytdlp');
const downloader = require('./downloader');
const storage = require('./storage');
const formatters = require('./formatters');

/**
 * Главный процесс: окно, меню, IPC и связывание модулей.
 *
 * Рендерер ничего не знает о файловой системе и процессах: всё, что трогает
 * диск или запускает yt-dlp, проходит через IPC. Это же разделение не даёт
 * странице входа получить доступ к произвольным файлам.
 */

const APP_NAME = 'YTDownloader';

/** Схема для отдачи локальных файлов в <video>/<img>: file:// в renderer заблокирован. */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'media',
    privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, bypassCSP: false }
  }
]);

let mainWindow = null;
let loginWindow = null;

// ------------------------------------------------------------------- окно

function applyTheme(win) {
  const theme = settings.read().theme;
  // nativeTheme.themeSource сам перекрашивает заголовок окна и системные диалоги
  const { nativeTheme } = require('electron');
  nativeTheme.themeSource = theme === 'dark' || theme === 'light' ? theme : 'system';
  if (win && !win.isDestroyed()) win.setBackgroundColor(backgroundColorFor(theme));
}

function backgroundColorFor(theme) {
  if (theme === 'light') return '#F8F9FA';
  if (theme === 'dark') return '#0F0F0F';
  // «Авто»: цвет под системную тему, чтобы окно не мигало белым при старте
  return require('electron').nativeTheme.shouldUseDarkColors ? '#0F0F0F' : '#F8F9FA';
}

function createWindow() {
  // Окно не должно вылезать за рабочую область: на ноутбуке 1366x768 окно
  // 1080x900 открывалось выше экрана, и кнопки внизу были недоступны.
  const { screen } = require('electron');
  const work = screen.getPrimaryDisplay().workAreaSize;

  const win = new BrowserWindow({
    width: Math.min(1080, work.width - 80),
    height: Math.min(900, work.height - 40),
    minWidth: 720,
    minHeight: 600,
    title: APP_NAME,
    backgroundColor: backgroundColorFor(settings.read().theme),
    icon: path.join(__dirname, '..', 'resources', 'icon.ico'),
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false
    }
  });

  win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  win.once('ready-to-show', () => win.show());

  // Внешние ссылки (поддержка разработчика) открываются в браузере, а не в приложении
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('file://')) {
      event.preventDefault();
      if (/^https?:/.test(url)) shell.openExternal(url);
    }
  });

  win.on('closed', () => {
    mainWindow = null;
  });

  mainWindow = win;
  applyTheme(win);
  return win;
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// --------------------------------------------------------------- IPC: окно

ipcMain.handle('app:bootstrap', () => ({
  settings: settings.publicSettings(),
  authorized: auth.isAuthorized(),
  download: downloader.snapshot(),
  outcome: downloader.consumeOutcome(),
  appVersion: settings.appVersion()
}));

ipcMain.handle('settings:get', () => settings.publicSettings());

ipcMain.handle('settings:setTheme', (_e, theme) => {
  if (!['auto', 'dark', 'light'].includes(theme)) return settings.publicSettings();
  settings.write({ theme });
  applyTheme(mainWindow);
  return settings.publicSettings();
});

ipcMain.handle('settings:chooseDir', async () => {
  const current = settings.downloadDir();
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Папка для загрузок',
    defaultPath: fs.existsSync(current) ? current : paths.defaultDownloadDir(),
    properties: ['openDirectory', 'createDirectory']
  });
  if (result.canceled || !result.filePaths.length) return null;

  settings.write({ downloadDir: result.filePaths[0] });
  storage.ensureDir(result.filePaths[0]);
  return settings.publicSettings();
});

ipcMain.handle('settings:resetDir', () => {
  settings.write({ downloadDir: null });
  storage.ensureDir(paths.defaultDownloadDir());
  return settings.publicSettings();
});

ipcMain.handle('settings:openDir', async () => {
  const dir = settings.downloadDir();
  storage.ensureDir(dir);
  await shell.openPath(dir);
  return true;
});

ipcMain.handle('app:openExternal', async (_e, url) => {
  if (!/^https?:\/\//.test(url)) return false;
  await shell.openExternal(url);
  return true;
});

ipcMain.handle('app:openFile', async (_e, filePath) => {
  // Открываем только то, что лежит в папке загрузок
  if (!isInsideDownloadDir(filePath)) return false;
  const error = await shell.openPath(filePath);
  return error === '';
});

ipcMain.handle('app:showInFolder', (_e, filePath) => {
  if (!isInsideDownloadDir(filePath)) return false;
  shell.showItemInFolder(filePath);
  return true;
});

function isInsideDownloadDir(filePath) {
  const dir = path.resolve(settings.downloadDir());
  const target = path.resolve(filePath);
  const relative = path.relative(dir, target);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

// ------------------------------------------------------- IPC: авторизация

ipcMain.handle('auth:status', () => auth.isAuthorized());

ipcMain.handle('auth:login', () => openLoginWindow());

ipcMain.handle('auth:logout', async () => {
  auth.clear();
  try {
    await session.defaultSession.clearStorageData({ storages: ['cookies'] });
  } catch (e) {
    // сессия могла быть уже очищена
  }
  return false;
});

/**
 * Окно входа в Google.
 *
 * Отдельное окно с той же сессией Chromium: после входа куки забираются
 * из session.defaultSession и конвертируются в Netscape-файл — так же,
 * как Android-версия забирала их из CookieManager WebView.
 */
function openLoginWindow() {
  if (loginWindow && !loginWindow.isDestroyed()) {
    loginWindow.focus();
    return Promise.resolve(auth.isAuthorized());
  }

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      width: 520,
      height: 760,
      parent: mainWindow || undefined,
      modal: false,
      title: 'Вход в YouTube / Google',
      autoHideMenuBar: true,
      backgroundColor: '#121212',
      webPreferences: {
        partition: 'persist:youtube',
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true
      }
    });

    loginWindow = win;
    win.loadURL(
      'https://accounts.google.com/ServiceLogin?service=youtube&continue=https%3A%2F%2Fwww.youtube.com%2F'
    );

    let handled = false;
    const finish = (ok) => {
      if (handled) return;
      handled = true;
      resolve(ok);
      if (!win.isDestroyed()) win.close();
    };

    const trySave = async () => {
      if (handled) return;
      try {
        const ses = win.webContents.session;
        const cookies = await ses.cookies.get({});
        if (auth.hasAuthMarkers(cookies) && auth.saveFromCookies(cookies)) {
          finish(true);
        }
      } catch (e) {
        // страница ещё грузится — попробуем на следующей навигации
      }
    };

    win.webContents.on('did-finish-load', trySave);
    win.webContents.on('did-navigate', trySave);
    win.webContents.on('did-navigate-in-page', trySave);

    // Кнопка «Я вошёл» в верхней панели: тот же жест, что на Android
    win.webContents.on('did-finish-load', () => {
      if (handled) return;
      win.webContents.executeJavaScript(
        `(() => {
           if (document.getElementById('ytd-pc-login-bar')) return;
           const bar = document.createElement('div');
           bar.id = 'ytd-pc-login-bar';
           bar.style.cssText = 'position:fixed;right:16px;bottom:16px;z-index:2147483647;' +
             'display:flex;gap:8px;font:13px system-ui,sans-serif';
           const done = document.createElement('button');
           done.textContent = '✅ Я вошёл';
           done.style.cssText = 'padding:10px 16px;border:0;border-radius:20px;background:#E62117;' +
             'color:#fff;font-weight:700;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.4)';
           done.onclick = () => window.ytdLoginDone && window.ytdLoginDone();
           const cancel = document.createElement('button');
           cancel.textContent = 'Закрыть';
           cancel.style.cssText = 'padding:10px 16px;border:0;border-radius:20px;background:#282828;' +
             'color:#ddd;cursor:pointer;box-shadow:0 4px 16px rgba(0,0,0,.4)';
           cancel.onclick = () => window.ytdLoginCancel && window.ytdLoginCancel();
           bar.append(done, cancel);
           document.body.appendChild(bar);
         })()`
      ).catch(() => {});
    });

    win.on('closed', () => {
      loginWindow = null;
      if (!handled) {
        handled = true;
        resolve(auth.isAuthorized());
      }
    });
  });
}

// ------------------------------------------------------- IPC: метаданные

ipcMain.handle('video:fetch', async (_e, rawUrl) => {
  const url = extractUrl(rawUrl);
  if (!url) {
    return { ok: false, message: 'Введите корректную ссылку на YouTube видео или Shorts' };
  }

  try {
    const info = await ytdlp.fetchInfo(url);
    settings.write({ lastUrl: url });

    const resolutions = ytdlp.availableResolutions(info);
    const presets = quality.availableIn(resolutions);
    const duration = Number(info.duration) || 0;

    const items = presets.map((preset) => {
      const bytes = formatters.estimateBytes(duration, preset.bitrate);
      const base = bytes > 0 ? `${preset.label} (${formatters.estimatedSize(bytes)})` : preset.label;
      const hdr = quality.supportsHdr(preset) && ytdlp.willDownloadHdr(info, preset.maxHeight);
      return {
        id: preset.id,
        label: hdr ? `${base} · HDR` : base,
        hdr,
        kind: preset.kind
      };
    });

    const preferred =
      presets.find((p) => p.id === quality.DEFAULT_ID) ||
      presets.find((p) => p.id === 'fhd1080') ||
      presets[0];

    return {
      ok: true,
      url,
      title: info.title || 'Без названия',
      uploader: info.uploader || info.channel || 'YouTube',
      thumbnail: pickThumbnail(info),
      duration,
      items,
      selectedId: preferred ? preferred.id : items[0].id
    };
  } catch (e) {
    return { ok: false, message: ytdlp.cleanError(e && e.message, 'Не удалось получить информацию') };
  }
});

/** Обложка в максимальном разрешении, но не больше 1280 по ширине — чтобы не тянуть 4K-кадр. */
function pickThumbnail(info) {
  const list = Array.isArray(info.thumbnails) ? info.thumbnails : [];
  const withWidth = list.filter((t) => t.url && t.width);
  if (withWidth.length) {
    const sorted = withWidth.slice().sort((a, b) => a.width - b.width);
    const pick = sorted.find((t) => t.width >= 640) || sorted[sorted.length - 1];
    return pick.url;
  }
  return info.thumbnail || null;
}

function extractUrl(text) {
  if (!text) return null;
  const match = String(text).match(/https?:\/\/\S+/i);
  const candidate = match ? match[0] : String(text).trim();
  if (!/^https?:\/\//i.test(candidate)) return null;
  // Отсекаем очевидно чужие ссылки: экстрактор всё равно упадёт, но ошибка будет понятнее
  if (!/(youtube\.com|youtu\.be|youtube-nocookie\.com)/i.test(candidate)) return null;
  return candidate;
}

// -------------------------------------------------------- IPC: скачивание

ipcMain.handle('download:start', async (_e, { url, video, qualityId }) => {
  if (downloader.snapshot().running) return { ok: false, message: 'Загрузка уже идёт' };

  const preset = quality.byId(qualityId);
  if (!preset) return { ok: false, message: 'Неизвестное качество' };

  try {
    // Сессия Chromium держит живые токены, а файл, выгруженный при входе,
    // постепенно устаревает — обновляем куки прямо перед запуском.
    await refreshCookies();
  } catch (e) {
    // без обновления тоже попробуем
  }

  const started = downloader.start(url, video, preset);
  return started ? { ok: true } : { ok: false, message: 'Загрузка уже идёт' };
});

ipcMain.handle('download:cancel', () => downloader.cancel());
ipcMain.handle('download:state', () => ({
  download: downloader.snapshot(),
  outcome: downloader.consumeOutcome()
}));

/** Пересобирает файл кук из актуальной сессии Chromium. */
async function refreshCookies() {
  const ses = session.fromPartition('persist:youtube');
  const cookies = await ses.cookies.get({});
  if (!auth.hasAuthMarkers(cookies)) {
    const def = await session.defaultSession.cookies.get({});
    if (auth.hasAuthMarkers(def)) auth.saveFromCookies(def);
    return;
  }
  auth.saveFromCookies(cookies);
}

downloader.EVENTS.on('progress', (payload) => send('download:progress', payload));
downloader.EVENTS.on('completed', () => send('download:completed', {}));
downloader.EVENTS.on('failed', (payload) => send('download:failed', payload));

// ----------------------------------------------------------- IPC: галерея

ipcMain.handle('gallery:list', () => storage.list());

ipcMain.handle('gallery:thumbnail', async (_e, { filePath, durationMs }) => {
  const thumb = await storage.thumbnail(filePath, durationMs);
  return thumb ? toMediaUrl(thumb) : null;
});

ipcMain.handle('gallery:delete', async (_e, filePath) => storage.remove(filePath, shell));

ipcMain.handle('gallery:openDir', async () => {
  const dir = settings.downloadDir();
  storage.ensureDir(dir);
  await shell.openPath(dir);
  return true;
});

function toMediaUrl(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return `media://local/${encodeURIComponent(normalized).replace(/%2F/g, '/').replace(/%3A/g, ':')}`;
}

// --------------------------------------------------------------- протокол

/**
 * media:// — отдача локальных файлов в <video> и <img>.
 *
 * Файл открывается только если он лежит в папке загрузок или во временной
 * папке превью: иначе любая страница в окне могла бы прочитать диск целиком.
 */
function registerMediaProtocol() {
  protocol.handle('media', async (request) => {
    try {
      const url = new URL(request.url);
      const filePath = decodeURIComponent(url.pathname.replace(/^\//, ''));
      const allowed =
        isInsideDownloadDir(filePath) ||
        path.resolve(filePath).startsWith(path.resolve(path.join(paths.appDataDir(), 'thumbs')));

      if (!allowed) return new Response('Forbidden', { status: 403 });
      return net.fetch(`file:///${filePath.replace(/\\/g, '/')}`);
    } catch (e) {
      return new Response('Not found', { status: 404 });
    }
  });
}

// -------------------------------------------------------------- жизненный цикл

const singleInstance = app.requestSingleInstanceLock();
if (!singleInstance) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(async () => {
    app.setAppUserModelId('com.example.ytdownloader');
    registerMediaProtocol();
    createWindow();

    // Обновление движка не должно задерживать появление окна
    ytdlp.updateEngineIfStale().catch(() => {});

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });
}

app.on('window-all-closed', () => {
  app.quit();
});
