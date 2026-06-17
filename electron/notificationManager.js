const { BrowserWindow, screen } = require('electron');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');

const NOTIFICATION_WIDTH = 380;
const NOTIFICATION_HEIGHT = 88;
const MARGIN = 16;
const GAP = 10;
const DISPLAY_MS = 4500;

/** @type {BrowserWindow[]} */
let activeNotifications = [];

function playNotificationSound() {
  if (process.platform !== 'win32') return;
  const soundPath = path.join(
    process.env.WINDIR || 'C:\\Windows',
    'Media',
    'Windows Notify System Generic.wav'
  );
  if (!fs.existsSync(soundPath)) return;
  try {
    const escaped = soundPath.replace(/'/g, "''");
    spawn(
      'powershell',
      [
        '-NoProfile',
        '-WindowStyle',
        'Hidden',
        '-Command',
        `(New-Object System.Media.SoundPlayer '${escaped}').Play()`
      ],
      { detached: true, windowsHide: true }
    ).unref();
  } catch {
    // ignore sound errors
  }
}

function getStackPosition(index, workArea) {
  const x = workArea.x + workArea.width - NOTIFICATION_WIDTH - MARGIN;
  const y =
    workArea.y +
    MARGIN +
    index * (NOTIFICATION_HEIGHT + GAP);
  return { x, y };
}

function repositionNotifications() {
  const { workArea } = screen.getPrimaryDisplay();
  activeNotifications.forEach((win, index) => {
    if (win.isDestroyed()) return;
    const { x, y } = getStackPosition(index, workArea);
    win.setPosition(x, y, false);
  });
}

function closeNotification(win) {
  const idx = activeNotifications.indexOf(win);
  if (idx >= 0) activeNotifications.splice(idx, 1);
  if (!win.isDestroyed()) win.close();
  repositionNotifications();
}

/**
 * @param {{ title: string, message: string, resolveAppFile: (...segments: string[]) => string, iconPath?: string }} opts
 */
function showAppNotification({ title, message, resolveAppFile, iconPath }) {
  if (process.platform !== 'win32') return;

  playNotificationSound();

  const { workArea } = screen.getPrimaryDisplay();
  const index = activeNotifications.length;
  const { x, y } = getStackPosition(index, workArea);

  const win = new BrowserWindow({
    width: NOTIFICATION_WIDTH,
    height: NOTIFICATION_HEIGHT,
    x,
    y,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    resizable: false,
    focusable: false,
    show: false,
    hasShadow: true,
    thickFrame: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true
    }
  });

  win.setAlwaysOnTop(true, 'screen-saver');
  activeNotifications.push(win);

  const htmlPath = resolveAppFile('src', 'notification.html');
  const safeTitle = title || 'Zapret HUB';
  const safeMessage = message || '';
  const safeIcon = iconPath || '';

  win.loadFile(htmlPath).then(() => {
    if (win.isDestroyed()) return;
    const script = `
      (function () {
        const title = ${JSON.stringify(safeTitle)};
        const message = ${JSON.stringify(safeMessage)};
        const iconPath = ${JSON.stringify(safeIcon)};
        document.getElementById('notifyTitle').textContent = title;
        const messageEl = document.getElementById('notifyMessage');
        messageEl.textContent = message;
        messageEl.hidden = !message;
        if (iconPath) {
          const wrap = document.getElementById('notifyIconWrap');
          const img = document.createElement('img');
          img.className = 'notify-icon';
          img.alt = '';
          img.src = 'file:///' + iconPath.replace(/\\\\/g, '/');
          img.onload = () => { wrap.replaceWith(img); };
        }
      })();
    `;
    return win.webContents.executeJavaScript(script);
  }).then(() => {
    if (!win.isDestroyed()) win.showInactive();
  }).catch(() => {
    closeNotification(win);
  });

  win.on('closed', () => {
    const idx = activeNotifications.indexOf(win);
    if (idx >= 0) activeNotifications.splice(idx, 1);
    repositionNotifications();
  });

  setTimeout(() => closeNotification(win), DISPLAY_MS);
}

module.exports = { showAppNotification };