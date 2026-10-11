'use strict';

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const packageJson = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const deployId = String(process.env.GITHUB_SHA || process.env.GITHUB_RUN_ID || Date.now().toString(36)).slice(0, 12);
const target = path.resolve(root, process.argv[2] || 'site/app');
const swPath = path.join(target, 'service-worker.js');
const runtimePath = path.join(target, 'flock-runtime.js');
let serviceWorker = await readFile(swPath, 'utf8');
const cacheVersioned = serviceWorker.replace(/const CACHE_NAME = ['"][^'"]+['"];/, "const CACHE_NAME = 'flock-shell-v" + packageJson.version + "-" + deployId + "';");
if (cacheVersioned === serviceWorker) throw new Error('Could not version the Flock service-worker cache.');
await writeFile(swPath, cacheVersioned, 'utf8');
const runtime = "'use strict';\nwindow.FLOCK_RUNTIME = Object.freeze({ version: " + JSON.stringify(packageJson.version) + ", releaseSigned: false });\n";
await writeFile(runtimePath, runtime, 'utf8');
console.log('Prepared PWA assets for Flock ' + packageJson.version + ' at ' + target + '.');
