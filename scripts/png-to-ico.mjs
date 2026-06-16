import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import pngToIco from 'png-to-ico';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pngPath = path.join(__dirname, '../assets/icon.png');
const icoPath = path.join(__dirname, '../assets/icon.ico');

const ico = await pngToIco(pngPath);
fs.writeFileSync(icoPath, ico);
console.log('ICO saved:', icoPath);