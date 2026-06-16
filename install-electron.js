const { downloadArtifact } = require('@electron/get');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const version = require('./node_modules/electron/package.json').version;
const electronDir = path.join(__dirname, 'node_modules', 'electron');
const distPath = path.join(electronDir, 'dist');

async function main() {
  console.log('Downloading Electron', version);
  const zipPath = await downloadArtifact({
    version,
    artifactName: 'electron',
    force: true,
    platform: 'win32',
    arch: 'x64'
  });
  console.log('Zip:', zipPath);

  if (fs.existsSync(distPath)) fs.rmSync(distPath, { recursive: true, force: true });
  fs.mkdirSync(distPath, { recursive: true });

  console.log('Extracting via PowerShell...');
  execFileSync('powershell', [
    '-NoProfile', '-Command',
    `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${distPath.replace(/'/g, "''")}' -Force`
  ], { stdio: 'inherit', timeout: 120000 });

  const files = fs.readdirSync(distPath);
  console.log('Extracted', files.length, 'items:', files.slice(0, 8).join(', '));

  fs.writeFileSync(path.join(electronDir, 'path.txt'), 'electron.exe');
  fs.writeFileSync(path.join(distPath, 'version'), version);
  console.log('electron.exe:', fs.existsSync(path.join(distPath, 'electron.exe')));
}

main().catch((e) => { console.error(e); process.exit(1); });