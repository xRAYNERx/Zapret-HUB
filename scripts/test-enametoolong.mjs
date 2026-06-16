import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');
const require = createRequire(import.meta.url);
const { ZapretService } = require('../electron/services/zapretService.js');

const enginePath = path.join(process.env.APPDATA || '', 'zapret-hub', 'engine');
if (!fs.existsSync(path.join(enginePath, 'bin', 'winws.exe'))) {
  console.log('SKIP: no engine at', enginePath);
  process.exit(0);
}

const svc = new ZapretService(root, { configPath: path.join(root, 'config.default.json') });
svc.config.zapretPath = enginePath;
svc._resolvedZapretPath = enginePath;

const encodePsPath = (value) => Buffer.from(value, 'utf16le').toString('base64');

for (const file of ['general.bat', 'general (ALT).bat']) {
  const args = svc.parseWinwsArgs(file);
  const winwsPath = path.join(enginePath, 'bin', 'winws.exe');
  const workDir = path.join(enginePath, 'bin');
  const script = [
    `$winws = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodePsPath(winwsPath)}'))`,
    `$wd = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodePsPath(workDir)}'))`,
    `$args = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodePsPath(args)}'))`,
    'exit 0'
  ].join('; ');
  const scriptB64 = encodePsPath(script);
  const ps = [
    `$script = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${scriptB64}'))`,
    `$p = Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-ExecutionPolicy','Bypass','-Command',$script) -Verb RunAs -PassThru -WindowStyle Hidden`,
    'exit 0'
  ].join('; ');
  const oldSpawnLen = 'powershell'.length + 1 + '-NoProfile'.length + 1 + '-Command'.length + 1 + ps.length;
  const tmpScriptPath = path.join(process.env.TEMP || 'C:\\Temp', 'zapret-abc', 'elevated.ps1');
  const newPs = [
    `$scriptPath = [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${encodePsPath(tmpScriptPath)}'))`,
    'exit 0'
  ].join('; ');
  const newSpawnLen = 'powershell'.length + 1 + '-NoProfile'.length + 1 + '-Command'.length + 1 + newPs.length;
  console.log(file, {
    argsLen: args.length,
    oldSpawnApprox: oldSpawnLen,
    newSpawnApprox: newSpawnLen,
    windowsLimit: 32767,
    oldExceeds: oldSpawnLen > 32767,
    newExceeds: newSpawnLen > 32767
  });
}