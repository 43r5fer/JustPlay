'use strict';

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.join(root, 'src');
const destination = path.join(root, 'mobile', 'www');

await rm(destination, { recursive: true, force: true });
await mkdir(destination, { recursive: true });
await cp(source, destination, {
  recursive: true,
  filter: (src) => {
    const base = path.basename(src);
    return !['.DS_Store', 'desktop.ini'].includes(base);
  }
});
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const runtime = `'use strict';\nwindow.FLOCK_RUNTIME = Object.freeze({ version: ${JSON.stringify(packageJson.version)}, releaseSigned: false });\n`;
await writeFile(path.join(destination, 'flock-runtime.js'), runtime, 'utf8');
console.log('Copied the shared Flock web app to mobile/www for Capacitor at version ' + packageJson.version + '.');
