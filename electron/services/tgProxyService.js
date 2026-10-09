const fs = require('fs');
const path = require('path');
const net = require('net');
const crypto = require('crypto');
const { spawn, exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const TG_HOST = '127.0.0.1';
const TG_PORT = 1443;
const EXE_NAME = 'ZapretTgProxy.exe';

const DEFAULT_PROXY = {
  host: '127.0.0.1',
  port: 1443
};

class TgProxyService {
  constructor(userDataPath, options = {}) {
    this.userDataPath = userDataPath;
    this.appPath = options.appPath || '';
    this.isPackaged = Boolean(options.isPackaged);
    this.resourcesPath = options.resourcesPath || '';
    this.installDir = path.join(userDataPath, 'tg-proxy');
    this.tgConfigDir = path.join(process.env.APPDATA || userDataPath, 'TgWsProxy');
    this.tgConfigFile = path.join(this.tgConfigDir, 'config.json');

    this._child = null;
    this._running = false;
    this._lastPingMs = 12;

    this._ensureConfig();
  }

  _ensureConfig() {
    try {
      if (!fs.existsSync(this.tgConfigDir)) {
        fs.mkdirSync(this.tgConfigDir, { recursive: true });
      }
      if (!fs.existsSync(this.tgConfigFile)) {
        const initialCfg = {
          host: '127.0.0.1',
          port: 1443,
          secret: crypto.randomBytes(16).toString('hex'),
          dc_ip: ['2:149.154.167.220', '4:149.154.167.220'],
          verbose: false,
          autostart: false,
          buf_kb: 256,
          pool_size: 4,
          log_max_mb: 5,
          check_updates: false,
          cfproxy: true,
          cfproxy_user_domain: [],
          cfproxy_worker_domain: [],
          appearance: 'auto',
          language: 'ru',
          ws_keepalive_interval: 30,
          force_test_dc: false,
          cfproxy_user_domain_enabled: false,
          cfproxy_worker_enabled: false,
          no_secure: false
        };
        fs.writeFileSync(this.tgConfigFile, JSON.stringify(initialCfg, null, 2), 'utf8');
      } else {
        try {
          const existing = JSON.parse(fs.readFileSync(this.tgConfigFile, 'utf8'));
          if (!existing.secret) {
            existing.secret = crypto.randomBytes(16).toString('hex');
            fs.writeFileSync(this.tgConfigFile, JSON.stringify(existing, null, 2), 'utf8');
          }
        } catch {}
      }
    } catch (e) {
      console.warn('[TgProxyService] _ensureConfig error:', e.message);
    }
  }

  readConfig() {
    try {
      if (fs.existsSync(this.tgConfigFile)) {
        const raw = fs.readFileSync(this.tgConfigFile, 'utf8');
        return { ...DEFAULT_PROXY, ...JSON.parse(raw) };
      }
    } catch {}
    return { ...DEFAULT_PROXY };
  }

  getExePath() {
    // 1. Packaged resources
    if (this.isPackaged && this.resourcesPath) {
      const p = path.join(this.resourcesPath, 'tg-proxy', EXE_NAME);
      if (fs.existsSync(p)) return p;
    }

    // 2. Local appPath bundled
    if (this.appPath) {
      const p = path.join(this.appPath, 'bundled', 'tg-proxy', EXE_NAME);
      if (fs.existsSync(p)) return p;
    }

    // 3. Relative dev fallback
    const devFallback = path.join(__dirname, '..', '..', 'bundled', 'tg-proxy', EXE_NAME);
    if (fs.existsSync(devFallback)) return devFallback;

    // 4. Dist build fallback
    const distFallback = path.join(__dirname, '..', '..', '.build', 'tg-ws-proxy-extract', 'tg-ws-proxy-1.7.3', 'dist', EXE_NAME);
    if (fs.existsSync(distFallback)) return distFallback;

    return null;
  }

  async checkPortOpen(port = TG_PORT, host = TG_HOST, timeoutMs = 800) {
    return new Promise((resolve) => {
      const start = Date.now();
      const socket = new net.Socket();
      socket.setTimeout(timeoutMs);

      socket.once('connect', () => {
        const ping = Date.now() - start;
        this._lastPingMs = Math.max(1, ping);
        socket.destroy();
        resolve(true);
      });

      socket.once('timeout', () => {
        socket.destroy();
        resolve(false);
      });

      socket.once('error', () => {
        socket.destroy();
        resolve(false);
      });

      socket.connect(port, host);
    });
  }

  async getStatus() {
    const isPortOpen = await this.checkPortOpen(TG_PORT, TG_HOST, 300);
    this._running = Boolean(this._child && !this._child.killed) || isPortOpen;

    const cfg = this.readConfig();
    if (!cfg.secret) {
      cfg.secret = crypto.randomBytes(16).toString('hex');
      try {
        if (fs.existsSync(this.tgConfigFile)) {
          const cur = JSON.parse(fs.readFileSync(this.tgConfigFile, 'utf8'));
          cur.secret = cfg.secret;
          fs.writeFileSync(this.tgConfigFile, JSON.stringify(cur, null, 2), 'utf8');
        }
      } catch {}
    }
    const secret = `dd${cfg.secret}`;
    const proxyUrl = `tg://proxy?server=${TG_HOST}&port=${TG_PORT}&secret=${secret}`;
    const webUrl = `https://t.me/proxy?server=${TG_HOST}&port=${TG_PORT}&secret=${secret}`;
    const version = await this.getCurrentVersion();

    return {
      running: this._running,
      installed: true,
      host: TG_HOST,
      port: TG_PORT,
      secret,
      protocol: 'MTProto / WebSocket',
      pingMs: this._lastPingMs,
      proxyUrl,
      webUrl,
      currentVersion: version,
      updateAvailable: false
    };
  }

  async getCurrentVersion() {
    if (this._cachedVersion) return this._cachedVersion;
    this._cachedVersion = '2.0.0';
    return this._cachedVersion;
  }

  async start(sendProgress) {
    const alreadyOpen = await this.checkPortOpen(TG_PORT, TG_HOST, 200);
    if (alreadyOpen) {
      this._running = true;
      return this.getStatus();
    }

    sendProgress?.({ stage: 'starting', message: 'Запуск внутреннего Telegram Proxy...' });

    const exePath = this.getExePath();
    if (!exePath || !fs.existsSync(exePath)) {
      throw new Error('Файл ZapretTgProxy.exe не найден. Пересоберите приложение.');
    }

    this._ensureConfig();

    // Clean up any stale lock files from previously abruptly terminated processes
    try {
      if (fs.existsSync(this.tgConfigDir)) {
        const lockFiles = fs.readdirSync(this.tgConfigDir).filter(f => f.endsWith('.lock'));
        for (const lf of lockFiles) {
          try { fs.unlinkSync(path.join(this.tgConfigDir, lf)); } catch {}
        }
      }
    } catch (_) {}

    this._child = spawn(exePath, [], {
      cwd: path.dirname(exePath),
      windowsHide: true,
      detached: false,
      stdio: ['ignore', 'ignore', 'ignore']
    });

    this._child.on('exit', () => {
      this._child = null;
      this._running = false;
    });

    for (let i = 0; i < 30; i++) {
      await new Promise((r) => setTimeout(r, 120));
      const ok = await this.checkPortOpen(TG_PORT, TG_HOST, 200);
      if (ok) {
        this._running = true;
        sendProgress?.({ stage: 'ready', message: 'Telegram Proxy готов к работе' });
        return this.getStatus();
      }
    }

    const finalOk = await this.checkPortOpen(TG_PORT, TG_HOST, 300);
    if (!finalOk) {
      throw new Error('Не удалось запустить Telegram Proxy (порт 1443 не отвечает).');
    }

    return this.getStatus();
  }

  async stop() {
    if (this._child) {
      const pid = this._child.pid;
      try {
        if (pid) {
          await execAsync(`taskkill /pid ${pid} /T /F`, { windowsHide: true });
        } else {
          this._child.kill('SIGKILL');
        }
      } catch (_) {
        try { this._child.kill('SIGKILL'); } catch (_) {}
      }
      this._child = null;
    }

    try {
      await execAsync(`taskkill /F /IM ${EXE_NAME} /T`, { windowsHide: true });
    } catch (_) {}

    try {
      if (fs.existsSync(this.tgConfigDir)) {
        const lockFiles = fs.readdirSync(this.tgConfigDir).filter(f => f.endsWith('.lock'));
        for (const lf of lockFiles) {
          try { fs.unlinkSync(path.join(this.tgConfigDir, lf)); } catch {}
        }
      }
    } catch (_) {}

    this._running = false;
    await new Promise((r) => setTimeout(r, 100));
    return this.getStatus();
  }

  async checkForUpdates() {
    const current = await this.getCurrentVersion();
    try {
      const { fetchGithubRelease } = require('../helpers/httpFetch');
      const PRIME_API = 'https://api.github.com/repos/xRAYNERx/Zapret-PRIME/releases/latest';
      const HUB_API = 'https://api.github.com/repos/xRAYNERx/Zapret-HUB/releases/latest';
      let release = null;
      try {
        release = await fetchGithubRelease(PRIME_API, { timeoutMs: 2500 });
      } catch {
        try {
          release = await fetchGithubRelease(HUB_API, { timeoutMs: 2500 });
        } catch {}
      }
      const remote = (release?.tag_name || '').replace(/^v/i, '');
      return {
        updateAvailable: Boolean(remote && current && remote !== current && current !== '0.0.0'),
        currentVersion: current,
        remoteVersion: remote || current
      };
    } catch {
      return {
        updateAvailable: false,
        currentVersion: current,
        remoteVersion: current
      };
    }
  }

  applyUpdate(sendProgress) {
    sendProgress?.({ stage: 'done', message: 'Обновление не требуется' });
    return Promise.resolve({ updated: true });
  }

  async openInTelegram(openExternalFn) {
    const status = await this.getStatus();
    const url = status.proxyUrl;
    if (typeof openExternalFn === 'function') {
      return openExternalFn(url);
    }
  }

  async copyProxyLink(clipboardModule) {
    const status = await this.getStatus();
    if (clipboardModule) {
      clipboardModule.writeText(status.proxyUrl);
    }
    return {
      ok: true,
      data: { link: status.proxyUrl, url: status.proxyUrl },
      link: status.proxyUrl,
      url: status.proxyUrl
    };
  }

  openSettings(shellModule) {
    if (shellModule) {
      shellModule.openPath(this.tgConfigDir);
    }
  }
}

module.exports = {
  TgProxyService,
  TG_HOST,
  TG_PORT
};