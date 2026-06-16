/**
 * Smoke test: start/stop should complete in reasonable time (no fixed 10–15s waits).
 */
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { ZapretService } = require(path.join(__dirname, '..', 'electron', 'services', 'zapretService.js'));

const appPath = path.join(__dirname, '..');
const svc = new ZapretService(appPath, {
  configPath: path.join(process.env.APPDATA || '', 'zapret-hub', 'config.json'),
  isPackaged: false,
  userDataPath: path.join(process.env.APPDATA || '', 'zapret-hub')
});

const MAX_STOP_MS = 5000;
const MAX_START_MS = 12000;

async function timed(label, fn) {
  const t0 = Date.now();
  const result = await fn();
  const ms = Date.now() - t0;
  console.log(`${label}: ${ms} ms`);
  return { result, ms };
}

const status0 = await svc.getStatus();
console.log('Engine:', status0.zapretPath, 'running:', status0.running);

if (status0.running) {
  const { ms } = await timed('stop', () => svc.stop());
  if (ms > MAX_STOP_MS) throw new Error(`stop too slow: ${ms}ms > ${MAX_STOP_MS}ms`);
}

const strategy = status0.lastStrategy || 'general.bat';
const { ms: startMs, result: startStatus } = await timed('start', () => svc.start(strategy));
if (startMs > MAX_START_MS) throw new Error(`start too slow: ${startMs}ms > ${MAX_START_MS}ms`);
if (!startStatus.running) throw new Error('start did not set running=true');

const { ms: stopMs } = await timed('stop', () => svc.stop());
if (stopMs > MAX_STOP_MS) throw new Error(`stop too slow: ${stopMs}ms > ${MAX_STOP_MS}ms`);

console.log('OK: toggle timing within limits');