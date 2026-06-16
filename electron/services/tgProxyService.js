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
  constructor(userDataPath) {
    this.userDataPath = userDataPath;
    this.installDir = path.join(userDataPath, 'tg-proxy');
    this.exePath = path.join(this.installDir, EXE_NAME);
    this.versionPath = path.join(this.installDir, 'version.txt');
    this._child = null;
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

  getWindowsAsset(release) {
    const asset = release?.assets?.find((a) => a.name === WINDOWS_ASSET);
    if (!asset?.browser_download_url) {
      throw new Error(`Файл ${WINDOWS_ASSET} не найден в релизе`);
    }
    return asset.browser_download_url;
  }

  downloadFile(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
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

            response.on('data', (chunk) => {
              downloaded += chunk.length;
              if (total > 0 && typeof onProgress === 'function') {
                onProgress({
                  percent: Math.min(100, Math.round((downloaded / total) * 100)),
                  message: 'Скачивание TG WS Proxy...'
                });
              }
            });

            response.pipe(file);
            file.on('finish', () => file.close(() => resolve()));
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
    const url = this.getWindowsAsset(release);
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
      if (remote && local && local !== 'unknown') {
        updateAvailable = this.compareVersions(local, remote) < 0;
      } else if (remote && !installed) {
        updateAvailable = false;
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
      const updateAvailable = Boolean(remote) && (
        !local || local === 'unknown' || this.compareVersions(local, remote) < 0
      );
      return {
        local: local || 'не установлен',
        remote,
        updateAvailable,
        downloadUrl: this.getWindowsAsset(release),
        releaseUrl: release.html_url || RELEASE_PAGE
      };
    } catch (e) {
      return { local: local || 'не установлен', remote: null, updateAvailable: false, error: e.message };
    }
  }

  async applyUpdate(onProgress) {
    const info = await this.checkForUpdates();
    if (!info.updateAvailable && fs.existsSync(this.exePath)) {
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

  async start(onProgress) {
    if (await this.isProcessRunning()) {
      return this.getStatus();
    }

    await this.ensureBinary(onProgress);

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

  openSettings() {
    if (!fs.existsSync(this.exePath)) {
      throw new Error('TG WS Proxy не установлен — сначала включите прокси');
    }
    spawn(this.exePath, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    return { started: true };
  }
}

module.exports = { TgProxyService };