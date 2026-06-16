const path = require('path');
const { execFileSync } = require('child_process');

/** @param {import('app-builder-lib').AfterPackContext} context */
exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'win32') return;

  const exePath = path.join(context.appOutDir, `${context.packager.appInfo.productFilename}.exe`);
  const iconPath = path.join(context.packager.projectDir, 'assets', 'icon.ico');
  const rceditBin = path.join(
    context.packager.projectDir,
    'node_modules',
    'rcedit',
    'bin',
    'rcedit-x64.exe'
  );

  execFileSync(rceditBin, [exePath, '--set-icon', iconPath], { stdio: 'inherit' });
  console.log('Applied icon to', exePath);
};