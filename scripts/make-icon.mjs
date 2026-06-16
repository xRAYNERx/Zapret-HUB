import { Jimp } from 'jimp';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const source = process.argv[2] || 'C:/Users/RAYNER/.grok/sessions/C%3A%5CUsers%5CRAYNER%5C.grok%5Cclients%5Czapret/019ecae2-a24d-7a93-8ba4-4d1904913270/images/1.jpg';
const previewOut = path.join(__dirname, '../assets/icon-preview.png');
const iconOut = path.join(__dirname, '../assets/icon.png');
const apply = process.argv.includes('--apply');

function colorDist(r, g, b, r2, g2, b2) {
  return Math.sqrt((r - r2) ** 2 + (g - g2) ** 2 + (b - b2) ** 2);
}

function isBackground(x, y, r, g, b) {
  // Не трогаем область щита — там те же тёмные оттенки, что и у фона
  if (x > 260 && x < 760 && y > 260 && y < 760) return false;
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  if (lum > 95) return false;
  const d1 = colorDist(r, g, b, 19, 34, 55);
  const d2 = colorDist(r, g, b, 20, 35, 54);
  return (d1 < 28 || d2 < 28) && lum < 80;
}

function isLockPixel(x, y, r, g, b) {
  if (x < 400 || x > 560 || y < 385 || y > 565) return false;
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  if (lum > 75) return false;
  if (r > 40 || g > 60 || b > 85) return false;
  if (g > 120) return false;
  return true;
}

const img = await Jimp.read(source);

img.scan(0, 0, img.bitmap.width, img.bitmap.height, function (x, y, idx) {
  const r = this.bitmap.data[idx];
  const g = this.bitmap.data[idx + 1];
  const b = this.bitmap.data[idx + 2];

  if (isLockPixel(x, y, r, g, b)) {
    this.bitmap.data[idx] = 34;
    this.bitmap.data[idx + 1] = 197;
    this.bitmap.data[idx + 2] = 94;
  } else if (isBackground(x, y, r, g, b)) {
    this.bitmap.data[idx] = 0;
    this.bitmap.data[idx + 1] = 0;
    this.bitmap.data[idx + 2] = 0;
  }
});

await img.write(previewOut);
console.log('Preview saved:', previewOut);

if (apply) {
  await img.write(iconOut);
  console.log('Icon applied:', iconOut);
}