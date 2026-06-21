const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, dialog, clipboard } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { ZapretService } = require('./services/zapretService');
const { TgProxyService } = require('./services/tgProxyService');
const appPkg = require('../package.json');

const HUB_RELEASE_API = 'https://api.github.com/repos/xRAYNERx/Zapret-HUB/releases/latest';
const HUB_RELEASE_PAGE = 'https://github.com/xRAYNERx/Zapret-HUB/releases/latest';


function ensureUserDataPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const hubData = path.join(appData, 'zapret-hub');
  const legacyDirs = [
    path.join(appData, 'zapret-new'),
    path.join(appData, 'Zapret NEW'),
  ];

  if (!fs.existsSync(hubData)) {
    for (const legacy of legacyDirs) {
      if (!fs.existsSync(legacy)) continue;
      try {
        fs.cpSync(legacy, hubData, { recursive: true });
        break;
      } catch {
        app.setPath('userData', legacy);
        return;
      }
    }
  }

  app.setPath('userData', hubData);
}

ensureUserDataPath();

app.setName('Zapret HUB');

app.disableHardwareAcceleration();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

let mainWindow = null;
let fatalErrorWindow = null;
let tray = null;
let zapret = null;
let tgProxy = null;
let closeDialogResolver = null;
let statusTimer = null;
let tgProxyTimer = null;
let shutdownDone = false;
let bypassWasRunning = false;
let trayZapretRunning = false;
let trayTgRunning = false;
let lastIntentionalBypassStop = 0;

const isAutostartLaunch = process.argv.includes('--autostart');

function getAppPath() {
  return app.getAppPath();
}

/** Пути из asarUnpack лежат в app.asar.unpacked, не внутри app.asar */
function resolveAppFile(...segments) {
  if (!app.isPackaged) {
    return path.join(getAppPath(), ...segments);
  }
  const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', ...segments);
  if (fs.existsSync(unpacked)) return unpacked;
  return path.join(getAppPath(), ...segments);
}

function getConfigPath() {
  return app.isPackaged
    ? path.join(app.getPath('userData'), 'config.json')
    : path.join(getAppPath(), 'config.json');
}

function getIconPath() {
  if (app.isPackaged) {
    const packagedIcon = path.join(process.resourcesPath, 'icon.png');
    if (fs.existsSync(packagedIcon)) return packagedIcon;
    const unpackedIcon = resolveAppFile('assets', 'icon.png');
    if (fs.existsSync(unpackedIcon)) return unpackedIcon;
  }
  return path.join(getAppPath(), 'assets', 'icon.png');
}

function logStartup(message) {
  try {
    const logPath = path.join(app.getPath('userData'), 'startup.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
  } catch {
    // ignore logging errors
  }
}

function loadWindowIcon() {
  const iconPath = getIconPath();
  let icon = nativeImage.createFromPath(iconPath);
  if (icon.isEmpty()) {
    const svg = Buffer.from(
      '<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="12" fill="#0b0f14"/><text x="32" y="42" text-anchor="middle" font-size="28" fill="#38bdf8">Z</text></svg>'
    );
    icon = nativeImage.createFromBuffer(svg);
  }
  return icon;
}

function sendInAppNotify(message) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('notify', message);
}

