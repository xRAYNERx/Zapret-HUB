import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

import { spawnSync } from 'child_process';

function getGitToken() {
  if (process.env.GITHUB_TOKEN) return process.env.GITHUB_TOKEN;
  try {
    const res = spawnSync('git', ['credential', 'fill'], {
      input: 'protocol=https\nhost=github.com\n\n',
      encoding: 'utf8',
      windowsHide: true
    });
    const match = (res.stdout || '').match(/password=(.+)/);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const version = pkg.version;

const TOKEN = getGitToken();
const OWNER = 'xRAYNERx';
const REPO = 'Zapret-PRIME';
const TAG = `v${version}`;
const RELEASE_NAME = `Zapret Prime v${version}`;

const BODY = `### 🚀 Что нового в Zapret Prime v${version}

* **🔍 База сервисов и умное добавление доменов:**
  * На вкладку «Сайты» добавлена встроенная база популярных ресурсов (Notion, Spotify, Twitch, ChatGPT, Steam, Epic Games, GitHub и др.).
  * Добавление сервиса в один клик: программа автоматически находит и добавляет в список не только основной сайт, но и все сопутствующие служебные домены, CDN и API для стабильной работы.

* **🛡️ Ребрендинг в Zapret Prime:**
  * Приложение официально переименовано в **Zapret Prime**.
  * Обновлены интерфейс, установщик и системные компоненты.

* **🌐 Белый список (прямое подключение):**
  * Полноценная поддержка белого списка: выбранные сайты и домены идут напрямую через вашего провайдера в обход DPI-обхода (winws), VPN и прокси.
  * Надёжная маршрутизация системного трафика: интернет стабильно идёт через рабочий узел, а при отключении сетевые настройки Windows мгновенно возвращаются в исходное состояние.

* **⚡ VPN и управление подписками (VLESS Reality):**
  * **Удобное подключение подписки**: при вставке ссылки появляется кнопка «Подтвердить» — приложение сразу проверяет серверы, замеряет задержку и сообщает о готовности.
  * **Защита ключа подписки**: ссылка надёжно защищена от случайного стирания или изменения, а посмотреть полный ключ можно в один клик по кнопке с глазом.
  * **Безопасное удаление**: добавлена кнопка удаления подписки с окном подтверждения.
  * **Синхронизация пинга**: обновлён замер задержки серверов с синхронным отображением в карточке и нижнем статус-баре.

* **🔄 Центр обновлений и стабильность:**
  * Исправлено зависание проверки обновлений при поиске новых версий.
  * Корректное закрытие фоновых служб (включая Telegram-прокси) при обновлении и перезапуске программы.

* **🎨 Внешний вид:**
  * Унифицирован визуальный стиль всех карточек, списков и панелей приложения.

---
### 📦 Файлы релиза:
- **\`ZapretPrime-Setup-${version}.exe\`** (~114 МБ) — полный инсталлятор для первичной или чистой установки.
- **\`ZapretPrime-Patch-${version}.zip\`** (~1.2 МБ) — легковесный патч для мгновенного обновления существующей программы.
`;

const headers = {
  'Accept': 'application/vnd.github+json',
  'Authorization': `Bearer ${TOKEN}`,
  'User-Agent': 'ZapretPrime-Release-Bot'
};

async function main() {
  console.log(`Checking existing release for tag ${TAG}...`);
  let release;
  const getRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${TAG}`, { headers });
  if (getRes.ok) {
    release = await getRes.json();
    console.log(`Found existing release: ID ${release.id}. Updating body...`);
    const updateRes = await fetch(`https://api.github.com/repos/${OWNER}/${REPO}/releases/${release.id}`, {
      method: 'PATCH',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: RELEASE_NAME,
        body: BODY
      })
    });
    if (updateRes.ok) {
      release = await updateRes.json();
      console.log(`Updated release body successfully!`);
    } else {
      console.error(`Failed to update release: ${updateRes.status} ${await updateRes.text()}`);
    }
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

  const setupPrime = path.join(rootDir, 'dist', `ZapretPrime-Setup-${version}.exe`);
  const setupHub = path.join(rootDir, 'dist', `ZapretHub-Setup-${version}.exe`);
  const patchPrime = path.join(rootDir, 'dist', `ZapretPrime-Patch-${version}.zip`);
  const patchHub = path.join(rootDir, 'dist', `ZapretHub-Patch-${version}.zip`);

  const setupFile = fs.existsSync(setupPrime) ? setupPrime : setupHub;
  const patchFile = fs.existsSync(patchPrime) ? patchPrime : patchHub;

  const assetsToUpload = [
    {
      name: `ZapretPrime-Setup-${version}.exe`,
      filePath: setupFile,
      contentType: 'application/vnd.microsoft.portable-executable'
    },
    {
      name: `ZapretPrime-Patch-${version}.zip`,
      filePath: patchFile,
      contentType: 'application/zip'
    },
    {
      name: `ZapretHub-Setup-${version}.exe`,
      filePath: setupFile,
      contentType: 'application/vnd.microsoft.portable-executable'
    },
    {
      name: `ZapretHub-Patch-${version}.zip`,
      filePath: patchFile,
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
