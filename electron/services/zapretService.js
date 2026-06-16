const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { exec, spawn } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);

const VERSION_URL =
  'https://raw.githubusercontent.com/Flowseal/zapret-discord-youtube/main/.service/version.txt';
const RELEASE_BASE =
  'https://github.com/Flowseal/zapret-discord-youtube/releases/download';

const PRESERVE_RELATIVE_PATHS = [
  'lists/list-general.txt',
  'lists/list-general-user.txt',
  'lists/list-exclude-user.txt',
  'lists/ipset-exclude-user.txt',
  'lists/ipset-all.txt',
  'lists/ipset-all.txt.backup',
  'utils/game_filter.enabled'
];

const STRATEGY_LABELS = {
  'general.bat': { name: 'Основная', desc: 'Стандартная стратегия, подходит большинству' },
  'general (ALT).bat': { name: 'ALT', desc: 'Альтернативный метод обхода DPI' },
  'general (ALT2).bat': { name: 'ALT 2', desc: 'Вторая альтернатива' },
  'general (ALT3).bat': { name: 'ALT 3', desc: 'Третья альтернатива' },
  'general (ALT4).bat': { name: 'ALT 4', desc: 'Четвёртая альтернатива' },
  'general (ALT5).bat': { name: 'ALT 5', desc: 'Пятая альтернатива' },
  'general (ALT6).bat': { name: 'ALT 6', desc: 'Шестая альтернатива' },
  'general (ALT7).bat': { name: 'ALT 7', desc: 'Седьмая альтернатива' },
  'general (ALT8).bat': { name: 'ALT 8', desc: 'Восьмая альтернатива' },
  'general (ALT9).bat': { name: 'ALT 9', desc: 'Девятая альтернатива' },
  'general (ALT10).bat': { name: 'ALT 10', desc: 'Десятая альтернатива' },
  'general (ALT11).bat': { name: 'ALT 11', desc: 'Одиннадцатая альтернатива' },
  'general (ALT12).bat': { name: 'ALT 12', desc: 'Двенадцатая альтернатива' },
  'general (FAKE TLS AUTO).bat': { name: 'FAKE TLS AUTO', desc: 'Автоматический поддельный TLS' },
  'general (FAKE TLS AUTO ALT).bat': { name: 'FAKE TLS AUTO ALT', desc: 'FAKE TLS — альтернатива' },
  'general (FAKE TLS AUTO ALT2).bat': { name: 'FAKE TLS AUTO ALT 2', desc: 'FAKE TLS — альтернатива 2' },
  'general (FAKE TLS AUTO ALT3).bat': { name: 'FAKE TLS AUTO ALT 3', desc: 'FAKE TLS — альтернатива 3' },
  'general (SIMPLE FAKE).bat': { name: 'SIMPLE FAKE', desc: 'Простой поддельный пакет' },
  'general (SIMPLE FAKE ALT).bat': { name: 'SIMPLE FAKE ALT', desc: 'SIMPLE FAKE — альтернатива' },
  'general (SIMPLE FAKE ALT2).bat': { name: 'SIMPLE FAKE ALT 2', desc: 'SIMPLE FAKE — альтернатива 2' }
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

  ensurePackagedEngine() {
    const runtimePath = this.getRuntimeEnginePath();
    if (this.isValidEnginePath(runtimePath)) {
      return runtimePath;
    }

    const bundled = this.getBundledEnginePath();
    if (!bundled) {
      throw new Error('Встроенный движок Zapret не найден. Переустановите приложение.');
    }

    fs.mkdirSync(path.dirname(runtimePath), { recursive: true });
    fs.cpSync(bundled, runtimePath, { recursive: true, force: true });
    this.ensureUserLists(runtimePath);

    if (!this.isValidEnginePath(runtimePath)) {
      throw new Error('Не удалось развернуть движок Zapret в AppData.');
    }

    return runtimePath;
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
    const listsDir = path.join(this.getZapretPath(), 'lists');
    const listFile = path.join(listsDir, 'ipset-all.txt');
    const backupFile = path.join(listsDir, 'ipset-all.txt.backup');
    const current = this.getIpsetStatus().status;

    if (targetStatus === 'none' && current === 'loaded') {
      if (!fs.existsSync(backupFile)) {
        fs.renameSync(listFile, backupFile);
      } else {
        fs.unlinkSync(backupFile);
        fs.renameSync(listFile, backupFile);
      }
      fs.writeFileSync(listFile, '203.0.113.113/32\n', 'utf8');
    } else if (targetStatus === 'any' && current !== 'any') {
      fs.writeFileSync(listFile, '', 'utf8');
    } else if (targetStatus === 'loaded' && current === 'any') {
      if (!fs.existsSync(backupFile)) {
        throw new Error('Нет резервной копии. Сначала обновите список IPSet.');
      }
      if (fs.existsSync(listFile)) fs.unlinkSync(listFile);
      fs.renameSync(backupFile, listFile);
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

  parseVersion(version) {
    const match = String(version || '').trim().match(/^(\d+)\.(\d+)\.(\d+)([a-z]*)$/i);
    if (!match) return null;
    return {
      major: Number(match[1]),
      minor: Number(match[2]),
      patch: Number(match[3]),
      suffix: match[4] || ''
    };
  }

  compareVersions(left, right) {
    const a = this.parseVersion(left);
    const b = this.parseVersion(right);
    if (!a || !b) return String(left).trim() === String(right).trim() ? 0 : -1;

    if (a.major !== b.major) return a.major - b.major;
    if (a.minor !== b.minor) return a.minor - b.minor;
    if (a.patch !== b.patch) return a.patch - b.patch;
    if (a.suffix === b.suffix) return 0;
    if (!a.suffix) return -1;
    if (!b.suffix) return 1;
    return a.suffix.localeCompare(b.suffix);
  }

  getLocalVersion() {
    try {
      const serviceBat = path.join(this.getZapretPath(), 'service.bat');
      const content = fs.readFileSync(serviceBat, 'utf8');
      const match = content.match(/LOCAL_VERSION=["']?([^"'\r\n]+)["']?/i);
      return match ? match[1].trim() : 'unknown';
    } catch {
      return 'unknown';
    }
  }

  getReleaseDownloadUrl(version) {
    return `${RELEASE_BASE}/${version}/zapret-discord-youtube-${version}.zip`;
  }

  emitProgress(onProgress, payload) {
    if (typeof onProgress === 'function') onProgress(payload);
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

  backupUserFiles(enginePath) {
    const backup = {};
    for (const relPath of PRESERVE_RELATIVE_PATHS) {
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

  restoreUserFiles(enginePath, backup) {
    for (const [relPath, content] of Object.entries(backup)) {
      const fullPath = path.join(enginePath, relPath);
      fs.mkdirSync(path.dirname(fullPath), { recursive: true });
      fs.writeFileSync(fullPath, content);
    }
    this.ensureUserLists(enginePath);
  }

  delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
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

      const sourceRoot = this.findExtractedRoot(extractDir, remoteVersion);
      this.emitProgress(onProgress, { phase: 'install', percent: 50, message: 'Установка файлов...' });
      const deferred = await this.copyDirectoryContents(sourceRoot, enginePath, enginePath);

      this.emitProgress(onProgress, { phase: 'restore', percent: 80, message: 'Сохраняем ваши настройки...' });
      this.restoreUserFiles(enginePath, backup);
      this.removeLegacyUpdateFlag();
      this._resolvedZapretPath = enginePath;

      const local = this.getLocalVersion();
      if (this.compareVersions(local, remoteVersion) < 0) {
        throw new Error(`После установки версия ${local}, ожидалась ${remoteVersion}`);
      }

      const doneMessage = deferred.length
        ? `Обновлено до ${local}. ${deferred.length} файл(ов) будут догружены при следующем запуске.`
        : `Обновлено до ${local}`;

      this.emitProgress(onProgress, { phase: 'done', percent: 100, message: doneMessage });
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

  getUserSites() {
    return this.getGeneralSites();
  }

  saveUserSites(sites) {
    return this.saveGeneralSites(sites);
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
        const state = await this.getServiceState('zapret');
        this.config.autostartZapretEnabled = state !== 'NOT_FOUND';
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

  async setAutostartZapret(enabled) {
    const next = Boolean(enabled);
    if (next === this.isAutostartZapretEnabled()) {
      return this.getStatus();
    }

    this.config.autostartZapretEnabled = next;
    this.saveConfig();
    return this.getStatus();
  }

  async setAutostartTgProxy(enabled) {
    const next = Boolean(enabled);
    if (next === this.isAutostartTgProxyEnabled()) {
      return this.getStatus();
    }

    this.config.autostartTgProxyEnabled = next;
    this.saveConfig();
    return this.getStatus();
  }

  async getStatus() {
    const winwsRunning = await this.isProcessRunning('winws.exe');
    const zapretService = await this.getServiceState('zapret');
    const windivertService = await this.getServiceState('WinDivert');
    const installedStrategy = await this.getInstalledStrategy();
    return {
      running: winwsRunning || zapretService === 'RUNNING',
      winwsRunning,
      zapretService,
      autostartZapretEnabled: this.isAutostartZapretEnabled(),
      autostartTgProxyEnabled: this.isAutostartTgProxyEnabled(),
      windivertService,
      installedStrategy,
      lastStrategy: this.config.lastStrategy,
      version: this.getLocalVersion(),
      zapretPath: this.getZapretPath(),
      gameFilter: this.getGameFilterStatus(),
      ipset: this.getIpsetStatus(),
      autoUpdate: this.getAutoUpdateStatus()
    };
  }

  encodePsPath(value) {
    return Buffer.from(value, 'utf16le').toString('base64');
  }

  runElevated(command, args = []) {
    return new Promise((resolve, reject) => {
      const argList = args.map((a) => `'${a.replace(/'/g, "''")}'`).join(', ');
      const ps = args.length
        ? `$env:NO_UPDATE_CHECK='1'; $p = Start-Process -FilePath '${command.replace(/'/g, "''")}' -ArgumentList ${argList} -Verb RunAs -PassThru -WindowStyle Hidden; $p.WaitForExit(); exit $p.ExitCode`
        : `$env:NO_UPDATE_CHECK='1'; $p = Start-Process -FilePath '${command.replace(/'/g, "''")}' -Verb RunAs -PassThru -WindowStyle Hidden; $p.WaitForExit(); exit $p.ExitCode`;

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
      `$args = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${argsB64}'))`,
      "$ErrorActionPreference = 'SilentlyContinue'",
      'netsh interface tcp set global timestamps=enabled',
      '$psi = New-Object System.Diagnostics.ProcessStartInfo',
      '$psi.FileName = $winws',
      '$psi.WorkingDirectory = $wd',
      '$psi.Arguments = $args',
      '$psi.WindowStyle = [System.Diagnostics.ProcessWindowStyle]::Hidden',
      '$psi.UseShellExecute = $true',
      "$psi.Verb = 'runas'",
      '[System.Diagnostics.Process]::Start($psi) | Out-Null',
      'exit 0'
    ].join('; ');

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
    return new Promise((resolve, reject) => {
      const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-'));
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
      const ps = [
        `$scriptPath = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${scriptPathB64}'))`,
        `$env:NO_UPDATE_CHECK='1'`,
        `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-File',$scriptPath) -Verb RunAs -PassThru -WindowStyle Hidden`,
        '$p.WaitForExit()',
        'exit $p.ExitCode'
      ].join('; ');

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

  async getWinwsWindowTitle() {
    try {
      const { stdout } = await execAsync(
        'powershell -NoProfile -Command "(Get-Process winws -ErrorAction SilentlyContinue | Select-Object -First 1).MainWindowTitle"',
        { windowsHide: true }
      );
      return stdout.trim();
    } catch {
      return '';
    }
  }

  setLastStrategy(strategyFile) {
    const zapretPath = this.getZapretPath();
    const batPath = path.join(zapretPath, strategyFile);
    if (!fs.existsSync(batPath)) {
      throw new Error(`Стратегия не найдена: ${strategyFile}`);
    }
    this.config.lastStrategy = strategyFile;
    this.saveConfig();
    return strategyFile;
  }

  async start(strategyFile) {
    await this.applyPendingUpdates();
    const zapretPath = this.getZapretPath();
    const batPath = path.join(zapretPath, strategyFile);

    if (!fs.existsSync(batPath)) {
      throw new Error(`Стратегия не найдена: ${strategyFile}`);
    }

    const winwsRunning = await this.isProcessRunning('winws.exe');
    const serviceState = await this.getServiceState('zapret');

    if (winwsRunning || serviceState === 'RUNNING') {
      return this.getStatus();
    }

    this.setLastStrategy(strategyFile);

    if (serviceState !== 'NOT_FOUND') {
      await this.runElevatedScript([
        "$ErrorActionPreference = 'SilentlyContinue'",
        'net start zapret 2>&1',
        'exit 0'
      ].join('; '));
      const running = await this.waitForProcessStart('winws.exe', 8000)
        || (await this.getServiceState('zapret')) === 'RUNNING';
      if (!running) {
        throw new Error('Не удалось запустить обход через автозапуск');
      }
      return this.getStatus();
    }

    await this.startHiddenWinws(strategyFile);

    const running = await this.waitForProcessStart('winws.exe', 8000);
    if (!running) {
      throw new Error(`Стратегия не запустилась: ${strategyFile}`);
    }

    return this.getStatus();
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
    const [zapretState, windivertState, windivert14State] = await Promise.all([
      this.getServiceState('zapret'),
      this.getServiceState('WinDivert'),
      this.getServiceState('WinDivert14')
    ]);

    const keepService = zapretState !== 'NOT_FOUND' && this.isAutostartZapretEnabled();
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

  async runDiagnostics() {
    const results = [];

    const add = (name, ok, message) => results.push({ name, ok, message });

    try {
      const { stdout } = await execAsync('sc query BFE', { windowsHide: true });
      add('Base Filtering Engine', /RUNNING/i.test(stdout), /RUNNING/i.test(stdout) ? 'Работает' : 'Не запущен — нужен для Zapret');
    } catch (e) {
      add('Base Filtering Engine', false, e.message);
    }

    const winws = await this.isProcessRunning('winws.exe');
    add('Обход (winws.exe)', winws, winws ? 'Запущен' : 'Не запущен');

    const sysPath = path.join(this.getZapretPath(), 'bin', 'WinDivert64.sys');
    add('WinDivert64.sys', fs.existsSync(sysPath), fs.existsSync(sysPath) ? 'Найден' : 'Файл не найден');

    try {
      const { stdout } = await execAsync('netsh interface tcp show global', { windowsHide: true });
      add('TCP timestamps', /timestamps\s*=\s*enabled/i.test(stdout), /enabled/i.test(stdout) ? 'Включены' : 'Отключены');
    } catch (e) {
      add('TCP timestamps', false, e.message);
    }

    try {
      const { stdout } = await execAsync('tasklist /FI "IMAGENAME eq AdguardSvc.exe" /NH', { windowsHide: true });
      const found = stdout.toLowerCase().includes('adguard');
      add('Adguard', !found, found ? 'Обнаружен — может мешать Discord' : 'Не найден');
    } catch (e) {
      add('Adguard', true, 'Проверка недоступна');
    }

    try {
      const { stdout } = await execAsync('sc query state= all', { windowsHide: true, maxBuffer: 10 * 1024 * 1024 });
      const killer = /Killer/i.test(stdout);
      add('Killer Network', !killer, killer ? 'Конфликтует с Zapret' : 'Не найден');
      const smartbyte = /SmartByte/i.test(stdout);
      add('SmartByte', !smartbyte, smartbyte ? 'Конфликтует с Zapret' : 'Не найден');
    } catch (e) {
      add('Службы', true, 'Частичная проверка');
    }

    return results;
  }

  async checkForUpdates({ force = false } = {}) {
    const local = this.getLocalVersion();
    const cacheTtlMs = 30 * 60 * 1000;
    if (
      !force &&
      this._updateCheckCache &&
      Date.now() - this._updateCheckCache.at < cacheTtlMs
    ) {
      return { ...this._updateCheckCache.result, local, cached: true };
    }

    try {
      const { stdout } = await execAsync(
        `powershell -NoProfile -Command "(Invoke-WebRequest -Uri '${VERSION_URL}' -Headers @{ 'Cache-Control' = 'no-cache' } -UseBasicParsing -TimeoutSec 5).Content.Trim()"`,
        { windowsHide: true, timeout: 8000 }
      );
      const remote = stdout.trim();
      const updateAvailable = Boolean(remote) && this.compareVersions(local, remote) < 0;
      const result = {
        local,
        remote,
        updateAvailable,
        downloadUrl: remote ? this.getReleaseDownloadUrl(remote) : null,
        releaseUrl: remote
          ? `https://github.com/Flowseal/zapret-discord-youtube/releases/tag/${remote}`
          : 'https://github.com/Flowseal/zapret-discord-youtube/releases/latest'
      };
      this._updateCheckCache = { at: Date.now(), result };
      return result;
    } catch (e) {
      const result = { local, remote: null, updateAvailable: false, error: e.message };
      this._updateCheckCache = { at: Date.now(), result };
      return result;
    }
  }

  openExternal(url) {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, windowsHide: true });
  }

  runTests() {
    const script = path.join(this.getZapretPath(), 'utils', 'test zapret.ps1');
    if (!fs.existsSync(script)) {
      throw new Error('Скрипт тестов не найден');
    }

    const workDir = path.dirname(script);
    const scriptB64 = this.encodePsPath(script);
    const wdB64 = this.encodePsPath(workDir);
    const ps = [
      `$script = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${scriptB64}'))`,
      `$wd = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${wdB64}'))`,
      `$env:NO_UPDATE_CHECK='1'`,
      `Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-NoExit','-File',$script) -WorkingDirectory $wd -Verb RunAs -WindowStyle Normal`
    ].join('; ');

    spawn('powershell', ['-NoProfile', '-Command', ps], {
      detached: true,
      windowsHide: true
    }).unref();
    return { started: true };
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