function showFatalErrorWindow(title, message, detail) {
  if (fatalErrorWindow && !fatalErrorWindow.isDestroyed()) {
    fatalErrorWindow.webContents.send('error-content', { title, message, detail });
    fatalErrorWindow.show();
    fatalErrorWindow.focus();
    return;
  }

  const icon = loadWindowIcon();
  fatalErrorWindow = new BrowserWindow({
    width: 480,
    height: 380,
    center: true,
    show: false,
    frame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    backgroundColor: '#2a2f38',
    title: 'Zapret HUB',
    icon,
    webPreferences: {
      preload: path.join(__dirname, 'error-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  });

  fatalErrorWindow.loadFile(resolveAppFile('src', 'error.html')).then(() => {
    if (fatalErrorWindow.isDestroyed()) return;
    fatalErrorWindow.webContents.send('error-content', { title, message, detail });
    fatalErrorWindow.show();
  }).catch(() => {
    app.isQuitting = true;
    app.quit();
  });

  fatalErrorWindow.on('closed', () => {
    fatalErrorWindow = null;
    if (!app.isQuitting) {
      app.isQuitting = true;
      app.quit();
    }
  });
}

function showMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function createWindow() {
  const icon = loadWindowIcon();

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 820,
    minWidth: 900,
    minHeight: 680,
    center: true,
    show: false,
    frame: false,
    maximizable: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0f14',
    title: 'Zapret HUB',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    icon
  });

  const indexPath = resolveAppFile('src', 'index.html');
  logStartup(`Loading UI: ${indexPath}`);

  mainWindow.loadFile(indexPath).catch((err) => {
    logStartup(`loadFile failed: ${err.message}`);
    showFatalErrorWindow(
      'Не удалось открыть интерфейс',
      'Закройте все копии Zapret HUB в диспетчере задач и запустите снова из папки установки.',
      err.message
    );
  });

  mainWindow.once('ready-to-show', () => {
    logStartup('Window ready-to-show');
    if (isAutostartLaunch || zapret?.config?.startMinimized) {
      mainWindow.hide();
    } else {
      showMainWindow();
    }
    setTimeout(() => checkUpdatesOnStartup(), 800);
    if (isAutostartLaunch) {
      setTimeout(() => runAutostartActions(), 1500);
    }
  });

  setTimeout(() => {
    if (
      mainWindow &&
      !mainWindow.isDestroyed() &&
      !mainWindow.isVisible() &&
      !zapret?.config?.startMinimized &&
      !isAutostartLaunch
    ) {
      logStartup('Fallback show after timeout');
      showMainWindow();
    }
  }, 1500);

  mainWindow.webContents.on('did-fail-load', (_event, code, description, url) => {
    logStartup(`did-fail-load: ${code} ${description} ${url}`);
  });

  mainWindow.on('close', (e) => {
    if (app.isQuitting) return;
    handleWindowClose(e);
  });
}

function waitForCloseDialogChoice() {
  return new Promise((resolve) => {
    closeDialogResolver = resolve;
  });
}

function resolveCloseDialogChoice(choice) {
  if (!closeDialogResolver) return;
  const resolve = closeDialogResolver;
  closeDialogResolver = null;
  resolve(choice);
}

async function handleWindowClose(e) {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  if (zapret?.config?.closeBehavior === 'quit') {
    app.isQuitting = true;
    app.quit();
    return;
  }

  if (zapret?.config?.closeBehavior === 'tray') {
    e.preventDefault();
    mainWindow.hide();
    return;
  }

  e.preventDefault();
  mainWindow.webContents.send('show-close-dialog');
  const choice = await waitForCloseDialogChoice();

  if (choice === 'tray') {
    mainWindow.hide();
    return;
  }

  if (choice === 'quit-remember') {
    zapret.config.closeBehavior = 'quit';
    zapret.saveConfig();
  }

  if (choice === 'quit' || choice === 'quit-remember') {
    app.isQuitting = true;
    app.quit();
  }
}

function createTray() {
  let icon = loadWindowIcon();
  if (!icon.isEmpty()) {
    icon = icon.resize({ width: 16, height: 16 });
  }

  tray = new Tray(icon);
  tray.setToolTip('Zapret HUB');

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) mainWindow.hide();
      else {
        mainWindow.show();
        mainWindow.focus();
      }
    }
  });

  updateTrayMenu(false, false);
}

