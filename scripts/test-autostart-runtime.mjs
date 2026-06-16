import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const require = createRequire(import.meta.url);
const { ZapretService } = require('../electron/services/zapretService.js');
const { TgProxyService } = require('../electron/services/tgProxyService.js');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appPath = path.join(__dirname, '..');
const userDataPath = path.join(process.env.APPDATA || '', 'zapret-hub');

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

async function withTempConfig(initial, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zapret-runtime-'));
  const configPath = path.join(dir, 'config.json');
  fs.writeFileSync(configPath, JSON.stringify(initial, null, 2), 'utf8');
  const zapret = new ZapretService(appPath, { configPath, isPackaged: false, userDataPath });
  try {
    await fn(zapret, configPath);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function shouldRunZapret(zapret) {
  if (!zapret.isAutostartZapretEnabled()) return false;
  const status = await zapret.getStatus();
  return !status.running;
}

async function shouldRunTg(zapret, tgProxy) {
  if (!zapret.isAutostartTgProxyEnabled()) return false;
  const status = await tgProxy.getStatus();
  return !status.running;
}

async function run() {
  const tgProxy = new TgProxyService(userDataPath);
  const tgInstalled = Boolean(tgProxy.getLocalVersion());
  const tgWasRunning = tgInstalled ? (await tgProxy.getStatus()).running : false;
  if (tgWasRunning) await tgProxy.stop();

  const matrix = [
    { zapret: false, tg: false, app: false, runZ: false, runT: false },
    { zapret: true, tg: false, app: true, runZ: true, runT: false },
    { zapret: false, tg: true, app: true, runZ: false, runT: true },
    { zapret: true, tg: true, app: true, runZ: true, runT: true }
  ];

  for (const row of matrix) {
    await withTempConfig(
      {
        autostartZapretEnabled: row.zapret,
        autostartTgProxyEnabled: row.tg,
        lastStrategy: 'general.bat'
      },
      async (zapret) => {
        assert(zapret.isAppAutostartEnabled() === row.app, `app flag ${JSON.stringify(row)}`);
        const runZ = await shouldRunZapret(zapret);
        const runT = await shouldRunTg(zapret, tgProxy);
        assert(runZ === row.runZ, `zapret run ${JSON.stringify(row)}`);
        assert(runT === (row.runT && tgInstalled), `tg run ${JSON.stringify(row)}`);
      }
    );
  }

  if (tgInstalled) {
    await withTempConfig(
      { autostartZapretEnabled: false, autostartTgProxyEnabled: true, lastStrategy: 'general.bat' },
      async (zapret) => {
        assert(await shouldRunTg(zapret, tgProxy) === true, 'tg-only should run');
        const result = await tgProxy.start();
        assert(result.running === true, 'tg-only autostart start');
        await tgProxy.stop();
        assert((await tgProxy.getStatus()).running === false, 'tg stopped after test');
      }
    );

    if (tgWasRunning) await tgProxy.start();
  } else {
    console.log('SKIP: tg proxy binary not installed — runtime start test skipped');
  }

  console.log('OK: autostart runtime decision matrix verified');
}

run().catch((err) => {
  console.error('FAIL:', err.message);
  process.exit(1);
});