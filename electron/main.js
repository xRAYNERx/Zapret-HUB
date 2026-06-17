const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell } = require('electron');
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

  updateTrayMenu(false);
}

async function updateTrayMenu(running) {
  if (!tray) return;

  const contextMenu = Menu.buildFromTemplate([
    {
      label: running ? '● Zapret работает' : '○ Zapret выключен',
      enabled: false
    },
    { type: 'separator' },
    {
      label: 'Открыть',
      click: () => {
        mainWindow?.show();
        mainWindow?.focus();
      }
    },
    {
      label: running ? 'Выключить' : 'Включить',
      click: async () => {
        try {
          if (running) {
            await zapret.stop();
          } else {
            const status = await zapret.start(zapret.config.lastStrategy || 'general.bat');
            if (status.running) {
              sendInAppNotify('Включение обхода');
            }
          }
          const status = await zapret.getStatus();
          mainWindow?.webContents.send('status-changed', status);
          updateTrayMenu(status.running);
        } catch (err) {
          mainWindow?.webContents.send('error', err.message);
        }
      }
    },
    { type: 'separator' },
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

function startStatusPolling() {
  if (statusTimer) clearInterval(statusTimer);
  statusTimer = setInterval(async () => {
    if (!zapret || !mainWindow) return;
    try {
      const status = await zapret.getStatus();
      mainWindow.webContents.send('status-changed', status);
      updateTrayMenu(status.running);
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
      mainWindow?.webContents.send('status-changed', result);
      updateTrayMenu(true);
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
          try { resolve(JSON.parse(data)); } catch (e) { reject(e); }
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

async function checkHubForUpdates() {
  const local = appPkg.version;
  try {
    const release = await fetchGithubRelease(HUB_RELEASE_API);
    const remote = (release.tag_name || '').replace(/^v/, '');
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

async function applyHubUpdate(onProgress) {
  const release = await fetchGithubRelease(HUB_RELEASE_API);
  const asset = resolveHubInstallerAsset(release);
  if (!asset) {
    throw new Error('Установщик Zapret HUB не найден в релизе на GitHub');
  }

  const updatesDir = path.join(app.getPath('userData'), 'updates', 'hub');
  fs.mkdirSync(updatesDir, { recursive: true });
  const destPath = path.join(updatesDir, asset.name);

  await downloadHubFile(asset.url, destPath, onProgress);
  await shell.openPath(destPath);

  return {
    local: appPkg.version,
    remote: (release.tag_name || '').replace(/^v/, ''),
    installerPath: destPath
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
      if (status.running) await zapret.stop();
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
      if (status.running) {
        sendInAppNotify('Включение обхода');
      }
      return status;
    },
    'set-strategy': (_, strategy) => zapret.setLastStrategy(strategy),
    'restart': async (_, strategy) => {
      const status = await zapret.restart(strategy);
      if (status.running) {
        sendInAppNotify('Смена стратегии обхода');
      }
      return status;
    },
    'stop': async () => {
      const status = await zapret.stop();
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
    'open-tg-proxy-telegram': () => tgProxy.openInTelegram(),
    'copy-tg-proxy-link': () => tgProxy.copyProxyLink(),
    'open-tg-proxy-settings': () => tgProxy.openSettings(),
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
    createWindow();
    createTray();
    registerIpc();
    startStatusPolling();
    startTgProxyPolling();
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