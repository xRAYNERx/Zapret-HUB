const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, shell, dialog, clipboard, Notification } = require('electron');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const { ZapretService } = require('./services/zapretService');
const { TgProxyService } = require('./services/tgProxyService');
const { VlessService } = require('./services/vlessService');
const { fetchUrl, fetchGithubRelease, fetchGithubReleases, downloadFile } = require('./helpers/httpFetch');
const appPkg = require('../package.json');

const PRIME_RELEASE_API = 'https://api.github.com/repos/xRAYNERx/Zapret-PRIME/releases/latest';
const PRIME_RELEASE_PAGE = 'https://github.com/xRAYNERx/Zapret-PRIME/releases/latest';
const HUB_RELEASE_API = 'https://api.github.com/repos/xRAYNERx/Zapret-HUB/releases/latest';
const HUB_RELEASE_PAGE = 'https://github.com/xRAYNERx/Zapret-HUB/releases/latest';

function ensureUserDataPath() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  const primeData = path.join(appData, 'zapret-prime');
  const legacyDirs = [
    path.join(appData, 'zapret-hub'),
    path.join(appData, 'Zapret HUB'),
    path.join(appData, 'zapret-new'),
    path.join(appData, 'Zapret NEW'),
  ];

  if (!fs.existsSync(primeData)) {
    for (const legacy of legacyDirs) {
      if (!fs.existsSync(legacy)) continue;
      try {
        fs.cpSync(legacy, primeData, { recursive: true });
        break;
      } catch {
        app.setPath('userData', legacy);
        return;
      }
    }
  }

  app.setPath('userData', primeData);
}

ensureUserDataPath();

app.setName('Zapret Prime');
if (process.platform === 'win32') {
  app.setAppUserModelId('com.rayner.zapret-prime');
}

app.disableHardwareAcceleration();

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  logStartup('SingleInstance: another instance is running. Exiting secondary process.');
  app.exit(0);
}

let mainWindow = null;
let fatalErrorWindow = null;
let tray = null;
let zapret = null;
let tgProxy = null;
let vless = null;
let closeDialogResolver = null;
let statusTimer = null;
let tgProxyTimer = null;
let shutdownDone = false;
let bypassWasRunning = false;
let trayZapretRunning = false;
let trayTgRunning = false;
let lastIntentionalBypassStop = 0;
let bypassDropSuppressedUntil = 0;
const AUTOSTART_TASK_NAME = 'Zapret Prime';
const BYPASS_RESTART_SUPPRESS_MS = 25000;
const BYPASS_PROBE_SUPPRESS_MS = 30 * 60 * 1000;
const BYPASS_UPDATE_SUPPRESS_MS = 2 * 60 * 1000;

function suppressBypassDrop(ms = BYPASS_RESTART_SUPPRESS_MS) {
  bypassDropSuppressedUntil = Math.max(bypassDropSuppressedUntil, Date.now() + ms);
}

function isBypassDropSuppressed() {
  if (Date.now() < bypassDropSuppressedUntil) return true;
  return Boolean(zapret?.isStrategyProbeRunning?.());
}

function markBypassRunning(running) {
  bypassWasRunning = Boolean(running);
}

const isAutostartLaunch = process.argv.includes('--autostart');

/** Пути из asarUnpack лежат в app.asar.unpacked, не внутри app.asar */
function resolveAppFile(...segments) {
  if (!app.isPackaged) {
    return path.join(app.getAppPath(), ...segments);
  }
  const unpacked = path.join(process.resourcesPath, 'app.asar.unpacked', ...segments);
  if (fs.existsSync(unpacked)) return unpacked;
  return path.join(app.getAppPath(), ...segments);
}

function getConfigPath() {
  return app.isPackaged
    ? path.join(app.getPath('userData'), 'config.json')
    : path.join(app.getAppPath(), 'config.json');
}

function getIconPath() {
  if (app.isPackaged) {
    const packagedIcon = path.join(process.resourcesPath, 'icon.png');
    if (fs.existsSync(packagedIcon)) return packagedIcon;
    const unpackedIcon = resolveAppFile('assets', 'icon.png');
    if (fs.existsSync(unpackedIcon)) return unpackedIcon;
  }
  return path.join(app.getAppPath(), 'assets', 'icon.png');
}

