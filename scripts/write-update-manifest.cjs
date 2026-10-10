'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const file = path.join(root, 'dist', 'JustPlay.exe');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(pkg.version || '')) throw new Error('Invalid package version.');
if (!fs.existsSync(file)) throw new Error('Build dist/JustPlay.exe before generating update metadata.');
const bytes = fs.readFileSync(file);
const sha512 = crypto.createHash('sha512').update(bytes).digest('base64');
const yaml = [
  `version: ${pkg.version}`,
  'files:',
  '  - url: JustPlay.exe',
  `    sha512: ${sha512}`,
  `    size: ${bytes.length}`,
  'path: JustPlay.exe',
  `sha512: ${sha512}`,
  `releaseDate: "${new Date().toISOString()}"`,
  ''
].join('\n');
fs.writeFileSync(path.join(root, 'dist', 'latest.yml'), yaml, 'utf8');
console.log(`Created update metadata for JustPlay ${pkg.version}.`);