async function updateTrayMenu(zapretRunning, tgRunning) {
  if (!tray) return;

  trayZapretRunning = Boolean(zapretRunning);
  trayTgRunning = Boolean(tgRunning);
  tray.setToolTip(
    trayZapretRunning && trayTgRunning
      ? 'Zapret HUB — обход и TG Proxy работают'
      : trayZapretRunning
        ? 'Zapret HUB — обход работает'
        : trayTgRunning
          ? 'Zapret HUB — TG Proxy работает'
          : 'Zapret HUB — выключено'
  );

  const contextMenu = Menu.buildFromTemplate([
    {
      label: trayZapretRunning ? '● Обход: работает' : '○ Обход: выключен',
      enabled: false
    },
    {
      label: trayZapretRunning ? 'Выключить обход' : 'Включить обход',
      click: async () => {
        try {
          if (trayZapretRunning) {
            lastIntentionalBypassStop = Date.now();
            bypassWasRunning = false;
            await zapret.stop();
          } else {
            const status = await zapret.start(zapret.config.lastStrategy || 'general.bat');
            if (status.running) {
              sendInAppNotify('Включение обхода');
            }
          }
          const status = await zapret.getStatus();
          bypassWasRunning = status.running;
          mainWindow?.webContents.send('status-changed', status);
          const tgStatus = tgProxy ? await tgProxy.getStatus() : { running: trayTgRunning };
          updateTrayMenu(status.running, tgStatus.running);
        } catch (err) {
          mainWindow?.webContents.send('error', err.message);
        }
      }
    },
    { type: 'separator' },
    {
      label: trayTgRunning ? '● TG Proxy: работает' : '○ TG Proxy: выключен',
      enabled: false
    },
    {
      label: trayTgRunning ? 'Выключить TG Proxy' : 'Включить TG Proxy',
      click: async () => {
        if (!tgProxy) return;
        try {
          if (trayTgRunning) {
            const status = await tgProxy.stop();
            mainWindow?.webContents.send('tg-proxy-changed', status);
            updateTrayMenu(trayZapretRunning, status.running);
          } else {
            const status = await tgProxy.start();
            mainWindow?.webContents.send('tg-proxy-changed', status);
            if (status.running) {
              sendInAppNotify('TG Proxy включён');
            }
            updateTrayMenu(trayZapretRunning, status.running);
          }
        } catch (err) {
          mainWindow?.webContents.send('error', err.message);
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Открыть окно',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      }
    },
    {
      label: 'Выход',
      click: () => {
        app.isQuitting = true;
        app.quit();
      }
    }
  ]);

  tray.setContextMenu(contextMenu);
}

function notifyBypassDropped(status) {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send('bypass-dropped', {
    lastStrategy: status.lastStrategy,
    at: new Date().toISOString()
  });
  if (mainWindow.isMinimized() || !mainWindow.isVisible()) {
    mainWindow.show();
  }
  mainWindow.focus();
}

function startStatusPolling() {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(async () => {
    if (!zapret || !mainWindow) return;
    try {
      const status = await zapret.getStatus();
      const sinceIntentional = Date.now() - lastIntentionalBypassStop;
      if (bypassWasRunning && !status.running && !app.isQuitting && sinceIntentional > 4000) {
        notifyBypassDropped(status);
      }
      bypassWasRunning = status.running;
      mainWindow.webContents.send('status-changed', status);
      updateTrayMenu(status.running, trayTgRunning);
    } catch { /* ignore */ }
  }, 3000);
}

function startTgProxyPolling() {
  if (tgProxyTimer) clearInterval(tgProxyTimer);
  tgProxyTimer = setInterval(async () => {
    if (!tgProxy || !mainWindow) return;
    try {
      const status = await tgProxy.getStatus();
      mainWindow.webContents.send('tg-proxy-changed', status);
      updateTrayMenu(trayZapretRunning, status.running);
    } catch { /* ignore */ }
  }, 3000);
}

function syncLoginItem() {
  if (process.platform !== 'win32' || !zapret) return;
  const enabled = zapret.isAppAutostartEnabled();
  const current = app.getLoginItemSettings();
  if (current.openAtLogin === enabled) return;
  app.setLoginItemSettings({
    openAtLogin: enabled,
    path: process.execPath,
    args: enabled ? ['--autostart'] : []
  });
}

async function runAutostartZapret() {
  if (!zapret?.isAutostartZapretEnabled()) return;
  try {
    const status = await zapret.getStatus();
    if (status.running) return;
    const strategy = zapret.config.lastStrategy || 'general.bat';
    const result = await zapret.start(strategy);
    if (result.running) {
      sendInAppNotify('Автозапуск: включение обхода');
      bypassWasRunning = true;
      mainWindow?.webContents.send('status-changed', result);
      updateTrayMenu(true, trayTgRunning);
    }
  } catch (err) {
    logStartup(`Autostart zapret failed: ${err.message}`);
    sendInAppNotify('Ошибка автозапуска обхода');
  }
}

async function runAutostartTgProxy() {
  if (!zapret?.isAutostartTgProxyEnabled() || !tgProxy) return;
  try {
    const status = await tgProxy.getStatus();
    if (status.running) return;
    const result = await tgProxy.start();
    if (result.running) {
      mainWindow?.webContents.send('tg-proxy-changed', result);
    }
  } catch (err) {
    logStartup(`Autostart tg-proxy failed: ${err.message}`);
  }
}

async function runAutostartActions() {
  await Promise.all([runAutostartZapret(), runAutostartTgProxy()]);
}

function fetchGithubRelease(apiUrl) {
  return new Promise((resolve, reject) => {
    const request = https.get(
      apiUrl,
      { headers: { 'User-Agent': 'ZapretHub', Accept: 'application/vnd.github+json' } },
      (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          https
            .get(response.headers.location, { headers: { 'User-Agent': 'ZapretHub' } }, (redirect) => {
              let data = '';
              redirect.on('data', (chunk) => { data += chunk; });
              redirect.on('end', () => {
                try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
              });
            })
            .on('error', reject);
          return;
        }

        let data = '';
        response.on('data', (chunk) => { data += chunk; });
        response.on('end', () => {
          try {
            const json = JSON.parse(data);
            if (response.statusCode >= 400 || (json.message && !json.tag_name)) {
              reject(new Error(json.message || `HTTP ${response.statusCode}`));
              return;
            }
            if (!json.tag_name) {
              reject(new Error('Некорректный ответ GitHub'));
              return;
            }
            resolve(json);
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    request.on('error', reject);
    request.setTimeout(20000, () => {
      request.destroy();
      reject(new Error('Таймаут запроса к GitHub'));
    });
  });
}

function parseHubTagFromUrl(url) {
  const match = String(url || '').match(/\/releases\/tag\/(v?[\d.]+[a-z]*)/i);
  return match?.[1] || null;
}

function fetchHubReleasePageTag() {
  return new Promise((resolve, reject) => {
    const follow = (targetUrl, depth = 0) => {
      const request = https.get(
        targetUrl,
        { headers: { 'User-Agent': 'ZapretHub', Accept: 'text/html, */*' } },
        (response) => {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && depth < 6) {
            const location = response.headers.location.startsWith('http')
              ? response.headers.location
              : `https://github.com${response.headers.location}`;
            response.resume();
            follow(location, depth + 1);
            return;
          }

          if (response.statusCode && response.statusCode >= 400) {
            response.resume();
            reject(new Error(`HTTP ${response.statusCode}`));
            return;
          }

          const tag = parseHubTagFromUrl(targetUrl);
          if (tag) {
            response.resume();
            resolve(tag);
            return;
          }

          const chunks = [];
          response.on('data', (chunk) => chunks.push(chunk));
          response.on('end', () => {
            const html = Buffer.concat(chunks).toString('utf8');
            const canonical = html.match(/<link[^>]+rel="canonical"[^>]+href="[^"]*\/releases\/tag\/([^"]+)"/i);
            const embedded = html.match(/"tag_name"\s*:\s*"(v?[\d.]+[a-z]*)"/i);
            resolve(canonical?.[1] || embedded?.[1] || null);
          });
        }
      );

      request.on('error', reject);
      request.setTimeout(20000, () => {
        request.destroy();
        reject(new Error('Таймаут запроса к GitHub'));
      });
    };

    follow(HUB_RELEASE_PAGE);
  });
}

async function resolveHubRemoteRelease() {
  try {
    return await fetchGithubRelease(HUB_RELEASE_API);
  } catch (apiError) {
    const tag = await fetchHubReleasePageTag();
    if (!tag) throw apiError;
    const normalizedTag = String(tag).replace(/^v/i, '');
    const version = normalizedTag.replace(/^v/, '');
    return {
      tag_name: tag.startsWith('v') ? tag : `v${tag}`,
      html_url: `https://github.com/xRAYNERx/Zapret-HUB/releases/tag/v${version}`,
      assets: [
        {
          name: `ZapretHub-Setup-${version}.exe`,
          browser_download_url: `https://github.com/xRAYNERx/Zapret-HUB/releases/download/v${version}/ZapretHub-Setup-${version}.exe`
        },
        {
          name: `ZapretHub-Portable-${version}.exe`,
          browser_download_url: `https://github.com/xRAYNERx/Zapret-HUB/releases/download/v${version}/ZapretHub-Portable-${version}.exe`
        }
      ],
      _source: 'page-fallback'
    };
  }
}

async function checkHubForUpdates() {
  const local = appPkg.version;
  try {
    const release = await resolveHubRemoteRelease();
    const remote = (release.tag_name || '').replace(/^v/i, '');
    const updateAvailable = Boolean(remote) && (
      zapret ? zapret.compareVersions(local, remote) < 0 : local !== remote
    );
    return {
      product: 'hub',
      label: 'Zapret HUB',
      local,
      remote,
      updateAvailable,
      releaseUrl: release.html_url || HUB_RELEASE_PAGE
    };
  } catch (e) {
    return {
      product: 'hub',
      label: 'Zapret HUB',
      local,
      remote: null,
      updateAvailable: false,
      releaseUrl: HUB_RELEASE_PAGE,
      error: e.message
    };
  }
}

function resolveHubInstallerAsset(release) {
  const assets = release?.assets || [];
  const setup = assets.find((a) => /^ZapretHub-Setup-/i.test(a.name) && /\.exe$/i.test(a.name));
  const portable = assets.find((a) => /^ZapretHub-Portable-/i.test(a.name) && /\.exe$/i.test(a.name));
  const asset = setup || portable;
  if (!asset?.browser_download_url) return null;
  return { url: asset.browser_download_url, name: asset.name };
}

function downloadHubFile(url, destPath, onProgress) {
  return new Promise((resolve, reject) => {
    let lastReportedPercent = -1;

    const reportProgress = (percent, message) => {
      if (typeof onProgress !== 'function') return;
      const safePercent = Math.min(100, Math.max(0, percent));
      if (safePercent === lastReportedPercent) return;
      lastReportedPercent = safePercent;
      onProgress({ percent: safePercent, message: message || `Скачивание Zapret HUB… ${safePercent}%` });
    };

    const request = (targetUrl) => {
      https
        .get(targetUrl, { headers: { 'User-Agent': 'ZapretHub' } }, (response) => {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            request(response.headers.location);
            return;
          }

          if (response.statusCode !== 200) {
            reject(new Error(`Не удалось скачать (HTTP ${response.statusCode})`));
            return;
          }

          const total = Number(response.headers['content-length'] || 0);
          let downloaded = 0;
          const file = fs.createWriteStream(destPath);

          reportProgress(0, 'Скачивание установщика Zapret HUB…');

          response.on('data', (chunk) => {
            downloaded += chunk.length;
            if (total > 0) {
              const percent = Math.round((downloaded / total) * 100);
              if (percent >= lastReportedPercent + 5 || percent === 100) {
                reportProgress(percent);
              }
            }
          });

          response.pipe(file);
          file.on('finish', () => file.close(() => {
            reportProgress(100, 'Установщик скачан');
            resolve();
          }));
          file.on('error', (err) => {
            fs.unlink(destPath, () => reject(err));
          });
        })
        .on('error', reject);
    };

    request(url);
  });
}

function getHubInstallDir() {
  return path.dirname(process.execPath).replace(/[\\/]+$/, '');
}

async function stopServicesBeforeHubInstall() {
  try {
    if (zapret) {
      const status = await zapret.getStatus();
      if (status.running) await zapret.stop();
    }
  } catch (err) {
    logStartup(`Hub update stop zapret failed: ${err.message}`);
  }
  try {
    if (tgProxy) await tgProxy.stop();
  } catch (err) {
    logStartup(`Hub update stop tg-proxy failed: ${err.message}`);
  }
}

async function launchHubInstaller(installerPath, onProgress) {
  const installDir = getHubInstallDir();
  const args = ['/S', `/D=${installDir}`];

  if (typeof onProgress === 'function') {
    onProgress({ percent: 100, message: 'Установка Zapret HUB…' });
  }

  await stopServicesBeforeHubInstall();
  logStartup(`Hub update: ${installerPath} ${args.join(' ')}`);

  await new Promise((resolve, reject) => {
    const child = spawn(installerPath, args, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.on('error', reject);
    child.unref();
    resolve();
  });

  app.isQuitting = true;
  setTimeout(() => app.quit(), 800);
}

async function applyHubUpdate(onProgress) {
  const release = await resolveHubRemoteRelease();
  const asset = resolveHubInstallerAsset(release);
  if (!asset) {
    throw new Error('Установщик Zapret HUB не найден в релизе на GitHub');
  }

  const updatesDir = path.join(app.getPath('userData'), 'updates', 'hub');
  fs.mkdirSync(updatesDir, { recursive: true });
  const destPath = path.join(updatesDir, asset.name);

  await downloadHubFile(asset.url, destPath, onProgress);

  if (typeof onProgress === 'function') {
    onProgress({ percent: 100, message: 'Запуск установки…' });
  }

  await launchHubInstaller(destPath, onProgress);

  return {
    local: appPkg.version,
    remote: (release.tag_name || '').replace(/^v/, ''),
    installerPath: destPath,
    quitting: true
  };
}

async function checkAllUpdatesBundle(options = {}) {
  const [hub, zapretUpdate, tg] = await Promise.all([
    checkHubForUpdates(),
    zapret.checkForUpdates(options),
    tgProxy ? tgProxy.checkForUpdates() : Promise.resolve({ updateAvailable: false })
  ]);

  return {
    hub,
    zapret: { product: 'zapret', label: 'Движок обхода', ...zapretUpdate },
    tg: { product: 'tg', label: 'TG Proxy', ...tg }
  };
}

function hasPendingUpdates(all) {
  return [all.hub, all.zapret, all.tg].some((info) => info?.updateAvailable && !info?.error);
}

async function checkUpdatesOnStartup() {
  if (!zapret || zapret.config.autoCheckUpdates === false) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  try {
    zapret.removeLegacyUpdateFlag();
    const all = await checkAllUpdatesBundle();
    if (!hasPendingUpdates(all)) return;
    mainWindow.webContents.send('startup-updates-available', all);
  } catch (err) {
    logStartup(`Startup update check failed: ${err.message}`);
  }
}

async function stopAllServices() {
  logStartup('Stopping services on quit...');
  try {
    if (zapret) {
      const status = await zapret.getStatus();
      if (status.running) {
        lastIntentionalBypassStop = Date.now();
        await zapret.stop();
      }
    }
  } catch (err) {
    logStartup(`Quit zapret stop failed: ${err.message}`);
  }
  try {
    if (tgProxy) {
      const tgStatus = await tgProxy.getStatus();
      if (tgStatus.running) await tgProxy.stop();
    }
  } catch (err) {
    logStartup(`Quit tg-proxy stop failed: ${err.message}`);
  }
}

function registerIpc() {
  const handlers = {
    'window-minimize': () => {
      mainWindow?.minimize();
      return true;
    },
    'window-close': () => {
      mainWindow?.close();
      return true;
    },
    'window-close-choice': (_, choice) => {
      resolveCloseDialogChoice(choice);
      return true;
    },
    'get-status': () => zapret.getStatus(),
    'get-strategies': () => zapret.getStrategies(),
    'start': async (_, strategy) => {
      const status = await zapret.start(strategy);
      bypassWasRunning = status.running;
      if (status.running) {
        sendInAppNotify('Включение обхода');
      }
      return status;
    },
    'set-strategy': (_, strategy) => zapret.setLastStrategy(strategy),
    'restart': async (_, strategy) => {
      const status = await zapret.restart(strategy);
      bypassWasRunning = status.running;
      if (status.running) {
        sendInAppNotify('Смена стратегии обхода');
      }
      return status;
    },
    'stop': async () => {
      lastIntentionalBypassStop = Date.now();
      const status = await zapret.stop();
      bypassWasRunning = false;
      sendInAppNotify('Выключение обхода');
      return status;
    },
    'get-sites': () => zapret.getGeneralSites(),
    'save-sites': (_, sites) => zapret.saveGeneralSites(sites),
    'get-custom-lists': () => zapret.getCustomLists(),
    'create-custom-list': (_, name) => zapret.createCustomList(name),
    'get-custom-list-sites': (_, listId) => zapret.getCustomListSites(listId),
    'save-custom-list-sites': (_, listId, sites) => zapret.saveCustomListSites(listId, sites),
    'set-active-custom-list': (_, listId) => zapret.setActiveCustomList(listId),
    'delete-custom-list': (_, listId) => zapret.deleteCustomList(listId),
    'get-settings': async () => {
      const status = await zapret.getStatus();
      return {
        gameFilter: status.gameFilter,
        ipset: status.ipset,
        autoUpdate: status.autoUpdate,
        zapretPath: status.zapretPath
      };
    },
    'set-game-filter': (_, mode) => zapret.setGameFilter(mode),
    'set-autostart-zapret': async (_, enabled) => {
      const status = await zapret.setAutostartZapret(enabled);
      syncLoginItem();
      return status;
    },
    'set-autostart-tg': async (_, enabled) => {
      const status = await zapret.setAutostartTgProxy(enabled);
      syncLoginItem();
      return status;
    },
    'set-start-minimized': (_, enabled) => zapret.setStartMinimized(enabled),
    'set-ipset': (_, mode) => zapret.setIpset(mode),
    'set-auto-update': (_, enabled) => zapret.setAutoUpdate(enabled),
    'set-zapret-path': (_, p) => zapret.setZapretPath(p),
    'browse-zapret-path': () => zapret.browseFolder(),
    'validate-path': () => zapret.validateZapretPath(),
    'run-diagnostics': () => zapret.runDiagnostics(),
    'check-updates': (_, options) => zapret.checkForUpdates(options || {}),
    'check-all-updates': (_, options) => checkAllUpdatesBundle(options || {}),
    'apply-hub-update': async () => {
      const sendProgress = (progress) => {
        mainWindow?.webContents.send('hub-update-progress', progress);
      };
      return applyHubUpdate(sendProgress);
    },
    'apply-update': async (_, remoteVersion) => {
      const sendProgress = (progress) => {
        mainWindow?.webContents.send('update-progress', progress);
      };
      return zapret.applyUpdate(remoteVersion, sendProgress);
    },
    'run-tests': () => zapret.runTests(),
    'run-strategy-probe': async (_, options) => {
      const sendProgress = (progress) => {
        mainWindow?.webContents.send('strategy-probe-progress', progress);
      };
      return zapret.runStrategyProbe(options || {}, sendProgress);
    },
    'cancel-strategy-probe': () => zapret.cancelStrategyProbe(),
    'open-external': (_, url) => shell.openExternal(url),
    'get-config': () => zapret.config,
    'get-tg-proxy-status': () => tgProxy.getStatus(),
    'start-tg-proxy': async () => {
      const sendProgress = (progress) => {
        mainWindow?.webContents.send('tg-proxy-progress', progress);
      };
      return tgProxy.start(sendProgress);
    },
    'stop-tg-proxy': () => tgProxy.stop(),
    'check-tg-proxy-updates': () => tgProxy.checkForUpdates(),
    'apply-tg-proxy-update': async () => {
      const sendProgress = (progress) => {
        mainWindow?.webContents.send('tg-proxy-progress', progress);
      };
      return tgProxy.applyUpdate(sendProgress);
    },
    'open-tg-proxy-telegram': () => tgProxy.openInTelegram((url) => shell.openExternal(url)),
    'copy-tg-proxy-link': () => tgProxy.copyProxyLink(),
    'open-tg-proxy-settings': () => tgProxy.openSettings(),
    'set-close-behavior': (_, mode) => zapret.setCloseBehavior(mode ?? null),
    'set-onboarding-completed': (_, completed) => zapret.setOnboardingCompleted(completed),
    'read-clipboard-text': () => clipboard.readText(),
    'export-sites-dialog': async (_, options = {}) => {
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Экспорт списка доменов',
        defaultPath: options.defaultName || 'list-general.txt',
        filters: [{ name: 'Текстовые файлы', extensions: ['txt'] }]
      });
      if (canceled || !filePath) return { saved: false };
      const text = options.listId
        ? zapret.exportCustomListSitesText(options.listId)
        : zapret.exportGeneralSitesText();
      fs.writeFileSync(filePath, text, 'utf8');
      return { saved: true, filePath, count: text.trim() ? text.trim().split('\n').length : 0 };
    },
    'import-sites-dialog': async (_, options = {}) => {
      const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
        title: 'Импорт списка доменов',
        filters: [{ name: 'Текстовые файлы', extensions: ['txt'] }],
        properties: ['openFile']
      });
      if (canceled || !filePaths?.[0]) return { imported: false };
      const text = fs.readFileSync(filePaths[0], 'utf8');
      const mode = options.mode === 'replace' ? 'replace' : 'merge';
      const sites = options.listId
        ? zapret.importCustomListSites(options.listId, text, mode)
        : zapret.importGeneralSites(text, mode);
      return { imported: true, filePath: filePaths[0], sites, mode };
    },
    'import-sites-text': (_, payload = {}) => {
      const mode = payload.mode === 'replace' ? 'replace' : 'merge';
      const sites = payload.listId
        ? zapret.importCustomListSites(payload.listId, payload.text, mode)
        : zapret.importGeneralSites(payload.text, mode);
      return { sites, mode };
    },
    'fatal-error-quit': () => {
      app.isQuitting = true;
      app.quit();
      return true;
    },
    'relaunch-app': async () => {
      app.isQuitting = true;
      try {
        const status = await zapret.getStatus();
        if (status.running) {
          await zapret.stop();
        }
      } catch (err) {
        logStartup(`Relaunch stop failed: ${err.message}`);
      }
      try {
        if (tgProxy) await tgProxy.stop();
      } catch (err) {
        logStartup(`Relaunch tg-proxy stop failed: ${err.message}`);
      }
      app.relaunch();
      app.quit();
      return true;
    }
  };

  for (const [channel, handler] of Object.entries(handlers)) {
    ipcMain.handle(channel, async (event, ...args) => {
      try {
        return { ok: true, data: await handler(event, ...args) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });
  }
}

app.on('second-instance', () => {
  showMainWindow();
  sendInAppNotify('Zapret HUB уже запущен — окно восстановлено');
});

app.whenReady().then(async () => {
  try {
    logStartup('App ready');
    const userDataPath = app.getPath('userData');
    zapret = new ZapretService(getAppPath(), {
      configPath: getConfigPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      userDataPath
    });
    tgProxy = new TgProxyService(userDataPath, {
      appPath: getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath
    });
    zapret.migrateAutostartConfig()
      .then(() => syncLoginItem())
      .catch((err) => logStartup(`Autostart migrate failed: ${err.message}`));
    await zapret.prepareStartup();
    const initialStatus = await zapret.getStatus();
    bypassWasRunning = initialStatus.running;
    createWindow();
    createTray();
    registerIpc();
    startStatusPolling();
    startTgProxyPolling();
    if (tgProxy) {
      tgProxy.getStatus()
        .then((tgStatus) => updateTrayMenu(initialStatus.running, tgStatus.running))
        .catch(() => updateTrayMenu(initialStatus.running, false));
    }
  } catch (err) {
    logStartup(`Startup error: ${err.message}`);
    showFatalErrorWindow('Ошибка запуска', 'Не удалось запустить Zapret HUB.', err.message);
    return;
  }

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
    else showMainWindow();
  });
});

process.on('uncaughtException', (err) => {
  logStartup(`uncaughtException: ${err.message}`);
});

app.on('before-quit', (e) => {
  app.isQuitting = true;
  if (statusTimer) clearInterval(statusTimer);
  if (tgProxyTimer) clearInterval(tgProxyTimer);
  if (tray) {
    tray.destroy();
    tray = null;
  }

  if (shutdownDone) return;
  e.preventDefault();
  shutdownDone = true;
  stopAllServices().finally(() => {
    app.quit();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    // keep running in tray
  }
});