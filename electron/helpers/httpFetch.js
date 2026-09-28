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

function decodeHtmlEntities(str) {
  return (str || '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseReleasesAtom(xml) {
  const entries = (xml || '').split('<entry>');
  const releases = [];
  for (let i = 1; i < entries.length; i++) {
    const chunk = entries[i].split('</entry>')[0];
    const tagMatch = chunk.match(/\/releases\/tag\/([^"/?#\s<]+)/i);
    const tag = tagMatch ? tagMatch[1] : '';
    const titleMatch = chunk.match(/<title>([\s\S]*?)<\/title>/i);
    const title = titleMatch ? titleMatch[1].trim() : '';
    const dateMatch = chunk.match(/<updated>([\s\S]*?)<\/updated>/i);
    const date = dateMatch ? dateMatch[1].trim() : '';
    const contentMatch = chunk.match(/<content[^>]*>([\s\S]*?)<\/content>/i);
    const rawContent = contentMatch ? decodeHtmlEntities(contentMatch[1]) : '';

    if (tag) {
      releases.push({
        tag_name: tag,
        name: title,
        published_at: date,
        body_html: rawContent,
        body: rawContent
      });
    }
  }
  return releases;
}

/**
 * Fetch GitHub releases list via GitHub API with Atom feed fallback
 */
async function fetchGithubReleases(repo = 'xRAYNERx/Zapret-HUB', { timeoutMs = 12000 } = {}) {
  // 1. Try official GitHub API
  try {
    const url = `https://api.github.com/repos/${repo}/releases?per_page=10`;
    const res = await fetchUrl(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 ZapretHub',
        Accept: 'application/vnd.github+json'
      },
      timeoutMs
    });
    const list = JSON.parse(res.body);
    if (Array.isArray(list) && list.length > 0) return list;
  } catch (apiErr) {
    // API failed or rate-limited, fallback to Atom feed below
  }

  // 2. Fallback to public GitHub releases.atom (no rate limits, always available)
  try {
    const atomUrl = `https://github.com/${repo}/releases.atom`;
    const res = await fetchUrl(atomUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 ZapretHub',
        Accept: 'application/atom+xml, application/xml, text/xml, */*'
      },
      timeoutMs
    });
    const list = parseReleasesAtom(res.body);
    if (list.length > 0) return list;
  } catch (atomErr) {}

  return [];
}

module.exports = {
  fetchUrl,
  fetchGithubRelease,
  fetchGithubReleases,
  downloadFile
};


