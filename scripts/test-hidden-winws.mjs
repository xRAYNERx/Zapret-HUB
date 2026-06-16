import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function loadZapretService() {
  const mod = await import(`file://${path.join(root, 'electron/services/zapretService.js')}`);
  return mod.ZapretService;
}

async function main() {
  const ZapretService = await loadZapretService();
  const enginePath = path.join(root, '..', 'Запрет');
  if (!fs.existsSync(path.join(enginePath, 'bin', 'winws.exe'))) {
    console.error('SKIP: engine not found at', enginePath);
    process.exit(0);
  }

  const svc = new ZapretService(root, { configPath: path.join(root, 'config.default.json') });
  svc.config.zapretPath = enginePath;
  svc._resolvedZapretPath = enginePath;

  const strategies = svc.getStrategies().slice(0, 3);
  let ok = 0;
  for (const { file } of strategies) {
    const args = svc.parseWinwsArgs(file);
    if (!args.includes('winws') && args.includes('--wf-tcp')) {
      console.log('OK', file, 'args length', args.length);
      ok += 1;
    } else if (args.length > 50) {
      console.log('OK', file, 'args length', args.length);
      ok += 1;
    } else {
      console.error('FAIL', file, 'bad args:', args.slice(0, 80));
    }
  }

  if (ok !== strategies.length) process.exit(1);
  console.log(`parseWinwsArgs: ${ok}/${strategies.length} OK`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});