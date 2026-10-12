'use strict';

import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { build } from 'esbuild';
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

// Bundle the local Capacitor bridge proxy as a synchronous browser script so
// the Android native updater and notifications are registered before renderer.js.
await build({
  entryPoints: [path.join(root, 'scripts', 'clines-updater-entry.js')],
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: ['es2020'],
  outfile: path.join(destination, 'clines-updater.js')
});

const mobileIndexPath = path.join(destination, 'index.html');
let mobileIndex = await readFile(mobileIndexPath, 'utf8');
const rendererScript = '<script src="./renderer.js"></script>';
if (mobileIndex.includes(rendererScript) && !mobileIndex.includes('clines-updater.js')) {
  mobileIndex = mobileIndex.replace(rendererScript, '<script src="./clines-updater.js"></script>\n  ' + rendererScript);
}
if (!mobileIndex.includes('clines-updater.js')) throw new Error('Could not inject the mobile native updater bridge.');
await writeFile(mobileIndexPath, mobileIndex, 'utf8');

const runtime = `'use strict';\nwindow.FLOCK_RUNTIME = Object.freeze({ version: ${JSON.stringify(packageJson.version)}, releaseSigned: false });\n`;
await writeFile(path.join(destination, 'flock-runtime.js'), runtime, 'utf8');
const serviceWorkerPath = path.join(destination, 'service-worker.js');
const serviceWorker = await readFile(serviceWorkerPath, 'utf8');
let cacheVersioned = serviceWorker.replace(/const CACHE_NAME = ['"][^'"]+['"];/, "const CACHE_NAME = 'clines-shell-v" + packageJson.version + "';");
if (!cacheVersioned.includes("'./clines-updater.js'")) {
  cacheVersioned = cacheVersioned.replace("const SHELL = [", "const SHELL = ['./clines-updater.js',");
}
if (cacheVersioned === serviceWorker) throw new Error('Could not version the Flock service-worker cache.');
await writeFile(serviceWorkerPath, cacheVersioned, 'utf8');
console.log('Copied the shared Flock web app to mobile/www for Capacitor at version ' + packageJson.version + '.');
