'use strict';

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const version = String(pkg.version || '');
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
  throw new Error('package.json does not contain a valid Flock version.');
}
const runtime = "'use strict';\nwindow.FLOCK_RUNTIME = Object.freeze({ version: " + JSON.stringify(version) + ", releaseSigned: false });\n";
await writeFile(path.join(root, 'src', 'flock-runtime.js'), runtime, 'utf8');
console.log('Set Flock desktop runtime version to ' + version + '.');
