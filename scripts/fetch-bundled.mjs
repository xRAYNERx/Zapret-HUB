/**
 * Скачивает движок zapret-discord-youtube и TG WS Proxy в bundled/
 * для упаковки в установщик electron-builder.
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const BUNDLED = path.join(ROOT, 'bundled');

const ZAPRET_VERSION = '1.9.9b';
const ZAPRET_ZIP = `zapret-discord-youtube-${ZAPRET_VERSION}.zip`;
const ZAPRET_URL =
  `https://github.com/Flowseal/zapret-discord-youtube/releases/download/${ZAPRET_VERSION}/${ZAPRET_ZIP}`;

const TG_RELEASE_PAGE = 'https://github.com/Flowseal/tg-ws-proxy/releases/latest';
const TG_ASSET = 'TgWsProxy_windows.exe';

function download(url, dest) {
  return new Promise((resolve, reject) => {
    const request = (target) => {
      https
        .get(target, { headers: { 'User-Agent': 'ZapretHub-fetch-bundled' } }, (res) => {
          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            request(res.headers.location);
            return;
          }
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode} for ${target}`));
            return;
          }
          const file = fs.createWriteStream(dest);
          res.pipe(file);
          file.on('finish', () => file.close(resolve));
          file.on('error', reject);
        })
        .on('error', reject);
    };
    request(url);
  });
}

function rmrf(dir) {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

async function fetchZapret() {
  const destDir = path.join(BUNDLED, 'zapret');
  const winws = path.join(destDir, 'bin', 'winws.exe');
  if (fs.existsSync(winws)) {
    console.log(`[zapret] already present (${ZAPRET_VERSION})`);
    return;
  }

  const tmp = path.join(BUNDLED, '_tmp');
  const zipPath = path.join(tmp, ZAPRET_ZIP);
  const extractDir = path.join(tmp, 'extracted');

  fs.mkdirSync(tmp, { recursive: true });
  console.log(`[zapret] downloading ${ZAPRET_URL}`);
  await download(ZAPRET_URL, zipPath);

  fs.mkdirSync(extractDir, { recursive: true });
  const zipArg = zipPath.replace(/'/g, "''");
  const destArg = extractDir.replace(/'/g, "''");
  execSync(
    `powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipArg}' -DestinationPath '${destArg}' -Force"`,
    { stdio: 'inherit' }
  );

  let source = extractDir;
  if (!fs.existsSync(path.join(source, 'bin', 'winws.exe'))) {
    const expected = path.join(extractDir, `zapret-discord-youtube-${ZAPRET_VERSION}`);
    if (fs.existsSync(path.join(expected, 'bin', 'winws.exe'))) {
      source = expected;
    } else {
      const entries = fs.readdirSync(extractDir, { withFileTypes: true });
      const found = entries.find(
        (e) => e.isDirectory() && fs.existsSync(path.join(extractDir, e.name, 'bin', 'winws.exe'))
      );
      if (!found) throw new Error('[zapret] winws.exe not found in archive');
      source = path.join(extractDir, found.name);
    }
  }

  rmrf(destDir);
  fs.cpSync(source, destDir, { recursive: true });
  rmrf(tmp);
  console.log(`[zapret] installed to bundled/zapret (${ZAPRET_VERSION})`);
}

async function resolveTgDownloadUrl() {
  return new Promise((resolve, reject) => {
    https
      .get(TG_RELEASE_PAGE, { headers: { 'User-Agent': 'ZapretHub-fetch-bundled' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          const loc = res.headers.location;
          const tagMatch = loc.match(/\/tag\/(v?[\d.]+)/i);
          const tag = tagMatch ? tagMatch[1].replace(/^v/, '') : 'latest';
          resolve({
            url: `https://github.com/Flowseal/tg-ws-proxy/releases/download/v${tag.replace(/^v/, '')}/${TG_ASSET}`,
            version: tag.replace(/^v/, '')
          });
          return;
        }
        reject(new Error(`[tg-proxy] unexpected response ${res.statusCode}`));
      })
      .on('error', reject);
  });
}

async function fetchTgProxy() {
  const destDir = path.join(BUNDLED, 'tg-proxy');
  const exePath = path.join(destDir, 'TgWsProxy.exe');
  if (fs.existsSync(exePath)) {
    console.log('[tg-proxy] already present');
    return;
  }

  const { url, version } = await resolveTgDownloadUrl();
  const tmpPath = path.join(destDir, `${TG_ASSET}.download`);
  fs.mkdirSync(destDir, { recursive: true });

  console.log(`[tg-proxy] downloading ${url}`);
  await download(url, tmpPath);
  fs.renameSync(tmpPath, exePath);
  fs.writeFileSync(path.join(destDir, 'version.txt'), version, 'utf8');
  console.log(`[tg-proxy] installed to bundled/tg-proxy (${version})`);
}

async function main() {
  fs.mkdirSync(BUNDLED, { recursive: true });
  await fetchZapret();
  await fetchTgProxy();
  console.log('bundled assets ready');
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});