import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

import { execSync } from 'child_process';

function getGitToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const out = execSync('echo protocol=https^&echo host=github.com | git credential fill', { encoding: 'utf8', windowsHide: true });
    const match = out.match(/password=(.+)/);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

const TOKEN = getGitToken();
const OWNER = 'xRAYNERx';
const REPO = 'Zapret-HUB';
const TAG = 'v2.0.5';
const RELEASE_NAME = 'Zapret HUB v2.0.5';

const BODY = `### 🚀 Что нового в Zapret HUB v2.0.5

- **Устранение блокировки интернета после перезагрузки/сбоя (Hotfix)**:
  - Исправлена критическая проблема, когда в случае перезагрузки ПК или аварийного завершения работы при активном VPN в настройках Windows оставался включённым системный прокси (\`127.0.0.1:10809\`), из-за чего без VPN пропадал доступ ко всем сайтам («нет подключения к интернету»).
  - Приложение теперь при каждом старте и выключении автоматически проверяет настройки прокси Windows и безопасно очищает любые зависшие локальные перенаправления.

- **Мгновенные легковесные обновления (~1.2 МБ вместо 120 МБ)**:
  - Реализована поддержка дифференциальных патчей поверх существующей установки.
  - Пользователям с установленной программой больше не требуется заново выкачивать 120 МБ полного установщика — встроенный апдейтер автоматически скачивает патч за долю секунды, бесшовно применяет его в фоне за 1 секунду и перезапускает программу.
  - Все пользовательские настройки, стратегии и списки исключений гарантированно сохраняются.

---
### 📦 Файлы релиза:
- **\`ZapretHub-Setup-2.0.5.exe\`** (~119 МБ) — полный инсталлятор для первичной или чистой установки.
- **\`ZapretHub-Patch-2.0.5.zip\`** (~1.2 МБ) — легковесный патч для мгновенного обновления существующей установки (скачивается приложением автоматически).
`;

const headers = {
  'Accept': 'application/vnd.github+json',
  'Authorization': `Bearer ${TOKEN}`,
  'User-Agent': 'ZapretHub-Release-Bot'
};

async function main() {
  console.log(`Checking existing release for tag ${TAG}...`);
  let release;
  const getRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${TAG}`, { headers });
  if (getRes.ok) {
    release = await getRes.json();
    console.log(`Found existing release: ID ${release.id}`);
  } else {
    console.log(`Creating release ${TAG}...`);
    const createRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases`, {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tag_name: TAG,
        name: RELEASE_NAME,
        body: BODY,
        draft: false,
        prerelease: false
      })
    });
    if (!createRes.ok) {
      const err = await createRes.text();
      throw new Error(`Failed to create release: ${createRes.status} ${err}`);
    }
    release = await createRes.json();
    console.log(`Created release: ID ${release.id}`);
  }

  const assetsToUpload = [
    {
      name: 'ZapretHub-Setup-2.0.5.exe',
      filePath: path.join(rootDir, 'dist', 'ZapretHub-Setup-2.0.5.exe'),
      contentType: 'application/vnd.microsoft.portable-executable'
    },
    {
      name: 'ZapretHub-Patch-2.0.5.zip',
      filePath: path.join(rootDir, 'dist', 'ZapretHub-Patch-2.0.5.zip'),
      contentType: 'application/zip'
    }
  ];

  for (const asset of assetsToUpload) {
    if (!fs.existsSync(asset.filePath)) {
      console.error(`Asset file not found: ${asset.filePath}`);
      continue;
    }

    // Check if asset already exists in release
    const existingAsset = release.assets?.find(a => a.name === asset.name);
    if (existingAsset) {
      console.log(`Deleting previous asset ${asset.name} (ID: ${existingAsset.id})...`);
      await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/assets/${existingAsset.id}`, {
        method: 'DELETE',
        headers
      });
    }

    const stat = fs.statSync(asset.filePath);
    console.log(`Uploading ${asset.name} (${(stat.size / (1024 * 1024)).toFixed(2)} MB)...`);
    const fileStream = fs.readFileSync(asset.filePath);

    const uploadUrl = `https://uploads.github.com/repos/${OWNER}/${REPO}/releases/${release.id}/assets?name=${encodeURIComponent(asset.name)}`;
    const uploadRes = await fetch(uploadUrl, {
      method: 'POST',
      headers: {
        ...headers,
        'Content-Type': asset.contentType,
        'Content-Length': String(stat.size)
      },
      body: fileStream
    });

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      console.error(`Failed to upload ${asset.name}: ${uploadRes.status} ${err}`);
    } else {
      console.log(`Uploaded ${asset.name} successfully!`);
    }
  }

  console.log(`\nAll done! Release is live at: ${release.html_url}`);
}

main().catch(err => {
  console.error('Error:', err);
  process.exit(1);
});
