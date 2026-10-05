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
const REPO = 'Zapret-NET';
const TAG = `v${version}`;
const RELEASE_NAME = `Zapret.NET v${version}`;

const BODY = `### 🚀 Что нового в Zapret.NET v${version}

**🛠️ Модуль «Устранение сбоев и самолечение»:**
* На вкладку «Настройки» добавлена функция быстрого восстановления работы приложения и сети в один клик (**«Найти и устранить неполадки»**).
* **Автоматический поиск и безопасное завершение** зависших фоновых процессов ядра (\`winws\`, \`xray\`, \`ZapretTgProxy\`, \`wintun\`).
* **Безопасная очистка залипших локальных системных прокси Windows** (\`127.0.0.1\`) без сброса и повреждения пользовательских настроек сети и DNS-серверов.
* **Мягкий перезапуск и сброс фильтров сетевого драйвера WinDivert** без необходимости перезагружать компьютер.
* **Экспресс-проверка сетевой доступности ключевых узлов** с формированием наглядного отчёта о найденных и исправленных неполадках.

**🎨 Улучшения интерфейса и стабильности:**
* Кнопка **«Патчи»** в настройках перекрашена под строгий дизайн приложения в тон остальным элементам управления.
* Оптимизирована карточка системных компонентов: убран некорректный статический статус активности.
* Улучшено позиционирование и оформление диалоговых окон: центрирование модального окна самолечения на экране, просторные и удобные кнопки взаимодействия.

---
### 📦 Файлы релиза:
- **\`ZapretNet-Setup-${version}.exe\`** (~114 МБ) — полный инсталлятор для первичной или чистой установки.
- **\`ZapretNet-Patch-${version}.zip\`** (~1.2 МБ) — легковесный патч для мгновенного обновления существующей программы.
`;

const headers = {
  'Accept': 'application/vnd.github+json',
  'Authorization': `Bearer ${TOKEN}`,
  'User-Agent': 'ZapretNet-Release-Bot'
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

  const setupNet = path.join(rootDir, 'dist', `ZapretNet-Setup-${version}.exe`);
  const setupPrime = path.join(rootDir, 'dist', `ZapretPrime-Setup-${version}.exe`);
  const setupHub = path.join(rootDir, 'dist', `ZapretHub-Setup-${version}.exe`);
  const patchNet = path.join(rootDir, 'dist', `ZapretNet-Patch-${version}.zip`);
  const patchPrime = path.join(rootDir, 'dist', `ZapretPrime-Patch-${version}.zip`);
  const patchHub = path.join(rootDir, 'dist', `ZapretHub-Patch-${version}.zip`);

  const setupFile = fs.existsSync(setupNet) ? setupNet : (fs.existsSync(setupPrime) ? setupPrime : setupHub);
  const patchFile = fs.existsSync(patchNet) ? patchNet : (fs.existsSync(patchPrime) ? patchPrime : patchHub);

  const assetsToUpload = [
    {
      name: `ZapretNet-Setup-${version}.exe`,
      filePath: setupFile,
      contentType: 'application/vnd.microsoft.portable-executable'
    },
    {
      name: `ZapretNet-Patch-${version}.zip`,
      filePath: patchFile,
      contentType: 'application/zip'
    },
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
