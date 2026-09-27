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
const { fetchUrl, fetchGithubRelease, downloadFile } = require('./helpers/httpFetch');
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
const AUTOSTART_TASK_NAME = 'Zapret HUB';
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
    title: 'Zapret HUB',
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
    title: 'Zapret HUB',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
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
      'Закройте все копии Zapret HUB в диспетчере задач и запустите снова из папки установки.',
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
    if (isAutostartLaunch) {
      setTimeout(() => runAutostartActions(), 1500);
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
  tray.setToolTip('Zapret HUB');

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

let trayVlessRunning = false;
let trayVlessNodeName = '';

async function updateTrayMenu(zapretRunning, tgRunning, vlessRunning, vlessNode) {
  if (!tray) return;

  if (typeof zapretRunning === 'boolean') trayZapretRunning = zapretRunning;
  if (typeof tgRunning === 'boolean') trayTgRunning = tgRunning;
  if (typeof vlessRunning === 'boolean') {
    trayVlessRunning = vlessRunning;
    trayVlessNodeName = vlessNode || '';
  } else if (vless) {
    try {
      const vs = await vless.getStatus();
      trayVlessRunning = Boolean(vs?.running);
      trayVlessNodeName = vs?.activeServer?.name || '';
    } catch {}
  }

  const tipParts = [];
  if (trayZapretRunning) tipParts.push('Обход: вкл');
  if (trayVlessRunning) tipParts.push(`VPN: ${trayVlessNodeName || 'вкл'}`);
  if (trayTgRunning) tipParts.push('TG: вкл');

  tray.setToolTip(
    tipParts.length > 0
      ? `Zapret HUB — ${tipParts.join(' | ')}`
      : 'Zapret HUB — все службы выключены'
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
            if (trayVlessRunning && vless) {
              await vless.disconnect();
              trayVlessRunning = false;
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
          updateTrayMenu(status.running, trayTgRunning, trayVlessRunning, trayVlessNodeName);
        } catch (err) {
          mainWindow?.webContents.send('error', err.message);
        }
      }
    },
    { type: 'separator' },
    {
      label: trayVlessRunning ? `● VPN: ${trayVlessNodeName || 'подключён'}` : '○ VPN: выключен',
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
            mainWindow?.webContents.send('vless-status-changed', vStatus);
            if (vStatus.running) {
              sendInAppNotify(`VPN подключён: ${trayVlessNodeName || 'узел'}`);
            }
          }
          updateTrayMenu(trayZapretRunning, trayTgRunning, trayVlessRunning, trayVlessNodeName);
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
      label: 'Открыть окно Zapret HUB',
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

  // Clean up any stale registry run entries from previous versions
  const staleKeys = ['electron.app.Electron', 'electron.app.Zapret HUB', 'TgWsProxy'];
  for (const k of staleKeys) {
    try {
      await execAsync(`reg delete "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run" /v "${k}" /f`, { windowsHide: true });
    } catch {}
  }

  if (!enabled) {
    await runSchtasks(['/Delete', '/TN', AUTOSTART_TASK_NAME, '/F']);
    return;
  }

  const exePath = process.execPath;
  const taskAction = `"${exePath}" --autostart`;
  await runSchtasks([
    '/Create', '/F', '/SC', 'ONLOGON', '/RL', 'HIGHEST',
    '/TN', AUTOSTART_TASK_NAME,
    '/TR', taskAction
  ]);
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

async function runAutostartActions() {
  await Promise.all([runAutostartZapret(), runAutostartTgProxy()]);
}

function parseHubTagFromUrl(url) {
  const match = String(url || '').match(/\/releases\/tag\/(v?[\d.]+[a-z]*)/i);
  return match?.[1] || null;
}

async function fetchHubReleasePageTag() {
  try {
    const res = await fetchUrl(HUB_RELEASE_PAGE, {
      headers: { 'User-Agent': 'ZapretHub', Accept: 'text/html, */*' },
      maxRedirects: 6
    });
    const html = res.body;
    const canonical = html.match(/<link[^>]+rel="canonical"[^>]+href="[^"]*\/releases\/tag\/([^"]+)"/i);
    const embedded = html.match(/"tag_name"\s*:\s*"(v?[\d.]+[a-z]*)"/i);
    return canonical?.[1] || embedded?.[1] || null;
  } catch {
    return null;
  }
}

async function resolveHubRemoteRelease() {
  try {
    return await fetchGithubRelease(HUB_RELEASE_API);
  } catch (apiError) {
    const tag = await fetchHubReleasePageTag();
    if (!tag) throw apiError;
    const version = String(tag).replace(/^v/i, '');
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
  let lastReportedPercent = -1;
  return downloadFile(url, destPath, {
    maxRedirects: 6,
    onProgress: ({ percent }) => {
      const safePercent = Math.min(100, Math.max(0, percent));
      if (safePercent === lastReportedPercent) return;
      lastReportedPercent = safePercent;
      if (typeof onProgress === 'function') {
        onProgress({ percent: safePercent, message: `Скачивание Zapret HUB… ${safePercent}%` });
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

    if (Notification && Notification.isSupported()) {
      try {
        const notif = new Notification({
          title: 'Zapret HUB v2.0 — Доступно обновление',
          body: 'Найдена новая версия на GitHub. Нажмите, чтобы открыть и скачать.',
          icon: loadWindowIcon()
        });
        notif.on('click', () => {
          showMainWindow();
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
      updateTrayMenu(trayZapretRunning, trayTgRunning, Boolean(res.running), res.activeServer?.name);
      return res;
    },
    'vless-disconnect': async () => {
      const res = await vless.disconnect();
      updateTrayMenu(trayZapretRunning, trayTgRunning, false, '');
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
      resourcesPath: process.resourcesPath
    });
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
  } catch (err) {
    logStartup(`Startup error: ${err.message}\n${err.stack}`);
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

// Keep the process alive when all windows are closed — app runs in the system tray.
app.on('window-all-closed', () => { /* noop */ });