function logStartup(message) {
  try {
    const logPath = path.join(app.getPath('userData'), 'startup.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    try {
      const stat = fs.statSync(logPath);
      if (stat.size > 1024 * 1024) {
        fs.writeFileSync(logPath, `[${new Date().toISOString()}] [Log rotated]\n`, 'utf8');
      }
    } catch {}
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
    title: 'Zapret Prime',
    icon,
    webPreferences: {
      preload: path.join(__dirname, 'error-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
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
    width: 1250,
    height: 838,
    minWidth: 1250,
    minHeight: 838,
    resizable: false,
    center: true,
    show: false,
    frame: false,
    backgroundColor: '#1e2534',
    hasShadow: true,
    maximizable: false,
    autoHideMenuBar: true,
    title: 'Zapret Prime',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false
    },
    icon
  });

  const indexPath = resolveAppFile('src', 'index.html');
  logStartup(`Loading UI: ${indexPath}`);

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:') || url.startsWith('tg:')) {
      shell.openExternal(url);
      return { action: 'deny' };
    }
    return { action: 'allow' };
  });

  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (url.startsWith('https:') || url.startsWith('http:') || url.startsWith('tg:')) {
      event.preventDefault();
      shell.openExternal(url);
    }
  });

  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': ["default-src 'self' data:; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' ws: wss:;"]
      }
    });
  });

  mainWindow.loadFile(indexPath).catch((err) => {
    logStartup(`loadFile failed: ${err.message}`);
    showFatalErrorWindow(
      'Не удалось открыть интерфейс',
      'Закройте все копии Zapret Prime в диспетчере задач и запустите снова из папки установки.',
      err.message
    );
  });

  mainWindow.once('ready-to-show', () => {
    logStartup('Window ready-to-show');
    if (zapret?.config?.startMinimized) {
      mainWindow.hide();
    } else {
      showMainWindow();
    }
    setTimeout(() => checkUpdatesOnStartup(), 800);
    if (isAutostartLaunch || zapret?.isAppAutostartEnabled()) {
      runAutostartActions().catch((err) => logStartup(`Autostart ready-to-show error: ${err.message}`));
    }
  });

  setTimeout(() => {
    if (
      mainWindow &&
      !mainWindow.isDestroyed() &&
      !mainWindow.isVisible() &&
      !zapret?.config?.startMinimized
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

  if (choice === 'quit') {
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
  tray.setToolTip('Zapret Prime');

  tray.on('click', () => {
    if (mainWindow) {
      if (mainWindow.isVisible()) mainWindow.hide();
      else {
        showMainWindow();
      }
    }
  });

  updateTrayMenu(false, false);
}

function cleanServerName(name = '') {
  let cleaned = String(name || '');
  cleaned = cleaned.replace(/[\u{1F1E6}-\u{1F1FF}]/gu, '');
  cleaned = cleaned.replace(/\p{Extended_Pictographic}/gu, '');
  cleaned = cleaned.trim();
  cleaned = cleaned.replace(/^[A-Za-z]{2}\s*[-–—:\s]+\s*/u, '');
  cleaned = cleaned.replace(/^[A-Za-z]{2}\s+/u, '');
  cleaned = cleaned.trim();
  if (cleaned.length > 0) {
    cleaned = cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
  }
  return cleaned || name;
}

let trayVlessRunning = false;
let trayVlessNodeName = '';
let trayVlessPing = null;

async function updateTrayMenu(zapretRunning, tgRunning, vlessRunning, vlessNode, vlessPing) {
  if (!tray) return;

  if (typeof zapretRunning === 'boolean') trayZapretRunning = zapretRunning;
  if (typeof tgRunning === 'boolean') trayTgRunning = tgRunning;
  if (typeof vlessRunning === 'boolean') {
    trayVlessRunning = vlessRunning;
    trayVlessNodeName = cleanServerName(vlessNode || '');
    if (vlessPing !== undefined) {
      trayVlessPing = vlessPing;
    } else if (!trayVlessRunning) {
      trayVlessPing = null;
    }
  } else if (vless) {
    try {
      const vs = await vless.getStatus();
      trayVlessRunning = Boolean(vs?.running);
      trayVlessNodeName = cleanServerName(vs?.activeServer?.name || '');
      trayVlessPing = vs?.activeServer?.ping || null;
    } catch {}
  }

  const tipParts = [];
  if (trayZapretRunning) tipParts.push('Обход: вкл');
  if (trayVlessRunning) {
    const pingStr = trayVlessPing ? ` (${trayVlessPing} мс)` : '';
    tipParts.push(`VPN: ${trayVlessNodeName || 'вкл'}${pingStr}`);
  }
  if (trayTgRunning) tipParts.push('TG: вкл');

  tray.setToolTip(
    tipParts.length > 0
      ? `Zapret Prime — ${tipParts.join(' | ')}`
      : 'Zapret Prime — все службы выключены'
  );

  const vpnMenuLabel = trayVlessRunning
    ? `● VPN: ${trayVlessNodeName || 'подключён'}${trayVlessPing ? ` (${trayVlessPing} мс)` : ''}`
    : '○ VPN: выключен';

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
            if (trayVlessRunning && vless) {
              await vless.disconnect();
              trayVlessRunning = false;
              trayVlessPing = null;
              const vStatus = await vless.getStatus();
              mainWindow?.webContents.send('vless-status-changed', vStatus);
            }
            const status = await zapret.start(zapret.config.lastStrategy || 'general.bat');
            if (status.running) {
              sendInAppNotify('Включение обхода');
            }
          }
          const status = await zapret.getStatus();
          bypassWasRunning = status.running;
          mainWindow?.webContents.send('status-changed', status);
          updateTrayMenu(status.running, trayTgRunning, trayVlessRunning, trayVlessNodeName, trayVlessPing);
        } catch (err) {
          mainWindow?.webContents.send('error', err.message);
        }
      }
    },
    { type: 'separator' },
    {
      label: vpnMenuLabel,
      enabled: false
    },
    {
      label: trayVlessRunning ? 'Отключить VPN' : 'Подключить VPN',
      click: async () => {
        if (!vless) return;
        try {
          if (trayVlessRunning) {
            const vStatus = await vless.disconnect();
            trayVlessRunning = false;
            trayVlessPing = null;
            mainWindow?.webContents.send('vless-status-changed', vStatus);
            sendInAppNotify('VPN отключён');
          } else {
            if (trayZapretRunning && zapret) {
              lastIntentionalBypassStop = Date.now();
              bypassWasRunning = false;
              await zapret.stop();
              trayZapretRunning = false;
              const zStatus = await zapret.getStatus();
              mainWindow?.webContents.send('status-changed', zStatus);
            }
            const vStatus = await vless.connect(0);
            trayVlessRunning = Boolean(vStatus.running);
            trayVlessNodeName = vStatus.activeServer?.name || '';
            trayVlessPing = vStatus.activeServer?.ping || null;
            mainWindow?.webContents.send('vless-status-changed', vStatus);
            if (vStatus.running) {
              sendInAppNotify(`VPN подключён: ${trayVlessNodeName || 'узел'}`);
            }
          }
          updateTrayMenu(trayZapretRunning, trayTgRunning, trayVlessRunning, trayVlessNodeName, trayVlessPing);
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
            updateTrayMenu(trayZapretRunning, status.running, trayVlessRunning, trayVlessNodeName);
          } else {
            const status = await tgProxy.start();
            mainWindow?.webContents.send('tg-proxy-changed', status);
            if (status.running) {
              sendInAppNotify('TG Proxy включён');
            }
            updateTrayMenu(trayZapretRunning, status.running, trayVlessRunning, trayVlessNodeName);
          }
        } catch (err) {
          mainWindow?.webContents.send('error', err.message);
        }
      }
    },
    { type: 'separator' },
    {
      label: 'Открыть окно Zapret Prime',
      click: () => {
        showMainWindow();
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
      if (
        bypassWasRunning &&
        !status.running &&
        !app.isQuitting &&
        sinceIntentional > 4000 &&
        !isBypassDropSuppressed()
      ) {
        notifyBypassDropped(status);
      }
      if (!isBypassDropSuppressed()) {
        bypassWasRunning = status.running;
      }
      mainWindow.webContents.send('status-changed', status);
      updateTrayMenu(status.running, trayTgRunning, trayVlessRunning, trayVlessNodeName);
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
      updateTrayMenu(trayZapretRunning, status.running, trayVlessRunning, trayVlessNodeName);
    } catch { /* ignore */ }
  }, 3000);
}

