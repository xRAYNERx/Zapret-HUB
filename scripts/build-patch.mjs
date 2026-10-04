import fs from 'fs';
import path from 'path';
import { execSync } from 'child_process';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(rootDir, 'package.json'), 'utf8'));
const version = pkg.version;

const distDir = path.join(rootDir, 'dist');
const unpackedResources = path.join(distDir, 'win-unpacked', 'resources');

if (!fs.existsSync(unpackedResources)) {
  console.error('Error: dist/win-unpacked/resources not found. Run "npm run build:fast" or "npm run build" first.');
  process.exit(1);
}

const stagingDir = path.join(distDir, 'patch-staging');
if (fs.existsSync(stagingDir)) {
  fs.rmSync(stagingDir, { recursive: true, force: true });
}
fs.mkdirSync(stagingDir, { recursive: true });

console.log(`Building lightweight patch for Zapret Prime v${version}...`);

// 1. Copy app.asar
const asarSrc = path.join(unpackedResources, 'app.asar');
if (fs.existsSync(asarSrc)) {
  fs.copyFileSync(asarSrc, path.join(stagingDir, 'app.asar'));
}

// 2. Copy app.asar.unpacked
const unpackedSrc = path.join(unpackedResources, 'app.asar.unpacked');
if (fs.existsSync(unpackedSrc)) {
  fs.cpSync(unpackedSrc, path.join(stagingDir, 'app.asar.unpacked'), { recursive: true });
}

// 3. Copy lists
const listsSrc = path.join(rootDir, 'bundled', 'zapret', 'lists');
if (fs.existsSync(listsSrc)) {
  const targetListsDir = path.join(stagingDir, 'zapret', 'lists');
  fs.mkdirSync(targetListsDir, { recursive: true });
  fs.cpSync(listsSrc, targetListsDir, { recursive: true });
}

// 4. Create zip using tar.exe
const zipName = `ZapretPrime-Patch-${version}.zip`;
const zipPath = path.join(distDir, zipName);
if (fs.existsSync(zipPath)) {
  fs.unlinkSync(zipPath);
}

execSync(`tar.exe -a -c -f "${zipPath}" -C "${stagingDir}" *`, { windowsHide: true });

fs.rmSync(stagingDir, { recursive: true, force: true });

const stat = fs.statSync(zipPath);
const sizeKB = (stat.size / 1024).toFixed(1);
const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);

console.log(`[SUCCESS] Patch created: dist/${zipName} (${sizeKB} KB / ${sizeMB} MB)`);
