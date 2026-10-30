'use strict';

/**
 * Экран приложения: ссылка, превью, качество, загрузка, галерея, плеер, настройки.
 *
 * Вся работа с диском и yt-dlp живёт в главном процессе — здесь только
 * отрисовка состояния и вызовы window.api.
 */

const state = {
  url: null,
  video: null,
  items: [],
  selectedId: null,
  settings: null,
  authorized: false,
  downloading: false,
  galleryItems: [],
  pendingDelete: null,
  playerPath: null,
  toastTimer: null,
  screen: 'main'
};

const $ = (id) => document.getElementById(id);

const DONATION_URL = 'https://pay.cloudtips.ru/p/f35243af';

// ------------------------------------------------------------------ утилиты

function showToast(message) {
  const toast = $('toast');
  toast.textContent = message;
  toast.classList.remove('hidden');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => toast.classList.add('hidden'), 3200);
}

function showScreen(name) {
  state.screen = name;
  for (const screen of document.querySelectorAll('.screen')) {
    screen.classList.toggle('hidden', screen.id !== `screen-${name}`);
  }
  if (name === 'gallery') loadGallery();
}

function openDialog(id) { $(id).classList.remove('hidden'); }
function closeDialog(id) { $(id).classList.add('hidden'); }

function setThemeAttribute(theme) {
  const dark =
    theme === 'dark' ||
    (theme === 'auto' && window.matchMedia('(prefers-color-scheme: dark)').matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
}

// --------------------------------------------------------------- авторизация

function renderAuth() {
  const btn = $('btn-account');
  btn.textContent = state.authorized ? 'Аккаунт ✓' : 'Войти';
  btn.classList.toggle('btn-primary', !state.authorized);
  btn.classList.toggle('btn-tonal', state.authorized);

  $('et-url').disabled = !state.authorized;
  $('btn-paste').disabled = !state.authorized;
  $('btn-fetch').disabled = !state.authorized;

  $('account-state').textContent = state.authorized
    ? 'Вы вошли в YouTube. Куки сохранены и обновляются автоматически.'
    : 'Для скачивания требуется вход в YouTube.';
  $('btn-account-login').classList.toggle('hidden', state.authorized);
  $('btn-account-logout').classList.toggle('hidden', !state.authorized);

  if (!state.authorized) {
    $('fetch-status').classList.remove('hidden');
    $('progress-fetch').classList.add('hidden');
    $('fetch-status-text').textContent =
      'Для скачивания требуется вход в YouTube (нажмите «Войти» вверху)';
  }
}

async function login() {
  const ok = await window.api.auth.login();
  state.authorized = Boolean(ok);
  renderAuth();
  if (state.authorized) {
    showToast('Авторизация в YouTube сохранена!');
    const url = $('et-url').value.trim();
    if (url) fetchVideo(url);
  } else {
    showToast('Куки ещё не получены. Завершите вход на открывшейся странице.');
  }
}

async function logout() {
  state.authorized = await window.api.auth.logout();
  renderAuth();
  showToast('Вы вышли из аккаунта YouTube');
}

// ----------------------------------------------------------------- метаданные

async function fetchVideo(input) {
  if (!state.authorized) {
    showToast('Пожалуйста, сначала выполните вход в аккаунт');
    login();
    return;
  }

  const url = input.trim();
  if (!url) {
    showToast('Введите корректную ссылку на YouTube видео или Shorts');
    return;
  }

  $('card-preview').classList.add('hidden');
  $('fetch-status').classList.remove('hidden');
  $('progress-fetch').classList.remove('hidden');
  $('fetch-status-text').textContent = 'Анализ видео через yt-dlp...';
  $('btn-fetch').disabled = true;

  const result = await window.api.video.fetch(url);

  $('progress-fetch').classList.add('hidden');
  $('btn-fetch').disabled = false;

  if (!result.ok) {
    $('fetch-status').classList.remove('hidden');
    $('fetch-status-text').textContent = result.message;
    showToast(result.message);
    return;
  }

  $('fetch-status').classList.add('hidden');
  renderPreview(result);
}

function renderPreview(result) {
  state.url = result.url;
  state.video = result;
  state.items = result.items;
  state.selectedId = result.selectedId;

  $('card-preview').classList.remove('hidden');
  $('tv-author').textContent = result.uploader || 'YouTube';
  $('tv-title').textContent = result.title || 'Без названия';

  const cover = $('iv-cover');
  if (result.thumbnail) {
    cover.src = result.thumbnail;
    cover.classList.remove('hidden');
  } else {
    cover.removeAttribute('src');
    cover.classList.add('hidden');
  }

  const select = $('quality');
  select.replaceChildren(
    ...result.items.map((item) => {
      const option = document.createElement('option');
      option.value = item.id;
      option.textContent = item.label;
      return option;
    })
  );
  select.value = result.selectedId;

  updateDownloadButton();
  $('tv-status').textContent = 'Видео готово к скачиванию!';
  $('progress-download').classList.add('hidden');
}

function updateDownloadButton() {
  const item = state.items.find((i) => i.id === state.selectedId);
  $('btn-download').textContent = item ? `Скачать ${item.label}` : 'Скачать видео';
}

// ----------------------------------------------------------------- загрузка

function setDownloading(running) {
  state.downloading = running;
  $('btn-download').disabled = running;
  $('btn-download').textContent = running
    ? 'Скачивание...'
    : (state.items.find((i) => i.id === state.selectedId)
        ? `Скачать ${state.items.find((i) => i.id === state.selectedId).label}`
        : 'Скачать видео');
  $('progress-download').classList.toggle('hidden', !running);
}

async function startDownload() {
  if (!state.authorized) {
    showToast('Пожалуйста, сначала выполните вход в аккаунт');
    login();
    return;
  }

  if (!state.url || !state.video) {
    showToast('Сначала вставьте ссылку на видео');
    return;
  }

  const payload = {
    url: state.url,
    video: {
      title: state.video.title,
      uploader: state.video.uploader,
      duration: state.video.duration,
      formats: state.video.formats || []
    },
    qualityId: state.selectedId
  };

  const result = await window.api.download.start(payload);
  if (!result.ok) {
    showToast(result.message);
    return;
  }

  setDownloading(true);
  $('tv-status').textContent = 'Скачивание видео: 0%';
}

window.api.on('download:progress', ({ percent, text }) => {
  setDownloading(true);
  $('progress-download').classList.remove('hidden');
  $('progress-download').firstElementChild.style.width = `${percent}%`;
  $('tv-status').textContent = text;
});

window.api.on('download:completed', () => {
  setDownloading(false);
  $('tv-status').textContent = 'Готово! Видео сохранено в папку загрузок';
  showToast('Загрузка завершена!');
  refreshGalleryCount();
});

window.api.on('download:failed', ({ message }) => {
  setDownloading(false);
  $('tv-status').textContent = message;
  showToast(message);
});

// ------------------------------------------------------------------ галерея

async function refreshGalleryCount() {
  const items = await window.api.gallery.list();
  $('gallery-count').textContent = items.length ? String(items.length) : '';
}

async function loadGallery() {
  const items = await window.api.gallery.list();
  state.galleryItems = items;

  $('gallery-total').textContent = items.length ? String(items.length) : '';
  $('gallery-empty').classList.toggle('hidden', items.length > 0);
  $('gallery-grid').classList.toggle('hidden', items.length === 0);

  const grid = $('gallery-grid');
  grid.replaceChildren(...items.map(createTile));
}

function createTile(item) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  tile.tabIndex = 0;

  const thumb = document.createElement('div');
  thumb.className = 'tile-thumb';

  const fallback = document.createElement('span');
  fallback.className = 'fallback';
  fallback.textContent = item.isAudio ? '♪' : '▶';
  thumb.append(fallback);

  const badge = document.createElement('span');
  badge.className = 'tile-badge';
  badge.textContent = item.name.split('.').pop().toUpperCase();
  if (!item.isAudio) badge.classList.add('hidden');
  thumb.append(badge);

  const menu = document.createElement('button');
  menu.className = 'tile-menu';
  menu.type = 'button';
  menu.title = 'Действия с файлом';
  menu.textContent = '⋮';
  menu.addEventListener('click', (event) => {
    event.stopPropagation();
    openFileActions(item);
  });
  thumb.append(menu);

  const name = document.createElement('div');
  name.className = 'tile-name';
  name.textContent = item.name;

  const meta = document.createElement('div');
  meta.className = 'tile-meta';
  meta.textContent = formatMeta(item);

  tile.append(thumb, name, meta);
  tile.addEventListener('click', () => openMedia(item));
  tile.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      openMedia(item);
    }
  });

  // Превью грузится асинхронно: кадр делает ffmpeg, и на сетке из десятков
  // карточек это заметно, поэтому подставляем его только когда он готов
  window.api.gallery.thumbnail({ filePath: item.path, durationMs: item.durationMs })
    .then((url) => {
      if (!url) return;
      const img = document.createElement('img');
      img.src = url;
      img.alt = '';
      fallback.replaceWith(img);
    })
    .catch(() => {});

  return tile;
}