async function runSchtasks(args) {
  if (process.platform !== 'win32') return;
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('schtasks', args, { windowsHide: true });
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`schtasks exit ${code}`)));
      child.on('error', reject);
    });
  } catch (err) {
    logStartup(`schtasks failed (${Array.isArray(args) ? args.join(' ') : args}): ${err.message}`);
  }
}

async function syncAutostartTask() {
  if (process.platform !== 'win32' || !zapret) return;

  const enabled = zapret.isAppAutostartEnabled();
  const current = app.getLoginItemSettings();
  if (current.openAtLogin) {
    app.setLoginItemSettings({ openAtLogin: false, args: [] });
  }

  const exePath = process.execPath;
  const taskAction = `"${exePath}" --autostart`;
  const regKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
  const regValName = 'Zapret Prime';
  const legacyRegValName = 'Zapret HUB';

  if (!enabled) {
    try {
      if (zapret.isElevated()) {
        await runSchtasks(['/Delete', '/TN', AUTOSTART_TASK_NAME, '/F']);
        await runSchtasks(['/Delete', '/TN', 'Zapret HUB', '/F']).catch(() => {});
      } else {
        await zapret.runElevated('schtasks', ['/Delete', '/TN', AUTOSTART_TASK_NAME, '/F']).catch(() => {});
        await zapret.runElevated('schtasks', ['/Delete', '/TN', 'Zapret HUB', '/F']).catch(() => {});
      }
    } catch {}
    try {
      await execAsync(`reg delete "${regKey}" /v "${regValName}" /f`, { windowsHide: true });
      await execAsync(`reg delete "${regKey}" /v "${legacyRegValName}" /f`, { windowsHide: true });
    } catch {}
    return;
  }

  // Clean legacy autostart entry if exists
  try {
    await execAsync(`reg delete "${regKey}" /v "${legacyRegValName}" /f`, { windowsHide: true });
    await runSchtasks(['/Delete', '/TN', 'Zapret HUB', '/F']).catch(() => {});
  } catch {}

  // 1. Try creating Task Scheduler task with highest privileges (via runElevated)
  let taskSuccess = false;
  try {
    if (zapret.isElevated()) {
      await runSchtasks([
        '/Create', '/F', '/SC', 'ONLOGON', '/RL', 'HIGHEST',
        '/TN', AUTOSTART_TASK_NAME,
        '/TR', taskAction
      ]);
      taskSuccess = true;
    } else {
      await zapret.runElevated('schtasks', [
        '/Create', '/F', '/SC', 'ONLOGON', '/RL', 'HIGHEST',
        '/TN', AUTOSTART_TASK_NAME,
        '/TR', taskAction
      ]);
      taskSuccess = true;
    }
    logStartup(`Autostart task created in Task Scheduler: ${taskAction}`);
  } catch (err) {
    logStartup(`Elevated schtasks creation failed, falling back to HKCU Run: ${err.message}`);
  }

  // 2. Add HKCU Run registry entry as an instant, non-privileged, 100% reliable fallback
  try {
    await new Promise((resolve, reject) => {
      const child = spawn('reg.exe', ['add', regKey, '/v', regValName, '/t', 'REG_SZ', '/d', taskAction, '/f'], { windowsHide: true });
      child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`reg exit ${code}`)));
      child.on('error', reject);
    });
    logStartup(`Autostart registry entry added to HKCU Run: ${taskAction}`);
  } catch (regErr) {
    logStartup(`Autostart registry add failed: ${regErr.message}`);
  }
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
      markBypassRunning(true);
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

