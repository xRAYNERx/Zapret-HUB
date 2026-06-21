#!/usr/bin/env node
/**
 * Локальная сборка → dist\win-unpacked (канонический билд для «Запуск Zapret Hub.bat»).
 * Вызывать после правок в D:\PROGRAMMS\Zapret Build — агентом или вручную.
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const EXE = path.join(ROOT, 'dist', 'win-unpacked', 'Zapret HUB.exe');
const STAMP = path.join(ROOT, 'dist', '.deploy-local.stamp');

function die(msg) {
  console.error(`[deploy-local] ${msg}`);
  process.exit(1);
}

function npmCmd() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm';
}

const running = spawnSync('tasklist', ['/FI', 'IMAGENAME eq Zapret HUB.exe', '/NH'], {
  encoding: 'utf8',
  shell: true,
});
if (/Zapret HUB\.exe/i.test(running.stdout || '')) {
  die('Zapret HUB запущен — закрой приложение (включая трей) и повтори deploy:local.');
}

const unpacked = path.join(ROOT, 'dist', 'win-unpacked', 'resources', 'app.asar.unpacked');
if (fs.existsSync(unpacked)) {
  fs.rmSync(unpacked, { recursive: true, force: true });
  console.log('[deploy-local] Удалён stale app.asar.unpacked');
}

console.log('[deploy-local] npm run build…');
const build = spawnSync(npmCmd(), ['run', 'build'], {
  cwd: ROOT,
  stdio: 'inherit',
  shell: true,
});
if (!fs.existsSync(EXE)) {
  die(
    build.status !== 0
      ? `npm run build завершился с кодом ${build.status ?? 1} и exe не создан`
      : `Нет ${EXE} после сборки`
  );
}

if (build.status !== 0) {
  console.warn(`[deploy-local] npm run build вернул код ${build.status}, но ${EXE} на месте — продолжаем`);
}

const stamp = {
  builtAt: new Date().toISOString(),
  version: require(path.join(ROOT, 'package.json')).version,
};
fs.mkdirSync(path.dirname(STAMP), { recursive: true });
fs.writeFileSync(STAMP, JSON.stringify(stamp, null, 2), 'utf8');

console.log('[deploy-local] Готово →', EXE);
console.log('[deploy-local] Запуск: «Запуск Zapret Hub.bat» или run.bat');