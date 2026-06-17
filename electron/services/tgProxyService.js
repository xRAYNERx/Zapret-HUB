const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const RELEASE_API = 'https://api.github.com/repos/Flowseal/tg-ws-proxy/releases/latest';
const RELEASE_PAGE = 'https://github.com/Flowseal/tg-ws-proxy/releases';
const WINDOWS_ASSET = 'TgWsProxy_windows.exe';
const EXE_NAME = 'TgWsProxy.exe';
const TG_CONFIG_DIR = path.join(process.env.APPDATA || '', 'TgWsProxy');
const TG_CONFIG_FILE = path.join(TG_CONFIG_DIR, 'config.json');

const DEFAULT_PROXY = {
  host: '127.0.0.1',
  port: 1443,
  secret: ''
};

class TgProxyService {
  constructor(userDataPath, options = {}) {
    this.userDataPath = userDataPath;
    this.appPath = options.appPath || '';
    this.isPackaged = Boolean(options.isPackaged);
    this.resourcesPath = options.resourcesPath || '';
    this.installDir = path.join(userDataPath, 'tg-proxy');
    this.exePath = path.join(this.installDir, EXE_NAME);
    this.versionPath = path.join(this.installDir, 'version.txt');
    this._child = null;
    this._seedFromBundled();
  }

  getBundledDir() {
    if (this.isPackaged && this.resourcesPath) {
      const packaged = path.join(this.resourcesPath, 'tg-proxy');
      if (fs.existsSync(path.join(packaged, EXE_NAME))) return packaged;
    }

    const bundled = path.join(this.appPath, 'bundled', 'tg-proxy');
    if (fs.existsSync(path.join(bundled, EXE_NAME))) return bundled;

    return null;
  }

  _seedFromBundled() {
    if (fs.existsSync(this.exePath)) return;

    const bundled = this.getBundledDir();
    if (!bundled) return;

    fs.mkdirSync(this.installDir, { recursive: true });
    fs.copyFileSync(path.join(bundled, EXE_NAME), this.exePath);

    const bundledVersion = path.join(bundled, 'version.txt');
    if (fs.existsSync(bundledVersion)) {
      fs.copyFileSync(bundledVersion, this.versionPath);
    }
  }

  getLocalVersion() {
    try {
      if (fs.existsSync(this.versionPath)) {
        return fs.readFileSync(this.versionPath, 'utf8').trim();
      }
    } catch {
      // ignore
    }
    return fs.existsSync(this.exePath) ? 'unknown' : null;
  }

  readTgConfig() {
    try {
      if (fs.existsSync(TG_CONFIG_FILE)) {
        return { ...DEFAULT_PROXY, ...JSON.parse(fs.readFileSync(TG_CONFIG_FILE, 'utf8')) };
      }
    } catch {
      // ignore
    }
    return { ...DEFAULT_PROXY };
  }

  buildProxyUrl(cfg = this.readTgConfig()) {
    const host = cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host;
    const secret = cfg.secret || '';
    return `tg://proxy?server=${host}&port=${cfg.port}&secret=dd${secret}`;
  }

  async fetchLatestRelease() {
    try {
      const release = await this.fetchLatestReleaseApi();
      if (release?.tag_name) return release;
    } catch {
      // API rate limit or network — fallback to releases/latest redirect
    }
    return this.fetchLatestReleaseViaPage();
  }