let autostartActionsRan = false;

async function runAutostartActions() {
  if (autostartActionsRan) return;
  autostartActionsRan = true;
  logStartup('Executing autostart actions in background...');
  await Promise.all([runAutostartZapret(), runAutostartTgProxy()]);
  try {
    const zStatus = await zapret?.getStatus();
    const tgStatus = await tgProxy?.getStatus();
    updateTrayMenu(Boolean(zStatus?.running), Boolean(tgStatus?.running));
  } catch {}
}

function parseHubTagFromUrl(url) {
  const match = String(url || '').match(/\/releases\/tag\/(v?[\d.]+[a-z]*)/i);
  return match?.[1] || null;
}

async function fetchHubReleasePageTag() {
  for (const pageUrl of [PRIME_RELEASE_PAGE, HUB_RELEASE_PAGE]) {
    try {
      const res = await fetchUrl(pageUrl, {
        headers: { 'User-Agent': 'Mozilla/5.0 ZapretPrime', Accept: 'text/html, */*' },
        timeoutMs: 4000,
        maxRedirects: 6
      });
      const html = res.body;
      const tagMatch = html.match(/\/releases\/tag\/(v?[\d.]+[a-z]*)/i);
      if (tagMatch?.[1]) return tagMatch[1];
      const titleMatch = html.match(/<title>Release .*?(v?[\d.]+[a-z]*)/i);
      if (titleMatch?.[1]) return titleMatch[1];
    } catch {}
  }
  return null;
}

