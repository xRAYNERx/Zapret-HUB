import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ZapretService } = require('../electron/services/zapretService.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.join(__dirname, '..');

function makeService(config) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-autostart-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
  const service = new ZapretService(appPath, { configPath, isPackaged: false });
  return { service, configPath, dir };
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function run() {
  // Legacy migration
  {
    const { service } = makeService({ autostartEnabled: true, lastStrategy: 'general.bat' });
    await service.migrateAutostartConfig();
    assert(service.isAutostartZapretEnabled() === true, 'legacy true -> zapret');
    assert(service.isAutostartTgProxyEnabled() === false, 'legacy true -> tg false');
    assert(service.config.autostartEnabled === undefined, 'legacy key removed');
    assert(service.isAppAutostartEnabled() === true, 'app autostart on when zapret on');
  }

  // Independent toggles
  {
    const { service } = makeService({
      autostartZapretEnabled: false,
      autostartTgProxyEnabled: true
    });
    assert(service.isAppAutostartEnabled() === true, 'tg only -> app autostart on');
    await service.setAutostartZapret(true);
    assert(service.isAutostartZapretEnabled() === true, 'zapret can be enabled with tg');
    assert(service.isAutostartTgProxyEnabled() === true, 'tg stays enabled');
    await service.setAutostartTgProxy(false);
    assert(service.isAutostartZapretEnabled() === true, 'zapret stays when tg off');
    assert(service.isAppAutostartEnabled() === true, 'app autostart still on for zapret only');
    await service.setAutostartZapret(false);
    assert(service.isAppAutostartEnabled() === false, 'app autostart off when both off');
  }

  // getStatus fields
  {
    const { service } = makeService({
      autostartZapretEnabled: true,
      autostartTgProxyEnabled: false
    });
    const status = await service.getStatus();
    assert(status.autostartZapretEnabled === true, 'status zapret flag');
    assert(status.autostartTgProxyEnabled === false, 'status tg flag');
    assert(status.autostartEnabled === undefined, 'legacy status field removed');
  }

  console.log('OK: autostart split logic verified');
}

run().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});