const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, dialog } = require('electron');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { ZapretService } = require('./services/zapretService');
const { TgProxyService } = require('./services/tgProxyService');


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

app.disableHardwareAcceleration();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.whenReady().then(() => {
    dialog.showMessageBoxSync({
      type: 'info',
      title: 'Zapret HUB',
      message: 'Zapret HUB уже запущен',
      detail: 'Проверьте иконку в трее (возле часов) или откройте окно из меню Пуск.'
    });
    app.quit();
  });
}

let mainWindow = null;
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
    dialog.showErrorBox(
      'Zapret HUB',
      `Не удалось открыть интерфейс.\n\n${err.message}\n\n` +
        'Закройте все копии Zapret HUB в диспетчере задач и запустите снова из:\n' +
        'Папка установки Zapret HUB'
    );
    app.isQuitting = true;
    app.quit();
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

async function checkUpdatesOnStartup() {
  if (!zapret || zapret.config.autoCheckUpdates === false) return;

  try {
    zapret.removeLegacyUpdateFlag();
    const info = await zapret.checkForUpdates();
    if (!info.updateAvailable || !mainWindow || mainWindow.isDestroyed()) return;

    const { response } = await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Доступно обновление Zapret',
      message: `Вышла новая версия ${info.remote}`,
      detail: `У вас установлена ${info.local}. Обновить автоматически?`,
      buttons: ['Обновить', 'Позже'],
      defaultId: 0,
      cancelId: 1,
      noLink: true
    });

    if (response !== 0) return;

    const result = await zapret.applyUpdate(info.remote, (progress) => {
      mainWindow?.webContents.send('update-progress', progress);
    });

    const status = await zapret.getStatus();
    mainWindow.webContents.send('status-changed', status);

    await dialog.showMessageBox(mainWindow, {
      type: 'info',
      title: 'Обновление завершено',
      message: `Zapret обновлён до версии ${result.local}`,
      detail: result.restarted
        ? 'Zapret был остановлен для обновления. Включите его снова, если нужно.'
        : 'Можно продолжать работу.',
      buttons: ['OK']
    });
  } catch (err) {
    logStartup(`Startup update failed: ${err.message}`);
    if (mainWindow && !mainWindow.isDestroyed()) {
      dialog.showMessageBox(mainWindow, {
        type: 'error',
        title: 'Ошибка обновления',
        message: 'Не удалось установить обновление',
        detail: err.message,
        buttons: ['OK']
      });
    }
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
    'check-updates': () => zapret.checkForUpdates(),
    'apply-update': async (_, remoteVersion) => {
      const sendProgress = (progress) => {
        mainWindow?.webContents.send('update-progress', progress);
      };
      return zapret.applyUpdate(remoteVersion, sendProgress);
    },
    'run-tests': () => zapret.runTests(),
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
});

app.whenReady().then(() => {
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
    zapret.removeLegacyUpdateFlag();
    zapret.migrateAutostartConfig()
      .then(() => syncLoginItem())
      .catch((err) => logStartup(`Autostart migrate failed: ${err.message}`));
    try {
      zapret.syncActiveCustomList();
    } catch (err) {
      logStartup(`Custom list sync failed: ${err.message}`);
    }
    zapret.applyPendingUpdates().catch((err) => logStartup(`Pending update apply failed: ${err.message}`));
    createWindow();
    createTray();
    registerIpc();
    startStatusPolling();
    startTgProxyPolling();
  } catch (err) {
    logStartup(`Startup error: ${err.message}`);
    dialog.showErrorBox('Zapret HUB', `Ошибка запуска:\n${err.message}`);
    app.quit();
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