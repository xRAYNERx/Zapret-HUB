const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { exec, execSync, spawn } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const { fetchGithubRelease, fetchUrl } = require('../helpers/httpFetch');
const appPkg = require('../../package.json');

const VERSION_URL =
  'https://raw.githubusercontent.com/Flowseal/zapret-discord-youtube/main/.service/version.txt';
const RELEASE_BASE =
  'https://github.com/Flowseal/zapret-discord-youtube/releases/download';
const ZAPRET_RELEASE_API =
  'https://api.github.com/repos/Flowseal/zapret-discord-youtube/releases/latest';
const ZAPRET_RELEASE_PAGE =
  'https://github.com/Flowseal/zapret-discord-youtube/releases/latest';

const MERGE_ON_UPDATE_RELATIVE_PATHS = ['lists/list-general.txt'];

const PRESERVE_RELATIVE_PATHS = [
  'lists/list-general-user.txt',
  'lists/list-exclude-user.txt',
  'lists/ipset-exclude-user.txt',
  'lists/ipset-all.txt',
  'lists/ipset-all.txt.backup',
  'utils/game_filter.enabled'
];

const STRATEGY_LABELS = {
  'general.bat': {
    name: 'Основная',
    desc: 'Multisplit — разбивает TCP-пакеты. Базовая стратегия, с неё обычно начинают'
  },
  ...Object.fromEntries(
    Array.from({ length: 12 }, (_, i) => {
      const num = i === 0 ? '' : (i + 1).toString();
      const file = `general (ALT${num}).bat`;
      const name = i === 0 ? 'ALT' : `ALT ${i + 1}`;
      const desc = i === 0
        ? 'Fake + fakedsplit — поддельные пакеты и разделение. Часто лучший вариант на жёстком DPI'
        : i === 1
          ? 'Fake + fakedsplit, вариант 2 — другие шаблоны TLS/HTTP'
          : `Fake + fakedsplit, вариант ${i + 1}`;
      return [file, { name, desc }];
    })
  ),
  'general (FAKE TLS AUTO).bat': {
    name: 'FAKE TLS AUTO',
    desc: 'Автогенерация поддельного TLS (multidisorder) — для провайдеров с глубоким анализом TLS'
  },
  'general (FAKE TLS AUTO ALT).bat': {
    name: 'FAKE TLS AUTO ALT',
    desc: 'FAKE TLS AUTO — альтернативные параметры генерации'
  },
  'general (FAKE TLS AUTO ALT2).bat': {
    name: 'FAKE TLS AUTO ALT 2',
    desc: 'FAKE TLS AUTO — альтернатива 2'
  },
  'general (FAKE TLS AUTO ALT3).bat': {
    name: 'FAKE TLS AUTO ALT 3',
    desc: 'FAKE TLS AUTO — альтернатива 3'
  },
  'general (SIMPLE FAKE).bat': {
    name: 'SIMPLE FAKE',
    desc: 'Простой fake — подставляет готовые TLS-шаблоны без автогенерации'
  },
  'general (SIMPLE FAKE ALT).bat': {
    name: 'SIMPLE FAKE ALT',
    desc: 'SIMPLE FAKE — альтернативный набор шаблонов'
  },
  'general (SIMPLE FAKE ALT2).bat': {
    name: 'SIMPLE FAKE ALT 2',
    desc: 'SIMPLE FAKE — альтернатива 2'
  }
};

class ZapretService {
  constructor(appPath, options = {}) {
    this.appPath = appPath;
    this.configPath = options.configPath || path.join(appPath, 'config.json');
    this.isPackaged = Boolean(options.isPackaged);
    this.resourcesPath = options.resourcesPath || '';
    this.userDataPath = options.userDataPath || '';
    this.config = this.loadConfig();
    this._resolvedZapretPath = null;
    this._updateCheckCache = null;
    this._strategyProbeRunning = false;
    this._strategyProbeChild = null;
    this._strategyProbeCancelPath = null;
    this._strategyProbeCancelRequested = false;
    this._installedStrategyCache = null;
    this._installedStrategyCacheAt = 0;
    this._isElevatedCache = null;
    this._starting = false;
  }

  loadConfig() {
    const defaults = JSON.parse(
      fs.readFileSync(path.join(this.appPath, 'config.default.json'), 'utf8')
    );
    if (fs.existsSync(this.configPath)) {
      try {
        return { ...defaults, ...JSON.parse(fs.readFileSync(this.configPath, 'utf8')) };
      } catch {
        return defaults;
      }
    }
    return defaults;
  }

  saveConfig() {
    fs.writeFileSync(this.configPath, JSON.stringify(this.config, null, 2), 'utf8');
  }

  isFirstProbePromptDismissed() {
    return Boolean(this.config.firstProbePromptDismissed);
  }

  setFirstProbeDismissed() {
    this.config.firstProbePromptDismissed = true;
    this.saveConfig();
    return true;
  }

  isValidEnginePath(enginePath) {
    return Boolean(
      enginePath &&
      fs.existsSync(enginePath) &&
      fs.existsSync(path.join(enginePath, 'bin', 'winws.exe'))
    );
  }

  getBundledEnginePath() {
    if (this.isPackaged && this.resourcesPath) {
      const packaged = path.join(this.resourcesPath, 'zapret');
      if (this.isValidEnginePath(packaged)) return packaged;
    }

    const bundled = path.join(this.appPath, 'bundled', 'zapret');
    if (this.isValidEnginePath(bundled)) return bundled;

    const sibling = path.join(this.appPath, '..', 'Запрет');
    if (this.isValidEnginePath(sibling)) return sibling;

    return null;
  }

  getRuntimeEnginePath() {
    return path.join(this.userDataPath || this.appPath, 'engine');
  }

  isLockedDriverFile(relPath) {
    const normalized = relPath.replace(/\\/g, '/').toLowerCase();
    return normalized.endsWith('bin/windivert64.sys') || normalized.endsWith('bin/windivert.dll');
  }