function formatMeta(item) {
  const parts = [formatSize(item.sizeBytes)];
  if (item.durationMs > 0) parts.push(timecode(item.durationMs));
  return parts.join(' · ');
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return '—';
  const mb = bytes / (1024 * 1024);
  return mb >= 1024 ? `${(mb / 1024).toFixed(2)} ГБ` : `${mb.toFixed(1)} МБ`;
}

function timecode(ms) {
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

/** Меню карточки: без «Поделиться» — на ПК у этого действия нет аналога Android. */
function openFileActions(item) {
  const sheet = document.createElement('div');
  sheet.className = 'overlay';
  sheet.innerHTML = `
    <div class="dialog">
      <h3>Действия с файлом</h3>
      <p class="file-name"></p>
      <div class="dialog-actions">
        <button class="btn btn-tonal" type="button" data-act="folder">Показать в папке</button>
        <button class="btn btn-tonal" type="button" data-act="open">Открыть в плеере</button>
        <button class="btn btn-danger" type="button" data-act="delete">Удалить</button>
      </div>
    </div>`;

  sheet.querySelector('.file-name').textContent = item.name;
  sheet.addEventListener('click', (event) => {
    const act = event.target.dataset && event.target.dataset.act;
    if (!act) {
      if (event.target === sheet) sheet.remove();
      return;
    }
    sheet.remove();
    if (act === 'folder') window.api.app.showInFolder(item.path);
    if (act === 'open') openMedia(item);
    if (act === 'delete') confirmDelete(item);
  });

  document.body.append(sheet);
}

function confirmDelete(item) {
  state.pendingDelete = item;
  $('delete-file-name').textContent = item.name;
  openDialog('dialog-delete');
}

async function deletePending() {
  const item = state.pendingDelete;
  state.pendingDelete = null;
  closeDialog('dialog-delete');
  if (!item) return;

  const ok = await window.api.gallery.delete(item.path);
  if (!ok) showToast('Не удалось удалить файл');
  loadGallery();
  refreshGalleryCount();
}

// ------------------------------------------------------------------- плеер

function openMedia(item) {
  state.playerPath = item.path;
  $('player-title').textContent = item.name;

  const video = $('player-video');
  const art = $('player-audio-art');
  const artImg = $('player-audio-img');

  video.src = mediaUrl(item.path);
  art.classList.toggle('hidden', !item.isAudio);

  if (item.isAudio) {
    window.api.gallery.thumbnail({ filePath: item.path, durationMs: item.durationMs })
      .then((url) => { if (url) artImg.src = url; })
      .catch(() => {});
  } else {
    artImg.removeAttribute('src');
  }

  showScreen('player');
  video.play().catch(() => {});
}

function mediaUrl(filePath) {
  const normalized = filePath.replace(/\\/g, '/');
  return `media://local/${normalized.split('/').map(encodeURIComponent).join('/').replace(/^%2F/, '')}`;
}

function closePlayer() {
  const video = $('player-video');
  video.pause();
  video.removeAttribute('src');
  video.load();
  state.playerPath = null;
  showScreen('gallery');
}

async function toggleFullscreen() {
  if (!document.fullscreenElement) {
    await $('screen-player').requestFullscreen().catch(() => {});
  } else {
    await document.exitFullscreen().catch(() => {});
  }
}

// ----------------------------------------------------------------- настройки

function renderSettings(s) {
  state.settings = s;
  $('download-dir').textContent = s.downloadDir;
  $('btn-reset-dir').disabled = s.isDefaultDir;
  for (const btn of document.querySelectorAll('.segmented button')) {
    btn.setAttribute('aria-checked', String(btn.dataset.theme === s.theme));
  }
  $('app-version').textContent = `YTDownloader ${s.version} · Windows`;
}

async function chooseDir() {
  const s = await window.api.settings.chooseDir();
  if (s) {
    renderSettings(s);
    showToast('Папка для загрузок изменена');
    refreshGalleryCount();
  }
}

// -------------------------------------------------------------- инициализация

async function init() {
  const boot = await window.api.bootstrap();
  state.authorized = Boolean(boot.authorized);

  renderSettings(boot.settings);
  setThemeAttribute(boot.settings.theme);
  renderAuth();
  refreshGalleryCount();

  // Восстанавливаем состояние, если загрузка шла до перезапуска окна
  if (boot.download && boot.download.running) {
    setDownloading(true);
    $('progress-download').classList.remove('hidden');
    $('tv-status').textContent = boot.download.statusText || 'Скачивание файла началось...';
  } else if (boot.outcome) {
    if (boot.outcome.ok) showToast('Загрузка завершена!');
    else showToast(boot.outcome.message);
  }

  // Системная тема меняется на лету — «Авто» должен следовать за ней
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (state.settings && state.settings.theme === 'auto') setThemeAttribute('auto');
  });
}