async function resolveHubRemoteRelease() {
  // 1. Try official GitHub API (fast check, 3000ms timeout)
  for (const apiUrl of [PRIME_RELEASE_API, HUB_RELEASE_API]) {
    try {
      const rel = await fetchGithubRelease(apiUrl, { timeoutMs: 3000 });
      if (rel && rel.tag_name) return rel;
    } catch {}
  }

  // 2. Fallback to public GitHub Releases Atom feed (zero rate limits, fast, reliable)
  try {
    const list = await fetchGithubReleases('xRAYNERx/Zapret-PRIME', { timeoutMs: 4000 });
    if (Array.isArray(list) && list.length > 0) {
      const latest = list[0];
      const tag = latest.tag_name;
      const version = String(tag).replace(/^v/i, '');
      return {
        tag_name: tag.startsWith('v') ? tag : `v${tag}`,
        name: latest.name || `Zapret Prime v${version}`,
        body: latest.body || '',
        published_at: latest.published_at,
        html_url: `https://github.com/xRAYNERx/Zapret-PRIME/releases/tag/v${version}`,
        assets: [
          {
            name: `ZapretPrime-Patch-${version}.zip`,
            browser_download_url: `https://github.com/xRAYNERx/Zapret-PRIME/releases/download/v${version}/ZapretPrime-Patch-${version}.zip`
          },
          {
            name: `ZapretHub-Patch-${version}.zip`,
            browser_download_url: `https://github.com/xRAYNERx/Zapret-PRIME/releases/download/v${version}/ZapretHub-Patch-${version}.zip`
          },
          {
            name: `ZapretPrime-Setup-${version}.exe`,
            browser_download_url: `https://github.com/xRAYNERx/Zapret-PRIME/releases/download/v${version}/ZapretPrime-Setup-${version}.exe`
          },
          {
            name: `ZapretHub-Setup-${version}.exe`,
            browser_download_url: `https://github.com/xRAYNERx/Zapret-PRIME/releases/download/v${version}/ZapretHub-Setup-${version}.exe`
          },
          {
            name: `ZapretPrime-Portable-${version}.exe`,
            browser_download_url: `https://github.com/xRAYNERx/Zapret-PRIME/releases/download/v${version}/ZapretPrime-Portable-${version}.exe`
          },
          {
            name: `ZapretHub-Portable-${version}.exe`,
            browser_download_url: `https://github.com/xRAYNERx/Zapret-PRIME/releases/download/v${version}/ZapretHub-Portable-${version}.exe`
          }
        ],
        _source: 'atom-fallback'
      };
    }
  } catch {}

  // 3. Fallback to scraping release page
  const tag = await fetchHubReleasePageTag();
  if (!tag) throw new Error('Не удалось получить информацию о релизах с GitHub');
  const version = String(tag).replace(/^v/i, '');
  return {
    tag_name: tag.startsWith('v') ? tag : `v${tag}`,
    html_url: `https://github.com/xRAYNERx/Zapret-PRIME/releases/tag/v${version}`,
    assets: [
      {
        name: `ZapretPrime-Patch-${version}.zip`,
        browser_download_url: `https://github.com/xRAYNERx/Zapret-PRIME/releases/download/v${version}/ZapretPrime-Patch-${version}.zip`
      },
      {
        name: `ZapretHub-Patch-${version}.zip`,
        browser_download_url: `https://github.com/xRAYNERx/Zapret-PRIME/releases/download/v${version}/ZapretHub-Patch-${version}.zip`
      },
      {
        name: `ZapretPrime-Setup-${version}.exe`,
        browser_download_url: `https://github.com/xRAYNERx/Zapret-PRIME/releases/download/v${version}/ZapretPrime-Setup-${version}.exe`
      },
      {
        name: `ZapretHub-Setup-${version}.exe`,
        browser_download_url: `https://github.com/xRAYNERx/Zapret-PRIME/releases/download/v${version}/ZapretHub-Setup-${version}.exe`
      }
    ],
    _source: 'page-fallback'
  };
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
      label: 'Zapret Prime',
      local,
      remote,
      updateAvailable,
      releaseUrl: release.html_url || PRIME_RELEASE_PAGE
    };
  } catch (e) {
    return {
      product: 'hub',
      label: 'Zapret Prime',
      local,
      remote: null,
      updateAvailable: false,
      releaseUrl: PRIME_RELEASE_PAGE,
      error: e.message
    };
  }
}

function resolveHubAssets(release) {
  const assets = release?.assets || [];
  const patch = assets.find((a) => /^Zapret(Prime|Hub)-Patch-/i.test(a.name) && /\.zip$/i.test(a.name));
  const setup = assets.find((a) => /^Zapret(Prime|Hub)-Setup-/i.test(a.name) && /\.exe$/i.test(a.name));
  const portable = assets.find((a) => /^Zapret(Prime|Hub)-Portable-/i.test(a.name) && /\.exe$/i.test(a.name));
  return {
    patch: patch?.browser_download_url ? { url: patch.browser_download_url, name: patch.name } : null,
    installer: (setup || portable)?.browser_download_url ? { url: (setup || portable).browser_download_url, name: (setup || portable).name } : null
  };
}

function resolveHubInstallerAsset(release) {
  const { installer } = resolveHubAssets(release);
  return installer;
}