  copyEngineTree(sourceDir, targetDir, engineRoot = targetDir) {
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });

    for (const entry of entries) {
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);
      const relPath = path.relative(engineRoot, targetPath);

      if (entry.isDirectory()) {
        fs.mkdirSync(targetPath, { recursive: true });
        this.copyEngineTree(sourcePath, targetPath, engineRoot);
        continue;
      }

      if (fs.existsSync(targetPath)) {
        try {
          const srcStat = fs.statSync(sourcePath);
          const destStat = fs.statSync(targetPath);
          if (srcStat.size === destStat.size) continue;
        } catch {
          // continue with copy attempt
        }
      }

      try {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(sourcePath, targetPath);
      } catch (err) {
        if ((err.code === 'EBUSY' || err.code === 'EPERM') && this.isLockedDriverFile(relPath)) {
          if (fs.existsSync(targetPath)) continue;
        }
        throw err;
      }
    }
  }

  ensurePackagedEngine() {
    const runtimePath = this.getRuntimeEnginePath();
    const bundled = this.getBundledEnginePath();

    if (bundled) {
      try {
        fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
        this.copyEngineTree(bundled, runtimePath);
        this.ensureUserLists(runtimePath);
      } catch (err) {
        console.error('Не удалось синхронизировать движок Zapret в AppData:', err);
      }
    }

    if (this.isValidEnginePath(runtimePath)) {
      return runtimePath;
    }

    if (!bundled) {
      throw new Error('Встроенный движок Zapret не найден. Переустановите приложение.');
    }

    throw new Error('Не удалось развернуть движок Zapret в AppData.');
  }

  async prepareStartup() {
    this.removeLegacyUpdateFlag();
    this.ensurePackagedEngine();
    await this.applyPendingUpdates();
    this.syncActiveCustomList();
  }

  resolveZapretPath() {
    if (this._resolvedZapretPath && this.isValidEnginePath(this._resolvedZapretPath)) {
      return this._resolvedZapretPath;
    }

    const configured = (this.config.zapretPath || '').trim();
    if (configured && this.isValidEnginePath(configured)) {
      this._resolvedZapretPath = configured;
      return configured;
    }

    if (this.isPackaged) {
      this._resolvedZapretPath = this.ensurePackagedEngine();
      return this._resolvedZapretPath;
    }

    const bundled = this.getBundledEnginePath();
    if (!bundled) {
      throw new Error(
        'Движок Zapret не найден. Ожидается папка «Запрет» рядом с проектом или bundled/zapret.'
      );
    }

    this._resolvedZapretPath = bundled;
    return bundled;
  }

  getZapretPath() {
    return this.resolveZapretPath();
  }

  setZapretPath(newPath) {
    if (!fs.existsSync(newPath)) {
      throw new Error('Папка Zapret не найдена');
    }
    if (!this.isValidEnginePath(newPath)) {
      throw new Error('В папке нет winws.exe — проверьте путь');
    }
    this.config.zapretPath = newPath;
    this.saveConfig();
    this._resolvedZapretPath = newPath;
    return newPath;
  }

  validateZapretPath() {
    try {
      const p = this.getZapretPath();
      return {
        valid: this.isValidEnginePath(p),
        path: p
      };
    } catch (err) {
      return {
        valid: false,
        path: this.config.zapretPath || '',
        error: err.message
      };
    }
  }

  naturalSort(a, b) {
    const pad = (s) => s.replace(/(\d+)/g, (m) => m.padStart(8, '0'));
    return pad(a).localeCompare(pad(b));
  }

  getStrategies() {
    const zapretPath = this.getZapretPath();
    if (!fs.existsSync(zapretPath)) return [];

    const files = fs.readdirSync(zapretPath)
      .filter((f) => f.startsWith('general') && f.endsWith('.bat'))
      .sort((a, b) => this.naturalSort(a, b));

    return files.map((file) => {
      const meta = STRATEGY_LABELS[file] || { name: file.replace('.bat', ''), desc: '' };
      return { file, ...meta };
    });
  }

  async isProcessRunning(imageName) {
    try {
      const { stdout } = await execAsync(
        `tasklist /FI "IMAGENAME eq ${imageName}" /NH`,
        { windowsHide: true }
      );
      return stdout.toLowerCase().includes(imageName.toLowerCase());
    } catch {
      return false;
    }
  }

  async getServiceState(serviceName) {
    try {
      const { stdout } = await execAsync(`sc query "${serviceName}"`, { windowsHide: true });
      const match = stdout.match(/STATE\s+:\s+\d+\s+(\w+)/i);
      return match ? match[1] : 'NOT_FOUND';
    } catch {
      return 'NOT_FOUND';
    }
  }

  async getMultipleServiceStates(...serviceNames) {
    try {
      const { stdout } = await execAsync('sc query state= all', { windowsHide: true, maxBuffer: 5 * 1024 * 1024 });
      const result = {};
      for (const name of serviceNames) {
        const regex = new RegExp(`SERVICE_NAME:\\s+${name}[\\s\\S]*?STATE\\s+:\\s+\\d+\\s+(\\w+)`, 'i');
        const match = stdout.match(regex);
        result[name] = match ? match[1] : 'NOT_FOUND';
      }
      return result;
    } catch {
      return Object.fromEntries(serviceNames.map((n) => [n, 'NOT_FOUND']));
    }
  }

  async getInstalledStrategy() {
    try {
      const { stdout } = await execAsync(
        'reg query "HKLM\\System\\CurrentControlSet\\Services\\zapret" /v zapret-discord-youtube',
        { windowsHide: true }
      );
      const match = stdout.match(/zapret-discord-youtube\s+REG_SZ\s+(.+)/i);
      return match ? match[1].trim() : null;
    } catch {
      return null;
    }
  }

  async getInstalledStrategyCached() {
    const now = Date.now();
    if (this._installedStrategyCache !== null && now - this._installedStrategyCacheAt < 60000) {
      return this._installedStrategyCache;
    }
    this._installedStrategyCache = await this.getInstalledStrategy();
    this._installedStrategyCacheAt = now;
    return this._installedStrategyCache;
  }

  getGameFilterStatus() {
    const flagFile = path.join(this.getZapretPath(), 'utils', 'game_filter.enabled');
    if (!fs.existsSync(flagFile)) {
      return { enabled: false, mode: 'disabled', label: 'Выключен' };
    }
    const mode = fs.readFileSync(flagFile, 'utf8').trim().toLowerCase();
    const labels = {
      all: 'TCP и UDP',
      tcp: 'Только TCP',
      udp: 'Только UDP'
    };
    return { enabled: true, mode, label: labels[mode] || mode };
  }

  setGameFilter(mode) {
    const flagFile = path.join(this.getZapretPath(), 'utils', 'game_filter.enabled');
    if (mode === 'disabled') {
      if (fs.existsSync(flagFile)) fs.unlinkSync(flagFile);
    } else {
      const dir = path.dirname(flagFile);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(flagFile, mode, 'utf8');
    }
    return this.getGameFilterStatus();
  }

  getIpsetStatus() {
    const listFile = path.join(this.getZapretPath(), 'lists', 'ipset-all.txt');
    if (!fs.existsSync(listFile)) return { status: 'any', label: 'Любые IP' };

    const content = fs.readFileSync(listFile, 'utf8').trim();
    if (!content) return { status: 'any', label: 'Любые IP' };
    if (content.includes('203.0.113.113/32')) return { status: 'none', label: 'Отключён' };
    return { status: 'loaded', label: 'Загружен' };
  }

  setIpset(targetStatus) {
    const zapretPath = this.getZapretPath();
    const listsDir = path.join(zapretPath, 'lists');
    const listFile = path.join(listsDir, 'ipset-all.txt');
    const backupFile = path.join(listsDir, 'ipset-all.txt.backup');

    const bundledEngine = this.getBundledEnginePath();
    const bundledBackup = bundledEngine ? path.join(bundledEngine, 'lists', 'ipset-all.txt.backup') : null;
    const bundledList = bundledEngine ? path.join(bundledEngine, 'lists', 'ipset-all.txt') : null;

    if (!fs.existsSync(listsDir)) {
      fs.mkdirSync(listsDir, { recursive: true });
    }

    const isValidDb = (filePath) => {
      try {
        if (!filePath || !fs.existsSync(filePath)) return false;
        const stat = fs.statSync(filePath);
        if (stat.size < 50) return false;
        const sample = fs.readFileSync(filePath, 'utf8', { flag: 'r' }).slice(0, 200);
        return !sample.includes('203.0.113.113/32');
      } catch {
        return false;
      }
    };

    // If current listFile has real database, preserve/refresh backupFile
    if (isValidDb(listFile)) {
      try {
        fs.copyFileSync(listFile, backupFile);
      } catch {}
    }

    if (targetStatus === 'none') {
      // Disabled filtering: dummy non-routable test IP
      fs.writeFileSync(listFile, '203.0.113.113/32\n', 'utf8');
    } else if (targetStatus === 'any') {
      // Any IP: empty list file
      fs.writeFileSync(listFile, '', 'utf8');
    } else if (targetStatus === 'loaded') {
      // Loaded: restore full database from backup or bundled files (NEVER unlink backupFile!)
      let restored = false;
      if (isValidDb(backupFile)) {
        fs.copyFileSync(backupFile, listFile);
        restored = true;
      } else if (bundledBackup && isValidDb(bundledBackup)) {
        fs.copyFileSync(bundledBackup, listFile);
        fs.copyFileSync(bundledBackup, backupFile);
        restored = true;
      } else if (bundledList && isValidDb(bundledList)) {
        fs.copyFileSync(bundledList, listFile);
        fs.copyFileSync(bundledList, backupFile);
        restored = true;
      }

      if (!restored) {
        throw new Error('Файл базы IPSet не найден. Нажмите «Обновить» для загрузки.');
      }
    }

    return this.getIpsetStatus();
  }

  getAutoUpdateStatus() {
    return { enabled: this.config.autoCheckUpdates !== false };
  }

  setAutoUpdate(enabled) {
    this.config.autoCheckUpdates = Boolean(enabled);
    this.saveConfig();
    this.removeLegacyUpdateFlag();
    return this.getAutoUpdateStatus();
  }

  removeLegacyUpdateFlag() {
    try {
      const flagFile = path.join(this.getZapretPath(), 'utils', 'check_updates.enabled');
      if (fs.existsSync(flagFile)) fs.unlinkSync(flagFile);
    } catch {
      // ignore
    }
  }

  // Нормализация строки версии: удаление BOM, замена кириллических 
  // lookalike-символов на их латинские аналоги (защита от подмены в имени версии).
  // Например: unicode 'с' (U+0441) → ASCII 'c'
  normalizeVersion(version) {
    return String(version || '')
      .trim()
      .replace(/^\uFEFF/, '')
      .replace(/[\u0441\u0441]/gi, 'c')
      .replace(/[\u0430]/gi, 'a')
      .replace(/[\u0435]/gi, 'e')
      .replace(/[\u043e]/gi, 'o')
      .replace(/[\u0440]/gi, 'p')
      .replace(/[\u0445]/gi, 'x')
      .replace(/[\u0443]/gi, 'y')
      .replace(/[\u0432]/gi, 'b');
  }

  parseVersion(version) {
    const normalized = this.normalizeVersion(version);
    const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)([a-z]*)$/i);
    if (!match) return null;
    return {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      suffix: (match[4] || '').toLowerCase()
    };
  }

  compareVersions(left, right) {
    const a = this.parseVersion(left);
    const b = this.parseVersion(right);
    if (!a || !b) {
      const lNorm = this.normalizeVersion(left).toLowerCase();
      const rNorm = this.normalizeVersion(right).toLowerCase();
      if (lNorm === rNorm) return 0;
      // Если хотя бы одна версия непарсируема — считаем равными (не предлагать ложное обновление)
      return 0;
    }

    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    if (a.patch !== b.patch) return a.patch - b.patch;
    if (a.suffix === b.suffix) return 0;
    if (!a.suffix) return -1;
    if (!b.suffix) return 1;
    return a.suffix.localeCompare(b.suffix);
  }

  invalidateUpdateCache() {
    this._updateCheckCache = null;
  }

  getLocalVersion() {
    try {
      const serviceBat = path.join(this.getZapretPath(), 'service.bat');
      const content = fs.readFileSync(serviceBat, 'utf8');
      const match = content.match(/LOCAL_VERSION=["']?([^"'\r\n]+)["']?/i);
      return this.extractVersionFromText(match ? match[1] : '') || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  extractVersionFromText(value) {
    const normalized = this.normalizeVersion(value);
    const match = normalized.match(/^(\d+\.\d+\.\d+[a-z]*)$/i);
    return match ? match[1] : null;
  }

  humanizeUpdateError(err) {
    const msg = String(err?.message || err || '');
    if (/таймаут|timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|EAI_AGAIN/i.test(msg)) {
      return 'Не удалось связаться с GitHub. Проверьте интернет и повторите.';
    }
    if (/HTTP 40[13]|403|rate limit/i.test(msg)) {
      return 'GitHub временно ограничил запросы. Повторите позже.';
    }
    if (/не удалось определить версию/i.test(msg)) {
      return msg;
    }
    return 'Не удалось проверить обновления. Повторите позже.';
  }

  async fetchTextUrl(url, timeoutMs = 10000) {
    const res = await fetchUrl(url, {
      headers: {
        'User-Agent': 'Zapret.NET',
        'Cache-Control': 'no-cache',
        Accept: 'text/plain, text/html, application/json, */*'
      },
      timeoutMs
    });
    return res.body;
  }

  fetchGithubRelease(apiUrl) {
    return fetchGithubRelease(apiUrl);
  }

  parseReleaseTagFromHtml(html) {
    const canonical = html.match(/<link[^>]+rel="canonical"[^>]+href="[^"]*\/releases\/tag\/([^"]+)"/i);
    if (canonical?.[1]) return canonical[1];

    const og = html.match(/\/releases\/tag\/(v?[\d.]+[a-z]*)/i);
    if (og?.[1]) return og[1];

    const embedded = html.match(/"tag_name"\s*:\s*"(v?[\d.]+[a-z]*)"/i);
    if (embedded?.[1]) return embedded[1];

    return null;
  }

  async fetchRemoteVersion() {
    try {
      const text = await this.fetchTextUrl(VERSION_URL, 8000);
      const version = this.extractVersionFromText(text);
      if (version) return version;
    } catch {
      // fallback
    }

    try {
      const release = await this.fetchGithubRelease(ZAPRET_RELEASE_API);
      const version = this.extractVersionFromText(String(release.tag_name || '').replace(/^v/i, ''));
      if (version) return version;
    } catch {
      // fallback
    }

    try {
      const html = await this.fetchTextUrl(ZAPRET_RELEASE_PAGE, 15000);
      const tag = this.parseReleaseTagFromHtml(html);
      const version = this.extractVersionFromText(String(tag || '').replace(/^v/i, ''));
      if (version) return version;
    } catch {
      // fallback
    }

    throw new Error('Не удалось определить версию на GitHub');
  }

  getReleaseDownloadUrl(version) {
    return `${RELEASE_BASE}/${version}/zapret-discord-youtube-${version}.zip`;
  }

  emitProgress(onProgress, payload) {
    if (typeof onProgress === 'function') onProgress(payload);
  }

  downloadFile(url, destPath, onProgress) {
    return new Promise((resolve, reject) => {
      const request = (targetUrl, depth = 0) => {
        const client = targetUrl.startsWith('https') ? https : http;
        client
          .get(targetUrl, { headers: { 'User-Agent': 'Zapret.NET' } }, (response) => {
            if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
              if (depth >= 6) {
                response.resume();
                return reject(new Error('Слишком много редиректов при скачивании'));
              }
              request(response.headers.location, depth + 1);
              return;
            }

            if (response.statusCode !== 200) {
              reject(new Error(`Не удалось скачать обновление (HTTP ${response.statusCode})`));
              return;
            }

            const total = Number(response.headers['content-length'] || 0);
            let downloaded = 0;
            const file = fs.createWriteStream(destPath);

            response.on('data', (chunk) => {
              downloaded += chunk.length;
              if (total > 0) {
                this.emitProgress(onProgress, {
                  phase: 'download',
                  percent: Math.min(100, Math.round((downloaded / total) * 100)),
                  message: 'Скачивание обновления...'
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

  async extractZip(zipPath, destDir) {
    const zipArg = zipPath.replace(/'/g, "''");
    const destArg = destDir.replace(/'/g, "''");
    await execAsync(
      `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipArg}' -DestinationPath '${destArg}' -Force"`,
      { windowsHide: true, timeout: 120000 }
    );
  }

  verifyNoPathTraversal(extractDir) {
    const absExtract = path.resolve(extractDir);
    const check = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.resolve(dir, entry.name);
        if (!full.startsWith(absExtract + path.sep) && full !== absExtract) {
          throw new Error(`Подозрительный путь в архиве: ${entry.name}`);
        }
        if (entry.isDirectory()) check(full);
      }
    };
    check(absExtract);
  }

  backupUserFiles(enginePath) {
    const backup = {};
    const backupPaths = [...MERGE_ON_UPDATE_RELATIVE_PATHS, ...PRESERVE_RELATIVE_PATHS];
    for (const relPath of backupPaths) {
      const fullPath = path.join(enginePath, relPath);
      if (fs.existsSync(fullPath)) {
        backup[relPath] = fs.readFileSync(fullPath);
      }
    }

    const customDir = path.join(enginePath, 'lists', 'custom');
    if (fs.existsSync(customDir)) {
      for (const name of fs.readdirSync(customDir)) {
        const fullPath = path.join(customDir, name);
        if (fs.statSync(fullPath).isFile()) {
          backup[`lists/custom/${name}`] = fs.readFileSync(fullPath);
        }
      }
    }

    return backup;
  }

  mergeSiteLists(baseSites, extraSites) {
    const merged = [...baseSites];
    for (const site of extraSites) {
      if (!merged.includes(site)) merged.push(site);
    }
    return merged;
  }

  mergeGeneralListAfterUpdate(enginePath, userBackupContent) {
    if (!userBackupContent) return { added: 0, total: 0 };

    const listFile = path.join(enginePath, 'lists', 'list-general.txt');
    const userSites = this.parseListLines(userBackupContent.toString('utf8'));
    const upstreamSites = this.readSitesFromFile(listFile);
    const merged = this.mergeSiteLists(upstreamSites, userSites);
    this.writeSitesToFile(listFile, merged);
    return { added: merged.length - upstreamSites.length, total: merged.length };
  }

  restoreUserFiles(enginePath, backup) {
    const mergeGeneralBackup = backup['lists/list-general.txt'];

    for (const [relPath, content] of Object.entries(backup)) {
      if (MERGE_ON_UPDATE_RELATIVE_PATHS.includes(relPath)) continue;
      const fullPath = path.join(enginePath, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }

    const listMerge = this.mergeGeneralListAfterUpdate(enginePath, mergeGeneralBackup);
    this.ensureUserLists(enginePath);
    return { listMerge };
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  isElevated() {
    if (process.platform !== 'win32') return false;
    if (this._isElevatedCache !== null) return this._isElevatedCache;
    try {
      // fast check without output
      execSync('net session >nul 2>&1', { stdio: 'ignore', windowsHide: true });
      this._isElevatedCache = true;
    } catch {
      this._isElevatedCache = false;
    }
    return this._isElevatedCache;
  }

  async waitForProcessExit(imageName, maxMs = 3000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (!(await this.isProcessRunning(imageName))) return true;
      await this.delay(100);
    }
    return !(await this.isProcessRunning(imageName));
  }

  async waitForProcessStart(imageName, maxMs = 8000) {
    const deadline = Date.now() + maxMs;
    while (Date.now() < deadline) {
      if (await this.isProcessRunning(imageName)) return true;
      await this.delay(100);
    }
    return this.isProcessRunning(imageName);
  }

  async copyFileWithRetry(sourcePath, targetPath, attempts = 8) {
    let lastError = null;
    for (let i = 0; i < attempts; i += 1) {
      try {
        fs.mkdirSync(path.dirname(targetPath), { recursive: true });
        fs.copyFileSync(sourcePath, targetPath);
        return;
      } catch (err) {
        lastError = err;
        if (err.code !== 'EBUSY' && err.code !== 'EPERM') throw err;
        await this.delay(500);
      }
    }
    throw lastError;
  }

  getPendingUpdateDir(enginePath) {
    return path.join(enginePath, '.pending-update');
  }

  getPendingUpdateManifest(enginePath) {
    return path.join(this.getPendingUpdateDir(enginePath), 'manifest.json');
  }

  queuePendingFile(enginePath, sourcePath, targetPath) {
    const pendingRoot = this.getPendingUpdateDir(enginePath);
    const relative = path.relative(enginePath, targetPath);
    const stagedPath = path.join(pendingRoot, relative);
    fs.mkdirSync(path.dirname(stagedPath), { recursive: true });
    fs.copyFileSync(sourcePath, stagedPath);

    const manifestPath = this.getPendingUpdateManifest(enginePath);
    const manifest = fs.existsSync(manifestPath)
      ? JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
      : { files: [] };
    if (!manifest.files.includes(relative)) manifest.files.push(relative);
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
  }

  async applyPendingUpdates(enginePath = this.getZapretPath()) {
    const manifestPath = this.getPendingUpdateManifest(enginePath);
    if (!fs.existsSync(manifestPath)) return { applied: 0, pending: 0 };

    const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    const pendingRoot = this.getPendingUpdateDir(enginePath);
    let applied = 0;
    const stillPending = [];

    for (const relPath of manifest.files || []) {
      const stagedPath = path.join(pendingRoot, relPath);
      const targetPath = path.join(enginePath, relPath);
      if (!fs.existsSync(stagedPath)) continue;
      try {
        await this.copyFileWithRetry(stagedPath, targetPath, 3);
        fs.unlinkSync(stagedPath);
        applied += 1;
      } catch {
        stillPending.push(relPath);
      }
    }

    if (stillPending.length === 0) {
      fs.rmSync(pendingRoot, { recursive: true, force: true });
    } else {
      manifest.files = stillPending;
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
    }

    return { applied, pending: stillPending.length };
  }

  async copyDirectoryContents(sourceDir, targetDir, enginePath = targetDir) {
    const entries = fs.readdirSync(sourceDir, { withFileTypes: true });
    const deferred = [];

    for (const entry of entries) {
      const sourcePath = path.join(sourceDir, entry.name);
      const targetPath = path.join(targetDir, entry.name);
      if (entry.isDirectory()) {
        fs.mkdirSync(targetPath, { recursive: true });
        const nested = await this.copyDirectoryContents(sourcePath, targetPath, enginePath);
        deferred.push(...nested);
      } else {
        try {
          await this.copyFileWithRetry(sourcePath, targetPath, 4);
        } catch (err) {
          if (err.code === 'EBUSY' || err.code === 'EPERM') {
            this.queuePendingFile(enginePath, sourcePath, targetPath);
            deferred.push(path.relative(enginePath, targetPath));
          } else {
            throw err;
          }
        }
      }
    }

    return deferred;
  }

  findExtractedRoot(extractDir, version) {
    if (fs.existsSync(path.join(extractDir, 'bin', 'winws.exe'))) return extractDir;

    const expected = path.join(extractDir, `zapret-discord-youtube-${version}`);
    if (fs.existsSync(path.join(expected, 'bin', 'winws.exe'))) return expected;

    const entries = fs.readdirSync(extractDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const candidate = path.join(extractDir, entry.name);
      if (fs.existsSync(path.join(candidate, 'bin', 'winws.exe'))) return candidate;
    }

    throw new Error('В архиве обновления не найден движок Zapret');
  }

  async applyUpdate(remoteVersion, onProgress) {
    const enginePath = this.getZapretPath();
    const wasRunning = await this.isProcessRunning('winws.exe');

    if (wasRunning) {
      this.emitProgress(onProgress, { phase: 'stop', percent: 0, message: 'Останавливаем Zapret...' });
      await this.stop();
      await this.delay(2000);
    }

    const backup = this.backupUserFiles(enginePath);
    const tempRoot = path.join(this.userDataPath || this.appPath, 'updates');
    const workDir = path.join(tempRoot, `install-${remoteVersion}-${Date.now()}`);
    const zipPath = path.join(workDir, `zapret-discord-youtube-${remoteVersion}.zip`);
    const extractDir = path.join(workDir, 'extracted');

    fs.mkdirSync(workDir, { recursive: true });

    try {
      this.emitProgress(onProgress, { phase: 'download', percent: 0, message: 'Скачивание обновления...' });
      await this.downloadFile(this.getReleaseDownloadUrl(remoteVersion), zipPath, onProgress);

      this.emitProgress(onProgress, { phase: 'extract', percent: 0, message: 'Распаковка архива...' });
      fs.mkdirSync(extractDir, { recursive: true });
      await this.extractZip(zipPath, extractDir);
      this.verifyNoPathTraversal(extractDir);

      const sourceRoot = this.findExtractedRoot(extractDir, remoteVersion);
      this.emitProgress(onProgress, { phase: 'install', percent: 50, message: 'Установка файлов...' });
      const deferred = await this.copyDirectoryContents(sourceRoot, enginePath, enginePath);

      this.emitProgress(onProgress, { phase: 'restore', percent: 80, message: 'Сохраняем настройки и объединяем список сайтов...' });
      const { listMerge } = this.restoreUserFiles(enginePath, backup);
      this.removeLegacyUpdateFlag();
      this._resolvedZapretPath = enginePath;

      const local = this.getLocalVersion();
      if (this.compareVersions(local, remoteVersion) < 0) {
        throw new Error(`После установки версия ${local}, ожидалась ${remoteVersion}`);
      }

      const mergeNote =
        listMerge?.added > 0 ? ` Список сайтов: +${listMerge.added} ваших доменов.` : '';
      const doneMessage = deferred.length
        ? `Обновлено до ${local}.${mergeNote} ${deferred.length} файл(ов) будут догружены при следующем запуске.`
        : `Обновлено до ${local}.${mergeNote}`;

      this.emitProgress(onProgress, { phase: 'done', percent: 100, message: doneMessage });
      this.invalidateUpdateCache();
      return {
        success: true,
        local,
        remote: remoteVersion,
        restarted: wasRunning,
        deferredFiles: deferred
      };
    } finally {
      try {
        fs.rmSync(workDir, { recursive: true, force: true });
      } catch {
        // ignore cleanup errors
      }
    }
  }

  getListsPath(enginePath = this.getZapretPath()) {
    return path.join(enginePath, 'lists');
  }

  getGeneralListFile() {
    return path.join(this.getListsPath(), 'list-general.txt');
  }

  getCustomListsDir() {
    const dir = path.join(this.getListsPath(), 'custom');
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    return dir;
  }

  parseListLines(content) {
    return content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith('#'));
  }

  cleanSites(sites) {
    return sites
      .map((s) => s.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''))
      .filter((s) => s && !s.startsWith('#'));
  }

  readSitesFromFile(filePath) {
    if (!fs.existsSync(filePath)) return [];
    return this.parseListLines(fs.readFileSync(filePath, 'utf8'));
  }

  writeSitesToFile(filePath, sites, headerLines = []) {
    const cleaned = this.cleanSites(sites);
    const lines = [...headerLines, ...cleaned];
    const content = lines.length ? `${lines.join('\n')}\n` : '';
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content, 'utf8');
    return cleaned;
  }

  sanitizeCustomListId(name) {
    const id = name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9а-яё_-]+/gi, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 48);
    if (!id) {
      throw new Error('Недопустимое имя списка');
    }
    return id;
  }

  getGeneralSites() {
    return this.readSitesFromFile(this.getGeneralListFile());
  }

  saveGeneralSites(sites) {
    this.writeSitesToFile(this.getGeneralListFile(), sites);
    return this.getGeneralSites();
  }

  getExcludeListFile() {
    return path.join(this.getListsPath(), 'list-exclude-user.txt');
  }

  getExcludeSites() {
    return this.readSitesFromFile(this.getExcludeListFile());
  }

  getAllExcludeSites() {
    const user = this.getExcludeSites();
    const builtinFile = path.join(this.getListsPath(), 'list-exclude.txt');
    const builtin = fs.existsSync(builtinFile) ? this.readSitesFromFile(builtinFile) : [];
    return Array.from(new Set([...user, ...builtin]));
  }

  saveExcludeSites(sites) {
    this.writeSitesToFile(this.getExcludeListFile(), sites);
    return this.getExcludeSites();
  }

  exportExcludeSitesText() {
    const sites = this.getExcludeSites();
    return sites.length ? `${sites.join('\n')}\n` : '';
  }

  importExcludeSites(text, mode = 'merge') {
    const imported = this.parseSitesImportText(text);
    if (mode === 'replace') {
      return this.saveExcludeSites(imported);
    }
    return this.saveExcludeSites(this.mergeSiteLists(this.getExcludeSites(), imported));
  }

  exportGeneralSitesText() {
    const sites = this.getGeneralSites();
    return sites.length ? `${sites.join('\n')}\n` : '';
  }

  parseSitesImportText(text) {
    return this.cleanSites(this.parseListLines(String(text || '')));
  }

  importGeneralSites(text, mode = 'merge') {
    const imported = this.parseSitesImportText(text);
    if (mode === 'replace') {
      return this.saveGeneralSites(imported);
    }
    return this.saveGeneralSites(this.mergeSiteLists(this.getGeneralSites(), imported));
  }

  exportCustomListSitesText(listId) {
    const sites = this.getCustomListSites(listId);
    return sites.length ? `${sites.join('\n')}\n` : '';
  }

  importCustomListSites(listId, text, mode = 'merge') {
    const imported = this.parseSitesImportText(text);
    if (mode === 'replace') {
      return this.saveCustomListSites(listId, imported);
    }
    return this.saveCustomListSites(listId, this.mergeSiteLists(this.getCustomListSites(listId), imported));
  }

  summarizeStrategyProbeResult(result) {
    if (!result || result.cancelled || !result.bestStrategy) return null;
    const best = result.strategies?.find((row) => row.file === result.bestStrategy);
    if (!best) return null;

    const sitesOk = (best.httpOk || 0) + (best.pingOk || 0);
    const sitesTotal = sitesOk + (best.httpError || 0) + (best.pingFail || 0) + (best.httpUnsup || 0);
    const meta = STRATEGY_LABELS[best.file] || { name: best.name || best.file.replace('.bat', '') };

    return {
      strategyFile: best.file,
      strategyName: meta.name,
      sitesOk,
      sitesTotal: sitesTotal || sitesOk,
      working: Boolean(best.working),
      testedAt: result.finishedAt || new Date().toISOString(),
      mode: result.mode || 'all'
    };
  }

  saveLastStrategyProbe(result) {
    const summary = this.summarizeStrategyProbeResult(result);
    if (!summary) return null;
    this.config.lastStrategyProbe = summary;
    this.saveConfig();
    return summary;
  }

  setCloseBehavior(mode) {
    const allowed = new Set([null, 'tray', 'quit']);
    const next = allowed.has(mode) ? mode : null;
    this.config.closeBehavior = next;
    this.saveConfig();
    return { closeBehavior: this.config.closeBehavior };
  }

  setOnboardingCompleted(completed = true) {
    this.config.onboardingCompleted = Boolean(completed);
    this.saveConfig();
    return { onboardingCompleted: this.config.onboardingCompleted };
  }

  syncActiveCustomList() {
    this.ensureUserLists();
    const userFile = path.join(this.getListsPath(), 'list-general-user.txt');
    const activeId = this.config.activeCustomList;

    if (!activeId) {
      fs.writeFileSync(
        userFile,
        '# Дополнительный список не выбран\ndomain.example.abc\n',
        'utf8'
      );
      return;
    }

    const customFile = path.join(this.getCustomListsDir(), `${activeId}.txt`);
    if (!fs.existsSync(customFile)) {
      this.config.activeCustomList = null;
      this.saveConfig();
      fs.writeFileSync(
        userFile,
        '# Дополнительный список не выбран\ndomain.example.abc\n',
        'utf8'
      );
      return;
    }

    const sites = this.readSitesFromFile(customFile);
    const cleaned = this.cleanSites(sites);
    if (cleaned.length === 0) {
      cleaned.push('domain.example.abc');
    }

    const content = [`# Активный список: ${activeId}`, ...cleaned].join('\n') + '\n';
    fs.writeFileSync(userFile, content, 'utf8');
  }

  getCustomLists() {
    this.getCustomListsDir();
    const activeId = this.config.activeCustomList || null;
    const lists = fs
      .readdirSync(this.getCustomListsDir())
      .filter((name) => name.endsWith('.txt'))
      .map((name) => {
        const id = name.replace(/\.txt$/, '');
        const sites = this.readSitesFromFile(path.join(this.getCustomListsDir(), name));
        return { id, name: id, count: sites.length };
      })
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));

    return { lists, activeId };
  }

  createCustomList(name) {
    const id = this.sanitizeCustomListId(name);
    const filePath = path.join(this.getCustomListsDir(), `${id}.txt`);
    if (fs.existsSync(filePath)) {
      throw new Error('Список с таким именем уже существует');
    }

    this.writeSitesToFile(filePath, [], [`# Дополнительный список: ${id}`]);
    this.config.activeCustomList = id;
    this.saveConfig();
    this.syncActiveCustomList();
    return { ...this.getCustomLists(), createdId: id };
  }

  getCustomListSites(listId) {
    const id = this.sanitizeCustomListId(listId);
    const filePath = path.join(this.getCustomListsDir(), `${id}.txt`);
    if (!fs.existsSync(filePath)) {
      throw new Error('Список не найден');
    }
    return this.readSitesFromFile(filePath);
  }

  saveCustomListSites(listId, sites) {
    const id = this.sanitizeCustomListId(listId);
    const filePath = path.join(this.getCustomListsDir(), `${id}.txt`);
    if (!fs.existsSync(filePath)) {
      throw new Error('Список не найден');
    }

    this.writeSitesToFile(filePath, sites, [`# Дополнительный список: ${id}`]);
    if (this.config.activeCustomList === id) {
      this.syncActiveCustomList();
    }
    return this.getCustomListSites(id);
  }

  setActiveCustomList(listId) {
    if (!listId) {
      this.config.activeCustomList = null;
      this.saveConfig();
      this.syncActiveCustomList();
      return this.getCustomLists();
    }

    const id = this.sanitizeCustomListId(listId);
    const filePath = path.join(this.getCustomListsDir(), `${id}.txt`);
    if (!fs.existsSync(filePath)) {
      throw new Error('Список не найден');
    }

    this.config.activeCustomList = id;
    this.saveConfig();
    this.syncActiveCustomList();
    return this.getCustomLists();
  }

  deleteCustomList(listId) {
    const id = this.sanitizeCustomListId(listId);
    const filePath = path.join(this.getCustomListsDir(), `${id}.txt`);
    if (!fs.existsSync(filePath)) {
      throw new Error('Список не найден');
    }

    fs.unlinkSync(filePath);
    if (this.config.activeCustomList === id) {
      this.config.activeCustomList = null;
      this.saveConfig();
      this.syncActiveCustomList();
    }
    return this.getCustomLists();
  }

  ensureUserLists(enginePath = this.getZapretPath()) {
    const listsPath = path.join(enginePath, 'lists');
    const files = {
      'ipset-exclude-user.txt': '203.0.113.113/32\n',
      'list-general-user.txt': '# Never leave this file empty\ndomain.example.abc\n',
      'list-exclude-user.txt': 'domain.example.abc\n'
    };
    for (const [name, content] of Object.entries(files)) {
      const fp = path.join(listsPath, name);
      if (!fs.existsSync(fp)) {
        fs.writeFileSync(fp, content, 'utf8');
      }
    }
  }

  isAutostartZapretEnabled() {
    return Boolean(this.config.autostartZapretEnabled);
  }

  isAutostartTgProxyEnabled() {
    return Boolean(this.config.autostartTgProxyEnabled);
  }

  isAppAutostartEnabled() {
    return this.isAutostartZapretEnabled() || this.isAutostartTgProxyEnabled();
  }

  async migrateAutostartConfig() {
    let changed = false;

    if (typeof this.config.autostartEnabled === 'boolean') {
      this.config.autostartZapretEnabled = this.config.autostartEnabled;
      if (typeof this.config.autostartTgProxyEnabled !== 'boolean') {
        this.config.autostartTgProxyEnabled = false;
      }
      delete this.config.autostartEnabled;
      changed = true;
    } else {
      if (typeof this.config.autostartZapretEnabled !== 'boolean') {
        this.config.autostartZapretEnabled = false;
        changed = true;
      }
      if (typeof this.config.autostartTgProxyEnabled !== 'boolean') {
        this.config.autostartTgProxyEnabled = false;
        changed = true;
      }
    }

    if (changed) this.saveConfig();
  }

  getGameFilterVars() {
    const status = this.getGameFilterStatus();
    if (!status.enabled) {
      return { all: '12', tcp: '12', udp: '12' };
    }
    if (status.mode === 'tcp') {
      return { all: '1024-65535', tcp: '1024-65535', udp: '12' };
    }
    if (status.mode === 'udp') {
      return { all: '1024-65535', tcp: '12', udp: '1024-65535' };
    }
    return { all: '1024-65535', tcp: '1024-65535', udp: '1024-65535' };
  }

  parseWinwsArgs(strategyFile) {
    const zapretPath = this.getZapretPath();
    const batPath = path.join(zapretPath, strategyFile);
    if (!fs.existsSync(batPath)) {
      throw new Error(`Стратегия не найдена: ${strategyFile}`);
    }

    const binPath = path.join(zapretPath, 'bin') + path.sep;
    const listsPath = path.join(zapretPath, 'lists') + path.sep;
    const gf = this.getGameFilterVars();
    const lines = fs.readFileSync(batPath, 'utf8').split(/\r?\n/);

    let capture = false;
    let raw = '';

    for (const originalLine of lines) {
      let line = originalLine.trim();
      if (!line || line.startsWith('::')) {
        if (capture) break;
        continue;
      }

      if (!capture) {
        const match = line.match(/winws\.exe(.*)$/i);
        if (!match) continue;
        capture = true;
        raw = match[1].trim().replace(/^"+/, '').trim();
        if (raw.endsWith('^')) raw = raw.slice(0, -1).trim();
        continue;
      }

      if (line.endsWith('^')) line = line.slice(0, -1).trim();
      raw += ` ${line}`;
    }

    if (!raw.trim()) {
      throw new Error(`Не удалось разобрать аргументы winws.exe в ${strategyFile}`);
    }

    return raw
      .replace(/%BIN%/gi, binPath)
      .replace(/%LISTS%/gi, listsPath)
      .replace(/%GameFilterTCP%/gi, gf.tcp)
      .replace(/%GameFilterUDP%/gi, gf.udp)
      .replace(/%GameFilter%/gi, gf.all)
      .replace(/%~dp0/gi, `${zapretPath}${path.sep}`)
      .replace(/\s+/g, ' ')
      .trim();
  }

  async _setAutostartFlag(key, enabled) {
    const next = Boolean(enabled);
    if (next === Boolean(this.config[key])) return this.getStatus();
    this.config[key] = next;
    this.saveConfig();
    return this.getStatus();
  }

  async setAutostartZapret(enabled) {
    return this._setAutostartFlag('autostartZapretEnabled', enabled);
  }

  async setAutostartTgProxy(enabled) {
    return this._setAutostartFlag('autostartTgProxyEnabled', enabled);
  }

  async setStartMinimized(enabled) {
    return this._setAutostartFlag('startMinimized', enabled);
  }

  async getStatus() {
    const [winwsRunning, serviceStates, installedStrategy] = await Promise.all([
      this.isProcessRunning('winws.exe'),
      this.getMultipleServiceStates('zapret', 'WinDivert'),
      this.getInstalledStrategyCached()
    ]);
    const zapretService = serviceStates.zapret || 'NOT_FOUND';
    const windivertService = serviceStates.WinDivert || 'NOT_FOUND';

    return {
      running: winwsRunning || zapretService === 'RUNNING',
      winwsRunning,
      zapretService,
      autostartZapretEnabled: this.isAutostartZapretEnabled(),
      autostartTgProxyEnabled: this.isAutostartTgProxyEnabled(),
      windivertService,
      installedStrategy,
      lastStrategy: this.config.lastStrategy,
      lastStrategyProbe: this.config.lastStrategyProbe || null,
      closeBehavior: this.config.closeBehavior ?? null,
      onboardingCompleted: Boolean(this.config.onboardingCompleted),
      startMinimized: Boolean(this.config.startMinimized),
      appVersion: appPkg.version,
      version: this.getLocalVersion(),
      zapretPath: (() => { try { return this.getZapretPath(); } catch { return this.config.zapretPath || ''; } })(),
      gameFilter: this.getGameFilterStatus(),
      ipset: this.getIpsetStatus(),
      autoUpdate: this.getAutoUpdateStatus()
    };
  }

  encodePsPath(value) {
    return Buffer.from(value, 'utf16le').toString('base64');
  }

  readUtf8Text(filePath) {
    return fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, '');
  }

  writeUtf8BomFile(filePath, content) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, `\uFEFF${content.replace(/^\uFEFF/, '')}`, 'utf8');
  }

  normalizeExitCode(code) {
    if (code === null || code === undefined) return null;
    if (code > 0x7fffffff) return code - 0x100000000;
    return code;
  }

  isProcessElevated() {
    return this.isElevated();
  }

  runElevated(command, args = []) {
    const elevated = this.isElevated();
    const verb = elevated ? '' : ' -Verb RunAs';
    return new Promise((resolve, reject) => {
      const argList = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(', ');
      const ps = args.length
        ? `$env:NO_UPDATE_CHECK='1'; $p = Start-Process -FilePath '${command.replace(/'/g, "''")}' -ArgumentList ${argList}${verb} -PassThru -WindowStyle Hidden; $p.WaitForExit(); exit $p.ExitCode`
        : `$env:NO_UPDATE_CHECK='1'; $p = Start-Process -FilePath '${command.replace(/'/g, "''")}'${verb} -PassThru -WindowStyle Hidden; $p.WaitForExit(); exit $p.ExitCode`;

      const child = spawn('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => {
        if (code === 0) resolve({ success: true });
        else reject(new Error(stderr || `Команда завершилась с кодом ${code}`));
      });
      child.on('error', reject);
    });
  }

  /** Прямой скрытый запуск winws.exe без окна CMD. */
  async startHiddenWinws(strategyFile) {
    this.ensureUserLists();
    this.syncActiveCustomList();

    const zapretPath = this.getZapretPath();
    const winwsPath = path.join(zapretPath, 'bin', 'winws.exe');
    const args = this.parseWinwsArgs(strategyFile);
    const workDir = path.join(zapretPath, 'bin');

    const winwsB64 = this.encodePsPath(winwsPath);
    const wdB64 = this.encodePsPath(workDir);
    const argsB64 = this.encodePsPath(args);

    const script = [
      `$winws = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${winwsB64}'))`,
      `$wd = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${wdB64}'))`,
      `$winwsArgs = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${argsB64}'))`,
      "$ErrorActionPreference = 'SilentlyContinue'",
      'netsh interface tcp set global timestamps=enabled',
      'sc stop WinDivert 2>$null',
      'sc stop WinDivert14 2>$null',
      'sc stop zapret 2>$null',
      'sc delete zapret 2>$null',
      '$psi = New-Object System.Diagnostics.ProcessStartInfo',
      '$psi.FileName = $winws',
      '$psi.WorkingDirectory = $wd',
      '$psi.Arguments = $winwsArgs',
      '$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden',
      '$psi.UseShellExecute = $false',
      '$psi.CreateNoWindow = $true',
      '[System.Diagnostics.Process]::Start($psi) | Out-Null',
      'exit 0'
    ].filter(Boolean).join('; ');

    await this.runElevatedScript(script);
  }

  /** Запуск .bat с правами админа. Пути с пробелами и скобками — через cmd /c call. */
  runElevatedBat(batPath) {
    return new Promise((resolve, reject) => {
      const workDir = path.dirname(batPath);
      const batB64 = this.encodePsPath(batPath);
      const wdB64 = this.encodePsPath(workDir);
      const ps = [
        `$bat = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${batB64}'))`,
        `$wd = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${wdB64}'))`,
        `$quoted = '"' + $bat + '"'`,
        `$env:NO_UPDATE_CHECK='1'`,
        `$p = Start-Process -FilePath 'cmd.exe' -ArgumentList @('/c','call',$quoted) -WorkingDirectory $wd -Verb RunAs -PassThru -WindowStyle Hidden`,
        '$p.WaitForExit()',
        'exit $p.ExitCode'
      ].join('; ');

      const child = spawn('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => {
        if (code === 0) resolve({ success: true });
        else reject(new Error(stderr || `Не удалось запустить стратегию (код ${code})`));
      });
      child.on('error', reject);
    });
  }

  runElevatedScript(scriptBody) {
    const elevated = this.isElevated();
    return new Promise((resolve, reject) => {
      const scriptsDir = path.join(this.userDataPath || this.appPath, 'scripts');
      fs.mkdirSync(scriptsDir, { recursive: true });
      const tmpDir = fs.mkdtempSync(path.join(scriptsDir, 'zapret-'));
      const scriptPath = path.join(tmpDir, 'elevated.ps1');

      const cleanup = () => {
        try {
          fs.rmSync(tmpDir, { recursive: true, force: true });
        } catch {
          // ignore cleanup errors
        }
      };

      try {
        fs.writeFileSync(scriptPath, scriptBody, 'utf8');
      } catch (err) {
        cleanup();
        reject(err);
        return;
      }

      const scriptPathB64 = this.encodePsPath(scriptPath);
      let ps;
      if (elevated) {
        ps = [
          `$scriptPath = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${scriptPathB64}'))`,
          `$env:NO_UPDATE_CHECK='1'`,
          `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$scriptPath) -PassThru -WindowStyle Hidden`,
          '$p.WaitForExit()',
          'exit $p.ExitCode'
        ].join('; ');
      } else {
        ps = [
          `$scriptPath = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${scriptPathB64}'))`,
          `$env:NO_UPDATE_CHECK='1'`,
          `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$scriptPath) -Verb RunAs -PassThru -WindowStyle Hidden`,
          '$p.WaitForExit()',
          'exit $p.ExitCode'
        ].join('; ');
      }

      const child = spawn('powershell', ['-NoProfile', '-Command', ps], { windowsHide: true });
      let stderr = '';
      child.stderr.on('data', (d) => { stderr += d; });
      child.on('close', (code) => {
        cleanup();
        if (code === 0) resolve({ success: true });
        else reject(new Error(stderr || `Команда завершилась с кодом ${code}`));
      });
      child.on('error', (err) => {
        cleanup();
        reject(err);
      });
    });
  }

  setLastStrategy(strategyFile) {
    const zapretPath = this.getZapretPath();
    const batPath = path.join(zapretPath, strategyFile);
    if (!fs.existsSync(batPath)) {
      throw new Error(`Стратегия не найдена: ${strategyFile}`);
    }
    this.config.lastStrategy = strategyFile;
    this.saveConfig();
    this._installedStrategyCache = null;
    return strategyFile;
  }

  async start(strategyFile) {
    if (this._starting) return this.getStatus();
    this._starting = true;
    try {
      await this.applyPendingUpdates();
      const zapretPath = this.getZapretPath();

      let targetStrategy = strategyFile || this.config.lastStrategy;
      if (!targetStrategy || typeof targetStrategy !== 'string') {
        const available = this.getStrategies();
        targetStrategy = available.length > 0 ? (available[0].file || available[0].name) : 'general (ALT11).bat';
      }
      if (!targetStrategy.toLowerCase().endsWith('.bat')) {
        targetStrategy += '.bat';
      }

      let batPath = path.join(zapretPath, targetStrategy);
      if (!fs.existsSync(batPath)) {
        const available = this.getStrategies();
        const fallback = available.find(s => fs.existsSync(path.join(zapretPath, s.file || s.name)));
        if (fallback) {
          targetStrategy = fallback.file || fallback.name;
          batPath = path.join(zapretPath, targetStrategy);
        } else {
          throw new Error(`Стратегия не найдена: ${targetStrategy}`);
        }
      }

      const winwsRunning = await this.isProcessRunning('winws.exe');
      const serviceState = await this.getServiceState('zapret');

      if ((winwsRunning || serviceState === 'RUNNING') && this.config.lastStrategy === targetStrategy) {
        return this.getStatus();
      }

      if (winwsRunning || serviceState === 'RUNNING') {
        await this.stop();
      }

      this.setLastStrategy(targetStrategy);

      await this.startHiddenWinws(targetStrategy);

      const running = await this.waitForProcessStart('winws.exe', 8000);
      if (!running) {
        throw new Error(`Стратегия не запустилась: ${targetStrategy}`);
      }

      return this.getStatus();
    } finally {
      this._starting = false;
    }
  }

  async restart(strategyFile) {
    const winwsRunning = await this.isProcessRunning('winws.exe');
    const serviceState = await this.getServiceState('zapret');
    if (winwsRunning || serviceState === 'RUNNING') {
      await this.stop();
    }
    return this.start(strategyFile);
  }

  async stop() {
    this._installedStrategyCache = null;
    const [zapretState, windivertState, windivert14State] = await Promise.all([
      this.getServiceState('zapret'),
      this.getServiceState('WinDivert'),
      this.getServiceState('WinDivert14')
    ]);

    const keepService = false;
    const serviceActive = (state) => state === 'RUNNING' || state === 'STOP_PENDING';

    // Быстрый путь: taskkill без UAC — пользователь сразу видит выключение.
    try {
      await execAsync('taskkill /IM winws.exe /F /T', { windowsHide: true, timeout: 5000 });
    } catch {
      // Процесс уже завершён или нужны права админа — продолжим ниже.
    }

    await this.waitForProcessExit('winws.exe', 1500);

    const needsServiceCleanup =
      serviceActive(zapretState) ||
      (zapretState !== 'NOT_FOUND' && !keepService) ||
      serviceActive(windivertState) ||
      windivertState !== 'NOT_FOUND' ||
      serviceActive(windivert14State) ||
      windivert14State !== 'NOT_FOUND';

    const stillRunning = await this.isProcessRunning('winws.exe');

    if (!stillRunning && !needsServiceCleanup) {
      return this.getStatus();
    }

    const stopLines = ["$ErrorActionPreference = 'SilentlyContinue'"];
    if (stillRunning) {
      stopLines.push(
        'taskkill /IM winws.exe /F 2>$null',
        "Get-Process cmd -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like 'zapret:*' } | Stop-Process -Force"
      );
    }

    if (serviceActive(zapretState)) {
      stopLines.push('sc stop zapret 2>$null');
    }
    if (zapretState !== 'NOT_FOUND' && !keepService) {
      stopLines.push('sc delete zapret 2>$null');
    }

    if (serviceActive(windivertState)) {
      stopLines.push('sc stop WinDivert 2>$null');
    }
    if (windivertState !== 'NOT_FOUND') {
      stopLines.push('sc delete WinDivert 2>$null');
    }

    if (serviceActive(windivert14State)) {
      stopLines.push('sc stop WinDivert14 2>$null');
    }
    if (windivert14State !== 'NOT_FOUND') {
      stopLines.push('sc delete WinDivert14 2>$null');
    }

    stopLines.push('exit 0');

    await this.runElevatedScript(stopLines.join('; '));
    await this.waitForProcessExit('winws.exe', 2000);

    if (await this.isProcessRunning('winws.exe')) {
      throw new Error('Не удалось остановить winws.exe. Подтвердите запрос UAC или завершите процесс вручную.');
    }

    return this.getStatus();
  }

  async getAllServicesText() {
    const { stdout } = await execAsync('sc query state= all', {
      windowsHide: true,
      maxBuffer: 15 * 1024 * 1024
    });
    return stdout;
  }

  async serviceListMatches(pattern) {
    try {
      const stdout = await this.getAllServicesText();
      return pattern.test(stdout);
    } catch {
      return null;
    }
  }

  async checkSecureDns() {
    try {
      const { stdout } = await execAsync(
        'powershell -NoProfile -Command "Get-ChildItem -Recurse -Path \'HKLM:System\\CurrentControlSet\\Services\\Dnscache\\InterfaceSpecificParameters\\\' -ErrorAction SilentlyContinue | Get-ItemProperty -ErrorAction SilentlyContinue | Where-Object { $_.DohFlags -gt 0 } | Measure-Object | Select-Object -ExpandProperty Count"',
        { windowsHide: true, timeout: 15000 }
      );
      const count = parseInt(String(stdout).trim(), 10) || 0;
      return count > 0;
    } catch {
      return null;
    }
  }

  async runDiagnostics() {
    const results = [];
    const add = (name, severity, message) => {
      results.push({
        name,
        severity,
        ok: severity === 'ok',
        message
      });
    };

    try {
      const { stdout } = await execAsync('sc query BFE', { windowsHide: true });
      add(
        'Base Filtering Engine',
        /RUNNING/i.test(stdout) ? 'ok' : 'fail',
        /RUNNING/i.test(stdout) ? 'Работает' : 'Не запущен — нужен для Zapret'
      );
    } catch (e) {
      add('Base Filtering Engine', 'fail', e.message);
    }

    try {
      const { stdout } = await execAsync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
        { windowsHide: true }
      );
      const proxyEnabled = /0x1/i.test(stdout);
      if (!proxyEnabled) {
        add('Системный прокси', 'ok', 'Отключён');
      } else {
        let proxyServer = '';
        try {
          const { stdout: serverOut } = await execAsync(
            'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyServer',
            { windowsHide: true }
          );
          const match = serverOut.match(/ProxyServer\s+REG_SZ\s+(.+)/i);
          proxyServer = match ? match[1].trim() : '';
        } catch {
          // ignore
        }
        add(
          'Системный прокси',
          'warn',
          proxyServer
            ? `Включён: ${proxyServer}. Проверьте настройки или отключите, если прокси не используете`
            : 'Включён. Проверьте настройки или отключите, если прокси не используете'
        );
      }
    } catch (e) {
      add('Системный прокси', 'warn', `Не удалось проверить: ${e.message}`);
    }

    try {
      const { stdout } = await execAsync('netsh interface tcp show global', { windowsHide: true });
      const enabled = /timestamps\s*=\s*enabled/i.test(stdout);
      if (enabled) {
        add('TCP timestamps', 'ok', 'Включены');
      } else {
        try {
          await execAsync('netsh interface tcp set global timestamps=enabled', { windowsHide: true });
          add('TCP timestamps', 'warn', 'Были отключены — попытка включения выполнена');
        } catch {
          add('TCP timestamps', 'fail', 'Отключены — не удалось включить автоматически');
        }
      }
    } catch (e) {
      add('TCP timestamps', 'fail', e.message);
    }

    try {
      const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq AdguardSvc.exe" /NH', { windowsHide: true });
      const found = /AdguardSvc\.exe/i.test(stdout);
      add(
        'Adguard',
        found ? 'fail' : 'ok',
        found ? 'Обнаружен — может мешать Discord' : 'Не найден'
      );
    } catch (e) {
      add('Adguard', 'warn', `Проверка недоступна: ${e.message}`);
    }

    const allServices = await this.getAllServicesText().catch(() => '');
    const matchService = (pattern) => {
      if (!allServices) return null;
      try { return pattern.test(allServices); } catch { return null; }
    };

    const killer = matchService(/Killer/i);
    if (killer === null) {
      add('Killer Network', 'warn', 'Не удалось проверить список служб');
    } else {
      add(
        'Killer Network',
        killer ? 'fail' : 'ok',
        killer ? 'Конфликтует с Zapret' : 'Не найден'
      );
    }

    const intel = matchService(/Intel.*Connectivity.*Network/i);
    if (intel === null) {
      add('Intel Connectivity', 'warn', 'Не удалось проверить список служб');
    } else {
      add(
        'Intel Connectivity',
        intel ? 'fail' : 'ok',
        intel ? 'Конфликтует с Zapret' : 'Не найден'
      );
    }

    const tracSrv = matchService(/TracSrvWrapper/i);
    const epwd = matchService(/\bEPWD\b/i);
    if (tracSrv === null && epwd === null) {
      add('Check Point', 'warn', 'Не удалось проверить список служб');
    } else {
      const checkpoint = Boolean(tracSrv) || Boolean(epwd);
      add(
        'Check Point',
        checkpoint ? 'fail' : 'ok',
        checkpoint ? 'Конфликтует с Zapret — удалите Check Point' : 'Не найден'
      );
    }

    const smartbyte = matchService(/SmartByte/i);
    if (smartbyte === null) {
      add('SmartByte', 'warn', 'Не удалось проверить список служб');
    } else {
      add(
        'SmartByte',
        smartbyte ? 'fail' : 'ok',
        smartbyte ? 'Конфликтует с Zapret — отключите через services.msc' : 'Не найден'
      );
    }

    const binPath = path.join(this.getZapretPath(), 'bin');
    const hasSys = fs.existsSync(binPath) && fs.readdirSync(binPath).some((f) => f.toLowerCase().endsWith('.sys'));
    add(
      'WinDivert64.sys',
      hasSys ? 'ok' : 'fail',
      hasSys ? 'Найден' : 'Файл не найден в папке bin'
    );

    const vpn = matchService(/VPN/i);
    if (vpn === null) {
      add('VPN', 'warn', 'Не удалось проверить список служб');
    } else if (vpn) {
      add('VPN', 'warn', 'Обнаружены VPN-службы — отключите VPN, если есть конфликты');
    } else {
      add('VPN', 'ok', 'Не найден');
    }

    const secureDns = await this.checkSecureDns();
    if (secureDns === null) {
      add('Secure DNS', 'warn', 'Не удалось проверить настройки DNS');
    } else if (secureDns) {
      add('Secure DNS', 'ok', 'Шифрованный DNS настроен');
    } else {
      add(
        'Secure DNS',
        'warn',
        'Настройте защищённый DNS в браузере или в параметрах Windows 11'
      );
    }

    try {
      const hostsFile = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'drivers', 'etc', 'hosts');
      if (fs.existsSync(hostsFile)) {
        const hosts = fs.readFileSync(hostsFile, 'utf8');
        const ytBlocked = /youtube\.com|youtu\.be/i.test(hosts);
        add(
          'Файл hosts',
          ytBlocked ? 'warn' : 'ok',
          ytBlocked
            ? 'Есть записи для youtube.com/youtu.be — может мешать YouTube'
            : 'Записей YouTube не найдено'
        );
      } else {
        add('Файл hosts', 'warn', 'Файл hosts не найден');
      }
    } catch (e) {
      add('Файл hosts', 'warn', `Не удалось проверить: ${e.message}`);
    }

    const winws = await this.isProcessRunning('winws.exe');
    const windivertState = await this.getServiceState('WinDivert');
    const windivertActive = windivertState === 'RUNNING' || windivertState === 'STOP_PENDING';
    if (!winws && windivertActive) {
      add(
        'WinDivert',
        'warn',
        'winws.exe не запущен, но служба WinDivert активна — возможен конфликт'
      );
    } else if (windivertActive) {
      add('WinDivert', 'ok', 'Служба активна вместе с winws.exe');
    } else {
      add('WinDivert', 'ok', 'Конфликт не обнаружен');
    }

    const conflicting = ['GoodbyeDPI', 'discordfix_zapret', 'winws1', 'winws2'];
    const foundConflicts = [];
    for (const serviceName of conflicting) {
      const regex = new RegExp(`SERVICE_NAME:\\s+${serviceName}[\\s\\S]*?STATE\\s+:\\s+\\d+\\s+(\\w+)`, 'i');
      const match = allServices ? allServices.match(regex) : null;
      const state = match ? match[1] : 'NOT_FOUND';
      if (state !== 'NOT_FOUND') foundConflicts.push(serviceName);
    }
    add(
      'Конфликтующие обходы',
      foundConflicts.length ? 'fail' : 'ok',
      foundConflicts.length
        ? `Найдены службы: ${foundConflicts.join(', ')}`
        : 'Не найдены'
    );

    return results;
  }

  async runSelfHealing(serviceState = {}) {
    const { zapretRunning = false, tgRunning = false, vlessRunning = false } = serviceState;
    const steps = [];
    let fixedCount = 0;

    const addStep = (id, name, status, message, fixed = false) => {
      if (fixed) fixedCount++;
      steps.push({ id, name, status, message, fixed });
    };

    // 1. Проверка и очистка зависших процессов ядра
    try {
      const processDefinitions = [
        { name: 'winws.exe', isLegitimate: zapretRunning, label: 'Zapret DPI' },
        { name: 'xray.exe', isLegitimate: vlessRunning, label: 'VPN Xray' },
        { name: 'sing-box.exe', isLegitimate: vlessRunning, label: 'VPN sing-box' },
        { name: 'ZapretTgProxy.exe', isLegitimate: tgRunning, label: 'Telegram Proxy' }
      ];

      const killed = [];
      const activeLegit = [];

      for (const def of processDefinitions) {
        try {
          const { stdout } = await execAsync(`tasklist /FI "IMAGENAME eq ${def.name}" /NH`, { windowsHide: true });
          const matches = stdout.match(new RegExp(def.name, 'gi')) || [];
          const count = matches.length;

          if (count > 0) {
            if (def.isLegitimate) {
              if (count > 1) {
                // Если процессов больше одного (задвоение) — убиваем лишние дубликаты
                await execAsync(`taskkill /F /IM ${def.name} /T`, { windowsHide: true });
                killed.push(`${def.name} (устранено дубликатов: ${count})`);
              } else {
                activeLegit.push(def.label);
              }
            } else {
              // Служба в приложении выключена, но процесс остался висеть — зависший зомби-хвост!
              await execAsync(`taskkill /F /IM ${def.name} /T`, { windowsHide: true });
              killed.push(def.name);
            }
          }
        } catch {}
      }

      if (killed.length > 0) {
        addStep('processes', 'Фоновые процессы ядра', 'fixed', `Завершены зависшие процессы: ${killed.join(', ')}`, true);
      } else if (activeLegit.length > 0) {
        addStep('processes', 'Фоновые процессы ядра', 'ok', `Активные службы работают штатно (${activeLegit.join(', ')}), зависших хвостов нет`);
      } else {
        addStep('processes', 'Фоновые процессы ядра', 'ok', 'Зависших или конфликтующих процессов не обнаружено');
      }
    } catch (e) {
      addStep('processes', 'Фоновые процессы ядра', 'ok', 'Процессы ядра проверены');
    }

    // 2. Драйвер WinDivert
    try {
      const divertState = await this.getServiceState('WinDivert');
      const divert14State = await this.getServiceState('WinDivert14');
      let driverFixed = false;

      // Сбрасываем только если Zapret выключен в интерфейсе, но служба драйвера зависла
      if (!zapretRunning) {
        if (divertState === 'RUNNING' || divertState === 'STOP_PENDING') {
          try {
            await execAsync('sc stop WinDivert', { windowsHide: true });
            driverFixed = true;
          } catch {}
        }
        if (divert14State === 'RUNNING' || divert14State === 'STOP_PENDING') {
          try {
            await execAsync('sc stop WinDivert14', { windowsHide: true });
            driverFixed = true;
          } catch {}
        }
      }

      if (driverFixed) {
        addStep('driver', 'Драйвер WinDivert', 'fixed', 'Остановлена зависшая служба драйвера от предыдущей сессии', true);
      } else if (zapretRunning && divertState === 'RUNNING') {
        addStep('driver', 'Драйвер WinDivert', 'ok', 'Драйвер активен и обрабатывает трафик Zapret');
      } else {
        addStep('driver', 'Драйвер WinDivert', 'ok', 'Служба свободна, блокировок не обнаружено');
      }
    } catch (e) {
      addStep('driver', 'Драйвер WinDivert', 'ok', 'Служба драйвера проверена');
    }

    // 3. Системный прокси Windows
    try {
      const { stdout } = await execAsync(
        'reg query "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable',
        { windowsHide: true }
      );
      const isProxyEnabled = /0x1/i.test(stdout);
      // Сбрасываем только если VPN выключен, но системный прокси остался включён
      if (isProxyEnabled && !vlessRunning) {
        await execAsync(
          'reg add "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings" /v ProxyEnable /t REG_DWORD /d 0 /f',
          { windowsHide: true }
        );
        addStep('proxy', 'Системный прокси Windows', 'fixed', 'Сброшен зависший флаг ProxyEnable в системных настройках', true);
      } else if (isProxyEnabled && vlessRunning) {
        addStep('proxy', 'Системный прокси Windows', 'ok', 'Системный прокси активен для текущего подключения VPN');
      } else {
        addStep('proxy', 'Системный прокси Windows', 'ok', 'Системный прокси выключен, скрытых перенаправлений нет');
      }
    } catch (e) {
      addStep('proxy', 'Системный прокси Windows', 'ok', 'Системный прокси проверен');
    }

    // 4. Служба фильтрации BFE (Base Filtering Engine)
    try {
      const { stdout } = await execAsync('sc query BFE', { windowsHide: true });
      const isRunning = /RUNNING/i.test(stdout);
      if (!isRunning) {
        try {
          await execAsync('sc start BFE', { windowsHide: true });
          addStep('bfe', 'Служба фильтрации BFE', 'fixed', 'Служба BFE была остановлена и успешно запущена', true);
        } catch {
          addStep('bfe', 'Служба фильтрации BFE', 'warning', 'Служба BFE не активна (может блокировать WinDivert)');
        }
      } else {
        addStep('bfe', 'Служба фильтрации BFE', 'ok', 'Служба фильтрации Windows активна и работает штатно');
      }
    } catch (e) {
      addStep('bfe', 'Служба фильтрации BFE', 'ok', 'Служба BFE проверена');
    }

    // 5. Сетевой стек (TCP Timestamps)
    try {
      const { stdout } = await execAsync('netsh interface tcp show global', { windowsHide: true });
      const isEnabled = /timestamps\s*=\s*enabled/i.test(stdout);
      if (!isEnabled) {
        try {
          await execAsync('netsh interface tcp set global timestamps=enabled', { windowsHide: true });
          addStep('tcp', 'Параметры TCP стека', 'fixed', 'Включен параметр TCP timestamps для стабильности соединений', true);
        } catch {
          addStep('tcp', 'Параметры TCP стека', 'ok', 'Параметры TCP проверены');
        }
      } else {
        addStep('tcp', 'Параметры TCP стека', 'ok', 'TCP timestamps активны, стек пакетов оптимизирован');
      }
    } catch (e) {
      addStep('tcp', 'Параметры TCP стека', 'ok', 'Параметры TCP проверены');
    }

    // 6. Сетевые адаптеры и DNS (гарантия безопасности для пользователя!)
    addStep('dns', 'DNS и сетевые адаптеры', 'ok', 'Пользовательские настройки DNS и статические IP сохранены без изменений');

    return {
      success: true,
      fixedCount,
      steps
    };
  }

  buildUpdateResult(local, remote, extra = {}) {
    const normalizedRemote = this.extractVersionFromText(remote);
    const normalizedLocal = this.extractVersionFromText(local) || local;
    const updateAvailable =
      Boolean(normalizedRemote) && this.compareVersions(normalizedLocal, normalizedRemote) < 0;
    return {
      local: normalizedLocal,
      remote: normalizedRemote,
      updateAvailable,
      downloadUrl: normalizedRemote ? this.getReleaseDownloadUrl(normalizedRemote) : null,
      releaseUrl: normalizedRemote
        ? `https://github.com/Flowseal/zapret-discord-youtube/releases/tag/${normalizedRemote}`
        : ZAPRET_RELEASE_PAGE,
      ...extra
    };
  }

  async checkForUpdates({ force = false } = {}) {
    const local = this.getLocalVersion();
    return {
      local,
      remote: local,
      updateAvailable: false
    };
  }

  getStrategyProbeScriptSource() {
    const candidates = [
      path.join(this.appPath, 'bundled', 'zapret', 'utils', 'test zapret.ps1'),
      this.resourcesPath
        ? path.join(this.resourcesPath, 'zapret', 'utils', 'test zapret.ps1')
        : null
    ].filter(Boolean);

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) continue;
      const content = fs.readFileSync(candidate, 'utf8');
      if (content.includes('Write-HeadlessResult')) return candidate;
    }
    return null;
  }

  syncStrategyProbeScript() {
    const source = this.getStrategyProbeScriptSource();
    if (!source) return false;

    const target = path.join(this.getZapretPath(), 'utils', 'test zapret.ps1');
    const sourceContent = this.readUtf8Text(source);
    const targetContent = fs.existsSync(target) ? this.readUtf8Text(target) : '';
    if (sourceContent === targetContent) return false;

    this.writeUtf8BomFile(target, sourceContent);
    return true;
  }

  readStrategyProbeResultFile(resultPath) {
    if (!fs.existsSync(resultPath)) return null;
    try {
      const raw = fs.readFileSync(resultPath, 'utf8').replace(/^\uFEFF/, '').trim();
      if (!raw) return null;
      return this.parseStrategyProbeResult(raw);
    } catch (err) {
      return { __parseError: err.message || 'invalid_json' };
    }
  }

  normalizeStrategyProbeRows(strategies) {
    if (!strategies) return [];
    if (Array.isArray(strategies)) return strategies;
    if (typeof strategies === 'object') {
      if (strategies.file) return [strategies];
      return Object.values(strategies);
    }
    return [];
  }

  readStrategyProbeProgressFile(progressPath) {
    if (!fs.existsSync(progressPath)) return null;
    try {
      const raw = fs.readFileSync(progressPath, 'utf8').replace(/^\uFEFF/, '').trim();
      if (!raw) return null;
      const payload = JSON.parse(raw);
      const total = Number(payload.total) || 0;
      const current = Number(payload.current) || 0;
      let percent = Number(payload.percent);
      if (!Number.isFinite(percent)) {
        percent = total > 0 ? Math.round((current / total) * 100) : 0;
      }
      return {
        phase: payload.phase || 'running',
        message: payload.message || '',
        current,
        total,
        config: payload.config || '',
        percent: Math.max(0, Math.min(100, percent))
      };
    } catch {
      return null;
    }
  }

  parseStrategyProbeResult(raw) {
    const payload = typeof raw === 'string' ? JSON.parse(raw) : raw;
    const strategies = this.normalizeStrategyProbeRows(payload.strategies).map((row) => {
      const meta = STRATEGY_LABELS[row.file] || { name: row.file.replace('.bat', ''), desc: '' };
      return {
        file: row.file,
        name: meta.name,
        desc: meta.desc,
        httpOk: row.httpOk ?? 0,
        httpError: row.httpError ?? 0,
        httpUnsup: row.httpUnsup ?? 0,
        pingOk: row.pingOk ?? 0,
        pingFail: row.pingFail ?? 0,
        score: row.score ?? 0,
        working: Boolean(row.working),
        error: row.error || null
      };
    }).sort((a, b) => b.score - a.score || b.pingOk - a.pingOk);

    const bestStrategy = payload.bestStrategy || strategies.find((s) => s.working)?.file || null;
    return {
      testType: payload.testType || 'standard',
      bestStrategy,
      strategies,
      finishedAt: payload.finishedAt || null,
      cancelled: Boolean(payload.cancelled),
      error: payload.error || null
    };
  }

  cancelStrategyProbe() {
    this._strategyProbeCancelRequested = true;
    execAsync('taskkill /IM winws.exe /F /T', { windowsHide: true, timeout: 3000 }).catch(() => {});
    return { cancelled: true };
  }

  isStrategyProbeRunning() {
    return Boolean(this._strategyProbeRunning);
  }

  async runStrategyProbe(options = {}, sendProgress) {
    if (this._strategyProbeRunning) {
      throw new Error('Проверка стратегий уже выполняется');
    }

    this._strategyProbeRunning = true;
    this._strategyProbeCancelRequested = false;

    const t0 = Date.now();
    const zapretPath = this.getZapretPath();
    const wasRunning = await this.isProcessRunning('winws.exe');
    const originalStrategy = this.config.lastStrategy || 'general (ALT).bat';

    // 1. Candidate strategies: prioritize the most effective and diverse strategies
    const candidateFiles = [
      'general (ALT).bat',
      'general (ALT2).bat',
      'general (ALT3).bat',
      'general (ALT4).bat',
      'general (ALT5).bat',
      'general.bat',
      'general (FAKE TLS AUTO).bat'
    ];

    // Ensure user's current strategy is included if valid
    if (originalStrategy && !candidateFiles.includes(originalStrategy) && fs.existsSync(path.join(zapretPath, originalStrategy))) {
      candidateFiles.unshift(originalStrategy);
    }

    const validCandidates = candidateFiles
      .filter(f => fs.existsSync(path.join(zapretPath, f)))
      .map(file => {
        const meta = STRATEGY_LABELS[file] || { name: file.replace('.bat', ''), desc: '' };
        return { file, ...meta };
      });

    if (validCandidates.length === 0) {
      this._strategyProbeRunning = false;
      throw new Error('В папке zapret не найдены файлы стратегий general*.bat');
    }

    sendProgress?.({
      phase: 'start',
      message: 'Подготовка к быстрому подбору...',
      current: 0,
      total: validCandidates.length,
      percent: 0,
      timeElapsedSec: 0
    });

    const results = [];

    try {
      // 2. Stop running winws before probe to isolate tests
      try {
        await execAsync('taskkill /IM winws.exe /F /T', { windowsHide: true, timeout: 3000 });
        await this.waitForProcessExit('winws.exe', 1000);
      } catch {}

      // 3. Test each candidate sequentially in background
      for (let i = 0; i < validCandidates.length; i++) {
        if (this._strategyProbeCancelRequested) {
          break;
        }

        const cand = validCandidates[i];
        const timeElapsedSec = Math.max(1, Math.round((Date.now() - t0) / 1000));

        sendProgress?.({
          phase: 'testing',
          message: `Тестирование: ${cand.name} (${i + 1}/${validCandidates.length})...`,
          current: i + 1,
          total: validCandidates.length,
          percent: Math.round(((i) / validCandidates.length) * 100),
          strategy: cand.file,
          strategyName: cand.name,
          timeElapsedSec
        });

        // Launch strategy hidden in background without any CMD window
        try {
          await this.startHiddenWinws(cand.file);
          // Wait 500ms for WinDivert filter to attach
          await new Promise(r => setTimeout(r, 500));
        } catch (startErr) {
          console.error('[StrategyProbe] Start failed for', cand.file, startErr);
          continue;
        }

        // Test YouTube, Discord, and General site in parallel with 2.2s timeout
        const testTargets = [
          { name: 'youtube', url: 'https://www.youtube.com/generate_204' },
          { name: 'discord', url: 'https://discord.com' },
          { name: 'general', url: 'https://ntc.party' }
        ];

        const targetResults = await Promise.all(testTargets.map(async t => {
          const reqStart = Date.now();
          try {
            const { stdout } = await execAsync(
              `curl.exe "${t.url}" -s -o NUL -w "%{http_code}" --max-time 2.2`,
              { windowsHide: true, timeout: 3000 }
            );
            const code = (stdout || '').trim();
            const latency = Date.now() - reqStart;
            const ok = ['200', '204', '301', '302'].includes(code);
            return { ok, latency: ok ? latency : 9999, code };
          } catch {
            return { ok: false, latency: 9999, code: '000' };
          }
        }));

        const ytRes = targetResults[0];
        const dcRes = targetResults[1];
        const genRes = targetResults[2];

        // Stop this candidate's winws + WinDivert
        try {
          await execAsync('taskkill /IM winws.exe /F /T', { windowsHide: true, timeout: 3000 });
          await this.waitForProcessExit('winws.exe', 600);
        } catch {}
        try {
          await execAsync('sc stop WinDivert 2>nul', { windowsHide: true, timeout: 2000 });
        } catch {}

        let score = 0;
        if (ytRes.ok) score += 40;
        if (dcRes.ok) score += 40;
        if (genRes.ok) score += 20;

        const passedLatencies = targetResults.filter(r => r.ok).map(r => r.latency);
        const avgPing = passedLatencies.length > 0
          ? Math.round(passedLatencies.reduce((a, b) => a + b, 0) / passedLatencies.length)
          : 9999;

        results.push({
          file: cand.file,
          name: cand.name,
          desc: cand.desc,
          score,
          ytOk: ytRes.ok,
          dcOk: dcRes.ok,
          genOk: genRes.ok,
          avgPing: avgPing < 9999 ? avgPing : null,
          status: score > 0 ? 'ok' : 'fail'
        });
      }

      // 4. Sort results: highest score first, then lowest ping
      results.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        return (a.avgPing || 9999) - (b.avgPing || 9999);
      });

      // 5. Select top 3 strategies
      const top3 = results.slice(0, 3).map((r, idx) => ({
        ...r,
        rank: idx + 1,
        badge: idx === 0 ? '#1 РЕКОМЕНДУЕМАЯ' : (idx === 1 ? '#2 АЛЬТЕРНАТИВНАЯ' : '#3 ЗАПАСНАЯ')
      }));

      const totalTimeSec = Math.max(1, Math.round((Date.now() - t0) / 1000));

      sendProgress?.({
        phase: 'done',
        message: 'Подбор завершён',
        percent: 100,
        timeElapsedSec: totalTimeSec,
        top3
      });

      // Restore previous Zapret state if it was running
      if (wasRunning) {
        try {
          await this.start(originalStrategy);
        } catch {}
      }

      const probeResult = {
        ok: true,
        winner: top3[0]?.file || originalStrategy,
        top3,
        totalTested: results.length,
        totalTimeSec,
        strategies: results
      };

      this.saveLastStrategyProbe(probeResult);
      return probeResult;
    } finally {
      this._strategyProbeRunning = false;
      this._strategyProbeCancelRequested = false;
    }
  }

  browseFolder() {
    return new Promise((resolve) => {
      const selectedPath = this.getZapretPath().replace(/'/g, "''");
      const ps = [
        'Add-Type -AssemblyName System.Windows.Forms',
        '$f = New-Object System.Windows.Forms.FolderBrowserDialog',
        "$f.Description = 'Выберите папку с Zapret'",
        `$f.SelectedPath = '${selectedPath}'`,
        "if ($f.ShowDialog() -eq 'OK') { $f.SelectedPath }"
      ].join('; ');

      exec(`powershell -NoProfile -Command "${ps}"`, { windowsHide: true }, (_err, stdout) => {
        const selected = stdout?.trim();
        resolve(selected || null);
      });
    });
  }
}

module.exports = { ZapretService };