// ------------------------------------------------------------------ события

$('btn-settings').addEventListener('click', () => showScreen('settings'));
$('card-gallery').addEventListener('click', () => showScreen('gallery'));

$('btn-fetch').addEventListener('click', () => fetchVideo($('et-url').value));
$('et-url').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') fetchVideo($('et-url').value);
});

$('btn-paste').addEventListener('click', async () => {
  try {
    const text = await navigator.clipboard.readText();
    if (!text || !text.trim()) {
      showToast('Буфер обмена пуст');
      return;
    }
    $('et-url').value = text.trim();
    fetchVideo(text);
  } catch (e) {
    showToast('Нет доступа к буферу обмена');
  }
});

$('quality').addEventListener('change', (event) => {
  state.selectedId = event.target.value;
  updateDownloadButton();
});

$('btn-download').addEventListener('click', startDownload);

$('btn-account').addEventListener('click', () => {
  if (state.authorized) openDialog('dialog-account');
  else login();
});

$('btn-relogin').addEventListener('click', () => {
  closeDialog('dialog-account');
  login();
});

$('btn-logout').addEventListener('click', () => {
  closeDialog('dialog-account');
  logout();
});

$('btn-account-login').addEventListener('click', login);
$('btn-account-logout').addEventListener('click', logout);

