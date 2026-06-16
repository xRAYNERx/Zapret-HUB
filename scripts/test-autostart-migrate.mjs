import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ZapretService } = require('../electron/services/zapretService.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.join(__dirname, '..');

async function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-migrate-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(
    configPath,
    JSON.stringify(
      {
        zapretPath: 'D:\\PROGRAMMS\\Запрет',
        lastStrategy: 'general.bat',
        autostartEnabled: true
      },
      null,
      2
    ),
    'utf8'
  );

  const service = new ZapretService(appPath, { configPath, isPackaged: false });
  await service.migrateAutostartConfig();

  const saved = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  if (saved.autostartZapretEnabled !== true) throw new Error('migrate: zapret not true');
  if (saved.autostartTgProxyEnabled !== false) throw new Error('migrate: tg not false');
  if ('autostartEnabled' in saved) throw new Error('migrate: legacy key remains');

  await service.setAutostartTgProxy(true);
  await service.setAutostartZapret(false);
  const status = await service.getStatus();
  if (!status.autostartTgProxyEnabled) throw new Error('tg toggle failed');
  if (status.autostartZapretEnabled) throw new Error('zapret should be off');
  if (!service.isAppAutostartEnabled()) throw new Error('app autostart should stay on for tg');

  console.log('OK: migration + independent toggles on disk verified');
}

run().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});