function downloadHubFile(url, destPath, onProgress) {
  let lastReportedPercent = -1;
  return downloadFile(url, destPath, {
    maxRedirects: 6,
    onProgress: ({ percent, downloaded, total }) => {
      const safePercent = Math.min(100, Math.max(0, percent));
      if (safePercent === lastReportedPercent) return;
      lastReportedPercent = safePercent;
      if (typeof onProgress === 'function') {
        const mbDownloaded = (downloaded / (1024 * 1024)).toFixed(1);
        const mbTotal = total > 0 ? (total / (1024 * 1024)).toFixed(1) : '?';
        onProgress({
          percent: safePercent,
          downloaded,
          total,
          message: `Скачивание Zapret Prime… ${safePercent}% (${mbDownloaded} из ${mbTotal} МБ)`
        });
      }
    }
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

async function applyHubPatch(patchZipPath, onProgress) {
  if (typeof onProgress === 'function') {
    onProgress({ percent: 90, message: 'Распаковка быстрого обновления…' });
  }

  const updatesDir = path.dirname(patchZipPath);
  const extractedDir = path.join(updatesDir, 'patch_extracted');
  fs.rmSync(extractedDir, { recursive: true, force: true });
  fs.mkdirSync(extractedDir, { recursive: true });

  await execAsync(`tar.exe -xf "${patchZipPath}" -C "${extractedDir}"`, { windowsHide: true });

  if (typeof onProgress === 'function') {
    onProgress({ percent: 100, message: 'Применение обновления и перезапуск…' });
  }

  await stopServicesBeforeHubInstall();
  logStartup(`Applying fast patch from ${extractedDir} to ${process.resourcesPath}`);

  const batPath = path.join(updatesDir, 'apply_patch.bat');
  const batScript = `@echo off
setlocal
set "TARGET_DIR=%~1"
set "SOURCE_DIR=%~2"
set "APP_EXE=%~3"

timeout /t 1 /nobreak >nul
taskkill /F /IM "Zapret Prime.exe" >nul 2>&1
taskkill /F /IM "Zapret HUB.exe" >nul 2>&1
timeout /t 1 /nobreak >nul

xcopy /E /Y /I "%SOURCE_DIR%\\*" "%TARGET_DIR%\\" >nul 2>&1

if exist "%APP_EXE%" (
  start "" "%APP_EXE%"
)
exit
`;
  fs.writeFileSync(batPath, batScript, 'utf8');

  try {
    const child = spawn('cmd.exe', ['/c', batPath, process.resourcesPath, extractedDir, process.execPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true
    });
    child.unref();
  } catch (err) {
    logStartup(`Spawn patch script failed: ${err.message}`);
    throw err;
  }

  app.isQuitting = true;
  setTimeout(() => app.quit(), 500);
}

async function launchHubInstaller(installerPath, onProgress) {
  if (typeof onProgress === 'function') {
    onProgress({ percent: 100, message: 'Запуск обновления…' });
  }

  await stopServicesBeforeHubInstall();
  logStartup(`Hub update: launching ${installerPath}`);

  const installDir = getHubInstallDir();
  const args = ['/S', '--updated', '--force-run'];
  if (app.isPackaged && installDir) {
    args.push(`/D=${installDir}`);
  }

  try {
    const child = spawn(installerPath, args, { detached: true, stdio: 'ignore' });
    child.unref();
  } catch (err) {
    logStartup(`Spawn silent update failed: ${err.message}, fallback to openPath`);
    try {
      await shell.openPath(installerPath);
    } catch (e) {
      logStartup(`OpenPath fallback failed: ${e.message}`);
    }
  }

  app.isQuitting = true;
  setTimeout(() => app.quit(), 1000);
}

async function applyHubUpdate(onProgress) {
  const release = await resolveHubRemoteRelease();
  const { patch, installer } = resolveHubAssets(release);

  const updatesDir = path.join(app.getPath('userData'), 'updates', 'hub');
  fs.mkdirSync(updatesDir, { recursive: true });

  // 1. Fast lightweight patch update (0.2 MB instead of 119 MB)
  if (app.isPackaged && patch && process.resourcesPath) {
    try {
      const isWritable = (() => {
        try {
          const testFile = path.join(process.resourcesPath, '.test_patch_write');
          fs.writeFileSync(testFile, '1');
          fs.unlinkSync(testFile);
          return true;
        } catch {
          return false;
        }
      })();

      if (isWritable) {
        logStartup(`Fast patch update selected: ${patch.name}`);
        const patchPath = path.join(updatesDir, patch.name);
        await downloadHubFile(patch.url, patchPath, onProgress);
        await applyHubPatch(patchPath, onProgress);
        return {
          local: appPkg.version,
          remote: (release.tag_name || '').replace(/^v/, ''),
          patchPath,
          quitting: true
        };
      }
    } catch (patchErr) {
      logStartup(`Fast patch failed, falling back to full installer: ${patchErr.message}`);
    }
  }

  // 2. Full installer fallback
  if (!installer) {
    throw new Error('Файлы обновления Zapret Prime не найдены в релизе на GitHub');
  }

  const destPath = path.join(updatesDir, installer.name);
  await downloadHubFile(installer.url, destPath, onProgress);

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
  try {
    const checkPromise = Promise.all([
      checkHubForUpdates(),
      zapret ? zapret.checkForUpdates(options) : Promise.resolve({ updateAvailable: false }),
      tgProxy ? tgProxy.checkForUpdates() : Promise.resolve({ updateAvailable: false })
    ]).then(([hub, zapretUpdate, tg]) => ({
      hub,
      zapret: { product: 'zapret', label: 'Движок обхода', ...zapretUpdate },
      tg: { product: 'tg', label: 'TG Proxy', ...tg }
    }));

    const timeoutPromise = new Promise((resolve) =>
      setTimeout(() => {
        resolve({
          hub: {
            product: 'hub',
            label: 'Zapret Prime',
            local: appPkg.version,
            remote: null,
            updateAvailable: false,
            releaseUrl: PRIME_RELEASE_PAGE,
            error: 'Превышен таймаут ответа GitHub'
          },
          zapret: { product: 'zapret', label: 'Движок обхода', updateAvailable: false },
          tg: { product: 'tg', label: 'TG Proxy', updateAvailable: false }
        });
      }, 7000)
    );

    return await Promise.race([checkPromise, timeoutPromise]);
  } catch (err) {
    return {
      hub: {
        product: 'hub',
        label: 'Zapret Prime',
        local: appPkg.version,
        remote: null,
        updateAvailable: false,
        releaseUrl: PRIME_RELEASE_PAGE,
        error: err.message
      },
      zapret: { product: 'zapret', label: 'Движок обхода', updateAvailable: false },
      tg: { product: 'tg', label: 'TG Proxy', updateAvailable: false }
    };
  }
}

function hasPendingUpdates(all) {
  return Boolean(all?.hub?.updateAvailable && !all?.hub?.error);
}

async function checkUpdatesOnStartup() {
  if (!zapret || zapret.config.autoCheckUpdates === false) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  try {
    zapret.removeLegacyUpdateFlag();
    const all = await checkAllUpdatesBundle();
    if (!hasPendingUpdates(all)) return;

    if (Notification && Notification.isSupported()) {
      try {
        const remoteTag = all?.hub?.remote ? `v${all.hub.remote}` : 'новая версия';
        const notif = new Notification({
          title: `Zapret Prime v${appPkg.version} — Доступно обновление`,
          body: `Найдена ${remoteTag} на GitHub. Нажмите, чтобы открыть и установить.`,
          icon: loadWindowIcon()
        });
        notif.on('click', () => {
          showMainWindow();
          mainWindow?.webContents.send('startup-updates-available', all);
        });
        notif.show();
      } catch (notifErr) {
        logStartup(`Notification failed: ${notifErr.message}`);
      }
    }

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
  try {
    if (vless) {
      await vless.disconnect();
      await vless.setSystemProxy(false);
    }
  } catch (err) {
    logStartup(`Quit vless stop failed: ${err.message}`);
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
    'window-get-position': () => {
      if (!mainWindow || mainWindow.isDestroyed()) return [0, 0];
      return mainWindow.getPosition();
    },
    'window-set-position': (_, x, y) => {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      mainWindow.setPosition(Math.round(x), Math.round(y));
      return true;
    },
    'get-status': () => zapret.getStatus(),
    'get-strategies': () => zapret.getStrategies(),
    'start': async (_, strategy) => {
      suppressBypassDrop(BYPASS_RESTART_SUPPRESS_MS);
      bypassWasRunning = false;
      const status = await zapret.start(strategy);
      markBypassRunning(status.running);
      if (status.running) {
        sendInAppNotify('Включение обхода');
      }
      return status;
    },
    'set-strategy': (_, strategy) => zapret.setLastStrategy(strategy),
    'restart': async (_, strategy) => {
      suppressBypassDrop(BYPASS_RESTART_SUPPRESS_MS);
      bypassWasRunning = false;
      const status = await zapret.restart(strategy);
      markBypassRunning(status.running);
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
    'get-exclude-sites': () => zapret.getExcludeSites(),
    'save-exclude-sites': async (_, sites) => {
      const res = zapret.saveExcludeSites(sites);
      if (vless) {
        vless.updateBypassRules().catch(() => {});
      }
      return res;
    },
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
        zapretPath: status.zapretPath,
        startMinimized: Boolean(status.startMinimized),
        closeBehavior: status.closeBehavior,
        autostartZapret: Boolean(status.autostartZapretEnabled),
        autostartTgProxy: Boolean(status.autostartTgProxyEnabled),
        autoCheckUpdates: zapret.config.autoCheckUpdates !== false
      };
    },

    'set-game-filter': (_, mode) => zapret.setGameFilter(mode),
    'set-autostart-zapret': async (_, enabled) => {
      const status = await zapret.setAutostartZapret(enabled);
      await syncAutostartTask();
      return status;
    },
    'set-autostart-tg': async (_, enabled) => {
      const status = await zapret.setAutostartTgProxy(enabled);
      await syncAutostartTask();
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
    'get-github-releases': async () => {
      try {
        return await fetchGithubReleases();
      } catch (e) {
        return [];
      }
    },
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
      suppressBypassDrop(BYPASS_UPDATE_SUPPRESS_MS);
      bypassWasRunning = false;
      return zapret.applyUpdate(remoteVersion, sendProgress);
    },
    'run-strategy-probe': async (_, options) => {
      const sendProgress = (progress) => {
        mainWindow?.webContents.send('strategy-probe-progress', progress);
      };
      suppressBypassDrop(BYPASS_PROBE_SUPPRESS_MS);
      bypassWasRunning = false;
      try {
        return await zapret.runStrategyProbe(options || {}, sendProgress);
      } finally {
        const status = await zapret.getStatus();
        markBypassRunning(status.running);
      }
    },
    'cancel-strategy-probe': () => zapret.cancelStrategyProbe(),
    'open-external': (_, url) => {
      const allowed = ['https:', 'http:', 'tg:'];
      let parsed;
      try { parsed = new URL(url); } catch { return false; }
      if (!allowed.includes(parsed.protocol)) return false;
      return shell.openExternal(url);
    },
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
    'copy-tg-proxy-link': () => tgProxy.copyProxyLink(clipboard),
    'open-tg-proxy-settings': () => tgProxy.openSettings(shell),
    'vless-get-status': () => vless.getStatus(),
    'vless-update-subscription': (_, url, resetPings = true) => vless.updateSubscription(url, resetPings),
    'vless-test-server': (_, idx) => vless.testSingleServer(idx),
    'vless-test-all': async () => {
      const sendProgress = (progress) => {
        mainWindow?.webContents.send('vless-test-progress', progress);
      };
      return vless.testAllServers(sendProgress);
    },
    'vless-connect': async (_, idx) => {
      const res = await vless.connect(idx);
      updateTrayMenu(trayZapretRunning, trayTgRunning, Boolean(res.running), res.activeServer?.name, res.activeServer?.ping || null);
      return res;
    },
    'vless-disconnect': async () => {
      const res = await vless.disconnect();
      updateTrayMenu(trayZapretRunning, trayTgRunning, false, '', null);
      return res;
    },
    'vless-toggle-system-proxy': (_, enabled) => vless.toggleSystemProxy(enabled),
    'vless-set-auto-fallback': (_, enabled) => vless.setAutoFallback(enabled),
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
        : (options.type === 'exclude' || options.isExclude
          ? zapret.exportExcludeSitesText()
          : zapret.exportGeneralSitesText());
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
        : (options.type === 'exclude' || options.isExclude
          ? zapret.importExcludeSites(text, mode)
          : zapret.importGeneralSites(text, mode));
      return { imported: true, filePath: filePaths[0], sites, mode };
    },
    'import-sites-text': (_, payload = {}) => {
      const mode = payload.mode === 'replace' ? 'replace' : 'merge';
      const sites = payload.listId
        ? zapret.importCustomListSites(payload.listId, payload.text, mode)
        : (payload.type === 'exclude' || payload.isExclude
          ? zapret.importExcludeSites(payload.text, mode)
          : zapret.importGeneralSites(payload.text, mode));
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
  sendInAppNotify('Zapret Prime уже запущен — окно восстановлено');
});

app.whenReady().then(async () => {
  try {
    logStartup('App ready');
    const userDataPath = app.getPath('userData');
    logStartup(`userDataPath: ${userDataPath}`);
    logStartup('Initializing ZapretService...');
    zapret = new ZapretService(app.getAppPath(), {
      configPath: getConfigPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      userDataPath
    });
    logStartup('Initializing TgProxyService...');
    tgProxy = new TgProxyService(userDataPath, {
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath
    });
    logStartup('Initializing VlessService...');
    vless = new VlessService(userDataPath, {
      appPath: app.getAppPath(),
      isPackaged: app.isPackaged,
      resourcesPath: process.resourcesPath,
      zapretService: zapret
    });
    vless.cleanupStaleProxy().catch(() => {});
    vless.onPingUpdate = ({ index, ping, serverName, blocked, disconnected }) => {
      if (disconnected) {
        updateTrayMenu(trayZapretRunning, trayTgRunning, false, '', null);
      } else {
        updateTrayMenu(trayZapretRunning, trayTgRunning, !blocked, serverName, ping);
      }
      mainWindow?.webContents.send('vless-ping-update', { index, ping, serverName, blocked, disconnected });
    };
    logStartup('Migrating autostart...');
    zapret.migrateAutostartConfig()
      .then(() => syncAutostartTask())
      .catch((err) => logStartup(`Autostart migrate failed: ${err.message}`));
    logStartup('Preparing startup...');
    await zapret.prepareStartup();
    logStartup('Getting initial status...');
    const initialStatus = await zapret.getStatus();
    bypassWasRunning = initialStatus.running;
    logStartup('Creating window...');
    createWindow();
    logStartup('Creating tray...');
    createTray();
    logStartup('Registering IPC...');
    registerIpc();
    startStatusPolling();
    startTgProxyPolling();
    if (tgProxy) {
      tgProxy.getStatus()
        .then((tgStatus) => updateTrayMenu(initialStatus.running, tgStatus.running))
        .catch(() => updateTrayMenu(initialStatus.running, false));
    }
    if (isAutostartLaunch || zapret?.isAppAutostartEnabled()) {
      logStartup('Scheduling autostart actions in background...');
      setTimeout(() => {
        runAutostartActions().catch((err) => logStartup(`Autostart actions error: ${err.message}`));
      }, 500);
    }
  } catch (err) {
    logStartup(`Startup error: ${err.message}\n${err.stack}`);
    showFatalErrorWindow('Ошибка запуска', 'Не удалось запустить Zapret Prime.', err.message);
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

// Keep the process alive when all windows are closed — app runs in the system tray.
app.on('window-all-closed', () => { /* noop */ });