  fetchLatestReleaseApi() {
    return new Promise((resolve, reject) => {
      const request = https.get(
        RELEASE_API,
        { headers: { 'User-Agent': 'ZapretHub', Accept: 'application/vnd.github+json' } },
        (response) => {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
            https
              .get(response.headers.location, { headers: { 'User-Agent': 'ZapretHub' } }, (r) => {
                let data = '';
                r.on('data', (chunk) => { data += chunk; });
                r.on('end', () => {
                  try {
                    const json = JSON.parse(data);
                    if (!json.tag_name) {
                      reject(new Error(json.message || 'Некорректный ответ GitHub'));
                      return;
                    }
                    resolve(json);
                  } catch (e) {
                    reject(e);
                  }
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

  parseReleaseTagFromHtml(html) {
    const canonical = html.match(/<link[^>]+rel="canonical"[^>]+href="[^"]*\/releases\/tag\/(v[\d.]+)"/i);
    if (canonical?.[1]) return canonical[1];

    const og = html.match(/\/releases\/tag\/(v[\d.]+)/i);
    if (og?.[1]) return og[1];

    const embedded = html.match(/"tag_name"\s*:\s*"(v[\d.]+)"/i);
    if (embedded?.[1]) return embedded[1];

    return null;
  }

  buildReleaseFromTag(tag) {
    const normalized = String(tag || '').startsWith('v') ? tag : `v${tag}`;
    return {
      tag_name: normalized,
      html_url: `https://github.com/Flowseal/tg-ws-proxy/releases/tag/${normalized}`,
      assets: []
    };
  }

  fetchLatestReleaseViaPage() {
    return new Promise((resolve, reject) => {
      const follow = (url, depth = 0) => {
        const request = https.get(url, { headers: { 'User-Agent': 'ZapretHub' } }, (response) => {
          if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location && depth < 6) {
            const location = response.headers.location.startsWith('http')
              ? response.headers.location
              : `https://github.com${response.headers.location}`;
            const tagMatch = location.match(/\/tag\/(v[\d.]+)/i);
            response.resume();
            if (tagMatch) {
              resolve(this.buildReleaseFromTag(tagMatch[1]));
              return;
            }
            follow(location, depth + 1);
            return;
          }

          if (response.statusCode === 200) {
            let data = '';
            response.on('data', (chunk) => { data += chunk; });
            response.on('end', () => {
              const tag = this.parseReleaseTagFromHtml(data);
              if (tag) {
                resolve(this.buildReleaseFromTag(tag));
                return;
              }
              reject(new Error('Не удалось определить версию TG Proxy'));
            });
            return;
          }

          response.resume();
          reject(new Error('Не удалось определить версию TG Proxy'));
        });
        request.on('error', reject);
        request.setTimeout(20000, () => {
          request.destroy();
          reject(new Error('Таймаут запроса к GitHub'));
        });
      };

      follow(RELEASE_PAGE);
    });
  }

  resolveWindowsDownloadUrl(release) {
    const assets = release?.assets || [];
    const asset = assets.find((a) => a.name === WINDOWS_ASSET)
      || assets.find((a) => /^TgWsProxy[_-]?windows\.exe$/i.test(a.name));
    if (asset?.browser_download_url) return asset.browser_download_url;

    const tag = String(release?.tag_name || '').replace(/^v/i, '');
    if (tag) {
      return `https://github.com/Flowseal/tg-ws-proxy/releases/download/v${tag}/${WINDOWS_ASSET}`;
    }

    throw new Error(`Файл ${WINDOWS_ASSET} не найден в релизе`);
  }

  downloadFile(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
      let lastReportedPercent = -1;

      const reportProgress = (percent, phase) => {
        if (typeof onProgress !== 'function') return;
        const safePercent = Math.min(100, Math.max(0, percent));
        if (phase !== 'start' && phase !== 'done' && safePercent === lastReportedPercent) return;
        lastReportedPercent = safePercent;
        onProgress({
          percent: safePercent,
          message: phase === 'done'
            ? 'TG WS Proxy установлен'
            : `Скачивание TG WS Proxy… ${safePercent}%`
        });
      };

      const request = (targetUrl) => {
        const client = targetUrl.startsWith('https') ? https : http;
        client
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

            reportProgress(0, 'start');

            response.on('data', (chunk) => {
              downloaded += chunk.length;
              if (total > 0) {
                const percent = Math.round((downloaded / total) * 100);
                if (percent >= lastReportedPercent + 10 || percent === 100) {
                  reportProgress(percent);
                }
              }
            });

            response.pipe(file);
            file.on('finish', () => file.close(() => {
              reportProgress(100, 'done');
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

  async ensureBinary(onProgress) {
    if (fs.existsSync(this.exePath)) return this.exePath;

    fs.mkdirSync(this.installDir, { recursive: true });
    const release = await this.fetchLatestRelease();
    const url = this.resolveWindowsDownloadUrl(release);
    const tmpPath = `${this.exePath}.download`;

    await this.downloadFile(url, tmpPath, onProgress);
    fs.renameSync(tmpPath, this.exePath);

    const version = (release.tag_name || '').replace(/^v/, '');
    if (version) {
      fs.writeFileSync(this.versionPath, version, 'utf8');
    }

    return this.exePath;
  }

  async isProcessRunning() {
    try {
      const { stdout } = await execAsync(
        'tasklist /FO CSV /NH',
        { windowsHide: true, timeout: 8000 }
      );
      return stdout.toLowerCase().includes('tgwsproxy');
    } catch {
      return Boolean(this._child && !this._child.killed);
    }
  }

  async getStatus() {
    const installed = fs.existsSync(this.exePath);
    const running = await this.isProcessRunning();
    const cfg = this.readTgConfig();
    const local = this.getLocalVersion();

    let remote = null;
    let updateAvailable = false;
    try {
      const release = await this.fetchLatestRelease();
      remote = (release.tag_name || '').replace(/^v/, '');
      if (remote && installed) {
        updateAvailable = !local || local === 'unknown' || this.compareVersions(local, remote) < 0;
      }
    } catch {
      // ignore network errors in status poll
    }

    return {
      installed,
      running,
      local,
      remote,
      updateAvailable,
      host: cfg.host === '0.0.0.0' ? '127.0.0.1' : cfg.host,
      port: cfg.port,
      proxyUrl: this.buildProxyUrl(cfg),
      releaseUrl: RELEASE_PAGE
    };
  }

  compareVersions(a, b) {
    const pa = String(a).split('.').map((n) => parseInt(n, 10) || 0);
    const pb = String(b).split('.').map((n) => parseInt(n, 10) || 0);
    const len = Math.max(pa.length, pb.length);
    for (let i = 0; i < len; i++) {
      const diff = (pa[i] || 0) - (pb[i] || 0);
      if (diff !== 0) return diff;
    }
    return 0;
  }

  async checkForUpdates() {
    const local = this.getLocalVersion();
    try {
      const release = await this.fetchLatestRelease();
      const remote = (release.tag_name || '').replace(/^v/, '');
      const installed = fs.existsSync(this.exePath);
      const updateAvailable = this.isUpdateAvailable(local, remote, installed);
      return {
        local: local || 'не установлен',
        remote,
        updateAvailable,
        downloadUrl: this.resolveWindowsDownloadUrl(release),
        releaseUrl: release.html_url || RELEASE_PAGE
      };
    } catch (e) {
      return { local: local || 'не установлен', remote: null, updateAvailable: false, error: e.message };
    }
  }

  isUpdateAvailable(local, remote, installed = fs.existsSync(this.exePath)) {
    if (!remote) return false;
    if (!installed) return true;
    if (!local || local === 'unknown') return true;
    return this.compareVersions(local, remote) < 0;
  }

  async applyUpdate(onProgress) {
    const info = await this.checkForUpdates();
    const installed = fs.existsSync(this.exePath);
    if (!this.isUpdateAvailable(info.local === 'не установлен' ? null : info.local, info.remote, installed)) {
      return { local: this.getLocalVersion(), updated: false };
    }

    const wasRunning = await this.isProcessRunning();
    if (wasRunning) await this.stop();

    fs.mkdirSync(this.installDir, { recursive: true });
    const tmpPath = `${this.exePath}.download`;
    await this.downloadFile(info.downloadUrl, tmpPath, onProgress);

    if (fs.existsSync(this.exePath)) {
      try { fs.unlinkSync(this.exePath); } catch { /* file in use */ }
    }
    fs.renameSync(tmpPath, this.exePath);

    if (info.remote) {
      fs.writeFileSync(this.versionPath, info.remote, 'utf8');
    }

    return { local: info.remote, updated: true, wasRunning };
  }

  restoreUpdateCheckIfHubDisabled() {
    try {
      if (!fs.existsSync(TG_CONFIG_FILE)) return;

      const cfg = JSON.parse(fs.readFileSync(TG_CONFIG_FILE, 'utf8'));
      if (cfg.check_updates !== false) return;

      fs.writeFileSync(
        TG_CONFIG_FILE,
        JSON.stringify({ ...cfg, check_updates: true }, null, 2),
        'utf8'
      );
    } catch {
      // non-fatal
    }
  }

  hideTrayIconScriptPath() {
    return path.join(__dirname, '..', 'helpers', 'hide-tg-tray-icon.ps1');
  }

  async hideTrayIcon() {
    const scriptPath = this.hideTrayIconScriptPath();
    if (!fs.existsSync(scriptPath)) return;

    const exeArg = this.exePath.replace(/"/g, '""');
    const scriptArg = scriptPath.replace(/"/g, '""');

    try {
      await execAsync(
        `powershell -NoProfile -ExecutionPolicy Bypass -File "${scriptArg}" -ExePath "${exeArg}"`,
        { windowsHide: true, timeout: 8000 }
      );
    } catch {
      // non-fatal
    }
  }

  async hideTrayIconWithRetry() {
    await this.hideTrayIcon();
    for (const delay of [800, 1600, 3200]) {
      await new Promise((r) => setTimeout(r, delay));
      await this.hideTrayIcon();
    }
  }

  async start(onProgress) {
    if (await this.isProcessRunning()) {
      await this.hideTrayIconWithRetry();
      return this.getStatus();
    }

    await this.ensureBinary(onProgress);
    this.restoreUpdateCheckIfHubDisabled();
    await this.hideTrayIcon();

    return new Promise((resolve, reject) => {
      const child = spawn(this.exePath, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true
      });

      child.on('error', reject);
      child.unref();
      this._child = child;

      setTimeout(async () => {
        try {
          await this.hideTrayIconWithRetry();
          resolve(await this.getStatus());
        } catch (e) {
          reject(e);
        }
      }, 1200);
    });
  }

  async stop() {
    try {
      await execAsync('taskkill /F /IM TgWsProxy.exe /T', { windowsHide: true, timeout: 8000 });
    } catch {
      try {
        await execAsync('taskkill /F /IM TgWsProxy_windows.exe /T', { windowsHide: true, timeout: 8000 });
      } catch {
        // already stopped
      }
    }

    this._child = null;
    await new Promise((r) => setTimeout(r, 400));
    return this.getStatus();
  }

  openInTelegram() {
    const url = this.buildProxyUrl();
    spawn('cmd', ['/c', 'start', '', url], { detached: true, windowsHide: true }).unref();
    return { url };
  }

  async copyProxyLink() {
    const url = this.buildProxyUrl();
    const escaped = url.replace(/'/g, "''");
    await execAsync(
      `powershell -NoProfile -Command "Set-Clipboard -Value '${escaped}'"`,
      { windowsHide: true, timeout: 5000 }
    );
    return { url };
  }

  async openSettings() {
    if (!fs.existsSync(this.exePath)) {
      throw new Error('TG WS Proxy не установлен — сначала включите прокси');
    }
    spawn(this.exePath, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    await this.hideTrayIconWithRetry();
    return { started: true };
  }
}

module.exports = { TgProxyService };