for (const btn of document.querySelectorAll('[data-close-dialog]')) {
  btn.addEventListener('click', () => closeDialog(btn.dataset.closeDialog));
}

$('btn-support').addEventListener('click', () => openDialog('dialog-support'));
$('btn-support-card').addEventListener('click', () => openDialog('dialog-support'));
$('btn-donate').addEventListener('click', () => {
  closeDialog('dialog-support');
  window.api.app.openExternal(DONATION_URL);
});

$('btn-confirm-delete').addEventListener('click', deletePending);

$('btn-gallery-refresh').addEventListener('click', loadGallery);
$('btn-gallery-folder').addEventListener('click', () => window.api.gallery.openDir());

$('btn-choose-dir').addEventListener('click', chooseDir);
$('btn-open-dir').addEventListener('click', () => window.api.settings.openDir());
$('btn-reset-dir').addEventListener('click', async () => {
  const s = await window.api.settings.resetDir();
  renderSettings(s);
  showToast('Восстановлена папка по умолчанию');
});

for (const btn of document.querySelectorAll('.segmented button')) {
  btn.addEventListener('click', async () => {
    const s = await window.api.settings.setTheme(btn.dataset.theme);
    renderSettings(s);
    setThemeAttribute(s.theme);
  });
}

for (const btn of document.querySelectorAll('[data-back]')) {
  btn.addEventListener('click', () => {
    const target = btn.dataset.back;
    if (state.screen === 'player') closePlayer();
    else showScreen(target);
  });
}

$('btn-player-fullscreen').addEventListener('click', toggleFullscreen);

$('btn-player-rotate').addEventListener('click', () => {
  // На ПК «поворот» — это разворот окна на 90°: то же, что делает кнопка на Android
  const video = $('player-video');
  const rotated = video.dataset.rotated === '1';
  video.dataset.rotated = rotated ? '0' : '1';
  video.style.transform = rotated ? '' : 'rotate(90deg) scale(0.72)';
  video.style.transition = 'transform .25s ease';
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    if (document.fullscreenElement) {
      document.exitFullscreen().catch(() => {});
      return;
    }
    const openOverlay = document.querySelector('.overlay:not(.hidden)');
    if (openOverlay && openOverlay.id) {
      closeDialog(openOverlay.id);
      return;
    }
    if (state.screen === 'player') closePlayer();
    else if (state.screen !== 'main') showScreen('main');
  }
});

init();
