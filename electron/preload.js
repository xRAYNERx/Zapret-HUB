const { contextBridge, ipcRenderer } = require('electron');

const api = {
  getStatus: () => ipcRenderer.invoke('get-status'),
  getStrategies: () => ipcRenderer.invoke('get-strategies'),
  start: (strategy) => ipcRenderer.invoke('start', strategy),
  setStrategy: (strategy) => ipcRenderer.invoke('set-strategy', strategy),
  restart: (strategy) => ipcRenderer.invoke('restart', strategy),
  stop: () => ipcRenderer.invoke('stop'),
  getSites: () => ipcRenderer.invoke('get-sites'),
  saveSites: (sites) => ipcRenderer.invoke('save-sites', sites),
  getCustomLists: () => ipcRenderer.invoke('get-custom-lists'),
  createCustomList: (name) => ipcRenderer.invoke('create-custom-list', name),
  getCustomListSites: (listId) => ipcRenderer.invoke('get-custom-list-sites', listId),
  saveCustomListSites: (listId, sites) => ipcRenderer.invoke('save-custom-list-sites', listId, sites),
  setActiveCustomList: (listId) => ipcRenderer.invoke('set-active-custom-list', listId),
  deleteCustomList: (listId) => ipcRenderer.invoke('delete-custom-list', listId),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setGameFilter: (mode) => ipcRenderer.invoke('set-game-filter', mode),
  setAutostartZapret: (enabled) => ipcRenderer.invoke('set-autostart-zapret', enabled),
  setAutostartTg: (enabled) => ipcRenderer.invoke('set-autostart-tg', enabled),
  setStartMinimized: (enabled) => ipcRenderer.invoke('set-start-minimized', enabled),
  setIpset: (mode) => ipcRenderer.invoke('set-ipset', mode),
  setAutoUpdate: (enabled) => ipcRenderer.invoke('set-auto-update', enabled),
  setZapretPath: (path) => ipcRenderer.invoke('set-zapret-path', path),
  browseZapretPath: () => ipcRenderer.invoke('browse-zapret-path'),
  validatePath: () => ipcRenderer.invoke('validate-path'),
  runDiagnostics: () => ipcRenderer.invoke('run-diagnostics'),
  checkUpdates: (options) => ipcRenderer.invoke('check-updates', options),
  checkAllUpdates: (options) => ipcRenderer.invoke('check-all-updates', options),
  applyUpdate: (remoteVersion) => ipcRenderer.invoke('apply-update', remoteVersion),
  applyHubUpdate: () => ipcRenderer.invoke('apply-hub-update'),
  runTests: () => ipcRenderer.invoke('run-tests'),
  runStrategyProbe: (options) => ipcRenderer.invoke('run-strategy-probe', options),
  cancelStrategyProbe: () => ipcRenderer.invoke('cancel-strategy-probe'),
  onStrategyProbeProgress: (cb) => {
    ipcRenderer.on('strategy-probe-progress', (_, data) => cb(data));
  },
  openExternal: (url) => ipcRenderer.invoke('open-external', url),
  getConfig: () => ipcRenderer.invoke('get-config'),
  onStatusChanged: (cb) => {
    ipcRenderer.on('status-changed', (_, data) => cb(data));
  },
  onError: (cb) => {
    ipcRenderer.on('error', (_, msg) => cb(msg));
  },
  onNotify: (cb) => {
    ipcRenderer.on('notify', (_, msg) => cb(msg));
  },
  onUpdateProgress: (cb) => {
    ipcRenderer.on('update-progress', (_, data) => cb(data));
  },
  getTgProxyStatus: () => ipcRenderer.invoke('get-tg-proxy-status'),
  startTgProxy: () => ipcRenderer.invoke('start-tg-proxy'),
  stopTgProxy: () => ipcRenderer.invoke('stop-tg-proxy'),
  checkTgProxyUpdates: () => ipcRenderer.invoke('check-tg-proxy-updates'),
  applyTgProxyUpdate: () => ipcRenderer.invoke('apply-tg-proxy-update'),
  openTgProxyTelegram: () => ipcRenderer.invoke('open-tg-proxy-telegram'),
  copyTgProxyLink: () => ipcRenderer.invoke('copy-tg-proxy-link'),
  openTgProxySettings: () => ipcRenderer.invoke('open-tg-proxy-settings'),
  relaunchApp: () => ipcRenderer.invoke('relaunch-app'),
  windowMinimize: () => ipcRenderer.invoke('window-minimize'),
  windowClose: () => ipcRenderer.invoke('window-close'),
  windowCloseChoice: (choice) => ipcRenderer.invoke('window-close-choice', choice),
  onShowCloseDialog: (cb) => {
    ipcRenderer.on('show-close-dialog', () => cb());
  },
  onStartupUpdatesAvailable: (cb) => {
    ipcRenderer.on('startup-updates-available', (_, data) => cb(data));
  },
  onHubUpdateProgress: (cb) => {
    ipcRenderer.on('hub-update-progress', (_, data) => cb(data));
  },
  onTgProxyChanged: (cb) => {
    ipcRenderer.on('tg-proxy-changed', (_, data) => cb(data));
  },
  onTgProxyProgress: (cb) => {
    ipcRenderer.on('tg-proxy-progress', (_, data) => cb(data));
  },
  setCloseBehavior: (mode) => ipcRenderer.invoke('set-close-behavior', mode),
  setOnboardingCompleted: (completed) => ipcRenderer.invoke('set-onboarding-completed', completed),
  readClipboardText: () => ipcRenderer.invoke('read-clipboard-text'),
  exportSitesDialog: (options) => ipcRenderer.invoke('export-sites-dialog', options),
  importSitesDialog: (options) => ipcRenderer.invoke('import-sites-dialog', options),
  importSitesText: (payload) => ipcRenderer.invoke('import-sites-text', payload),
  onBypassDropped: (cb) => {
    ipcRenderer.on('bypass-dropped', (_, data) => cb(data));
  },
  onBypassHealthFailed: (cb) => {
    ipcRenderer.on('bypass-health-failed', (_, data) => cb(data));
  },
  runBypassHealthCheck: () => ipcRenderer.invoke('run-bypass-health-check')
};

contextBridge.exposeInMainWorld('zapretAPI', api);