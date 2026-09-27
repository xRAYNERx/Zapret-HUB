const https = require('https');
const http = require('http');

/**
 * Unified HTTP/HTTPS fetch helper with redirect following and configurable timeout.
 */
function fetchUrl(targetUrl, { headers = {}, timeoutMs = 15000, maxRedirects = 6 } = {}) {
  return new Promise((resolve, reject) => {
    const follow = (urlStr, depth = 0) => {
      let parsed;
      try {
        parsed = new URL(urlStr);
      } catch (err) {
        return reject(new Error(`Invalid URL: ${urlStr}`));
      }

      const getter = parsed.protocol === 'https:' ? https : http;
      const reqHeaders = {
        'User-Agent': 'ZapretHub',
        ...headers
      };

      const req = getter.get(parsed, { headers: reqHeaders }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          if (depth >= maxRedirects) {
            res.resume();
            return reject(new Error('Слишком много перенаправлений'));
          }
          const nextUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, urlStr).toString();
          res.resume();
          return follow(nextUrl, depth + 1);
        }

        if (res.statusCode && res.statusCode >= 400) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }

        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          resolve({
            statusCode: res.statusCode,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            buffer: Buffer.concat(chunks)
          });
        });
      });

      req.setTimeout(timeoutMs, () => {
        req.destroy();
        reject(new Error('Превышен таймаут соединения'));
      });

      req.on('error', reject);
    };

    follow(targetUrl, 0);
  });
}

/**
 * Fetch GitHub release data via GitHub API
 */
async function fetchGithubRelease(apiUrl, { timeoutMs = 15000 } = {}) {
  const res = await fetchUrl(apiUrl, {
    headers: {
      'User-Agent': 'ZapretHub',
      Accept: 'application/vnd.github+json'
    },
    timeoutMs
  });

  let json;
  try {
    json = JSON.parse(res.body);
  } catch (err) {
    throw new Error('Некорректный JSON в ответе GitHub');
  }

  if (res.statusCode >= 400 || (json.message && !json.tag_name)) {
    throw new Error(json.message || `HTTP ${res.statusCode}`);
  }
  if (!json.tag_name) {
    throw new Error('Некорректный ответ GitHub (отсутствует tag_name)');
  }
  return json;
}

/**
 * Скачивает файл с прогрессом, следует редиректам
 */
function downloadFile(url, destPath, { onProgress, maxRedirects = 6 } = {}) {
  return new Promise((resolve, reject) => {
    const fs = require('fs');
    const request = (targetUrl, depth = 0) => {
      let parsed;
      try {
        parsed = new URL(targetUrl);
      } catch (err) {
        return reject(new Error(`Invalid URL: ${targetUrl}`));
      }
      const getter = parsed.protocol === 'https:' ? https : http;
      getter.get(targetUrl, { headers: { 'User-Agent': 'ZapretHub' } }, (response) => {
        if (response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
          if (depth >= maxRedirects) {
            response.resume();
            return reject(new Error('Слишком много редиректов при скачивании'));
          }
          response.resume();
          const nextUrl = response.headers.location.startsWith('http')
            ? response.headers.location
            : new URL(response.headers.location, targetUrl).toString();
          request(nextUrl, depth + 1);
          return;
        }
        if (response.statusCode !== 200) {
          response.resume();
          return reject(new Error(`HTTP ${response.statusCode}`));
        }
        const total = Number(response.headers['content-length'] || 0);
        let downloaded = 0;
        const file = fs.createWriteStream(destPath);
        response.on('data', (chunk) => {
          downloaded += chunk.length;
          if (total > 0 && typeof onProgress === 'function') {
            onProgress({ percent: Math.round((downloaded / total) * 100), downloaded, total });
          }
        });
        response.pipe(file);
        file.on('finish', () => file.close(() => resolve()));
        file.on('error', (err) => { fs.unlink(destPath, () => reject(err)); });
      }).on('error', reject);
    };
    request(url);
  });
}

/**
 * Fetch GitHub releases list via GitHub API
 */
async function fetchGithubReleases(repo = 'xRAYNERx/Zapret-HUB', { timeoutMs = 12000 } = {}) {
  const url = `https://api.github.com/repos/${repo}/releases?per_page=10`;
  const res = await fetchUrl(url, {
    headers: {
      'User-Agent': 'ZapretHub',
      Accept: 'application/vnd.github+json'
    },
    timeoutMs
  });

  try {
    const list = JSON.parse(res.body);
    if (Array.isArray(list)) return list;
    return [];
  } catch {
    return [];
  }
}

module.exports = {
  fetchUrl,
  fetchGithubRelease,
  fetchGithubReleases,
  downloadFile
};


