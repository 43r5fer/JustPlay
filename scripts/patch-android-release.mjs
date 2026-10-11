'use strict';

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const androidRoot = path.join(root, 'android');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const capacitor = JSON.parse(await readFile(path.join(root, 'capacitor.config.json'), 'utf8'));
const appId = String(capacitor.appId || 'com.flock.messaging');
if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(appId)) {
  throw new Error('capacitor.config.json appId is not a valid Android application ID.');
}
const version = String(pkg.version || '');
const versionMatch = version.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/);
if (!versionMatch) throw new Error('package.json version must be valid semver.');
const major = Number(versionMatch[1]);
const minor = Number(versionMatch[2]);
const patch = Number(versionMatch[3]);
if (major > 2000 || minor > 999 || patch > 999) throw new Error('Version exceeds the release versionCode range.');
const versionCode = major * 1000000 + minor * 1000 + patch;
const signingReady = process.env.FLOCK_RELEASE_SIGNING_READY === 'true';


const appGradlePath = path.join(androidRoot, 'app', 'build.gradle');
let appGradle = await readFile(appGradlePath, 'utf8');
if (!appGradle.includes('android {')) throw new Error('Unexpected Capacitor Android app/build.gradle format.');
appGradle = appGradle.replace(/applicationId\s+["'][^"']+["']/, 'applicationId "' + appId + '"');
if (!/versionCode\s+\d+/.test(appGradle)) throw new Error('Could not locate versionCode in app/build.gradle.');
if (!/versionName\s+["'][^"']+["']/.test(appGradle)) throw new Error('Could not locate versionName in app/build.gradle.');
appGradle = appGradle.replace(/versionCode\s+\d+/, 'versionCode ' + versionCode);
appGradle = appGradle.replace(/versionName\s+["'][^"']+["']/, 'versionName "' + version + '"');

if (!appGradle.includes('signingConfigs {') || !appGradle.includes('signingConfigs.release')) {
  const buildTypesIndex = appGradle.indexOf('buildTypes {');
  if (buildTypesIndex < 0) throw new Error('Could not locate buildTypes block in app/build.gradle.');
  const signing = "\n    signingConfigs {\n        release {\n            if (System.getenv(\"FLOCK_RELEASE_SIGNING_READY\") == \"true\") {\n                storeFile file(System.getenv(\"FLOCK_ANDROID_KEYSTORE_PATH\"))\n                storePassword System.getenv(\"ANDROID_KEYSTORE_PASSWORD\")\n                keyAlias System.getenv(\"ANDROID_KEY_ALIAS\")\n                keyPassword System.getenv(\"ANDROID_KEY_PASSWORD\")\n            }\n        }\n    }\n\n";
  appGradle = appGradle.slice(0, buildTypesIndex) + signing + appGradle.slice(buildTypesIndex);
}
const buildTypesIndex = appGradle.indexOf('buildTypes {');
const releaseIndex = appGradle.indexOf('release {', buildTypesIndex);
if (releaseIndex < 0) throw new Error('Could not locate release build type in app/build.gradle.');
const releaseOpen = releaseIndex + 'release {'.length;
const signingLine = "\n            if (System.getenv(\"FLOCK_RELEASE_SIGNING_READY\") == \"true\") { signingConfig signingConfigs.release }";
if (!appGradle.slice(releaseOpen, releaseOpen + 300).includes('signingConfig signingConfigs.release')) {
  appGradle = appGradle.slice(0, releaseOpen) + signingLine + appGradle.slice(releaseOpen);
}
await writeFile(appGradlePath, appGradle, 'utf8');

const varsPath = path.join(androidRoot, 'variables.gradle');
let variables = await readFile(varsPath, 'utf8');
if (!/targetSdkVersion\s*=\s*\d+/.test(variables)) throw new Error('Could not locate targetSdkVersion in android/variables.gradle.');
variables = variables.replace(/targetSdkVersion\s*=\s*\d+/, 'targetSdkVersion = 36');
if (/compileSdkVersion\s*=\s*\d+/.test(variables)) variables = variables.replace(/compileSdkVersion\s*=\s*\d+/, 'compileSdkVersion = 36');
await writeFile(varsPath, variables, 'utf8');

const runtimePath = path.join(androidRoot, 'app', 'src', 'main', 'assets', 'public', 'flock-runtime.js');
const runtime = "'use strict';\nwindow.FLOCK_RUNTIME = Object.freeze({ version: " + JSON.stringify(version) +
  ", releaseSigned: " + (signingReady ? 'true' : 'false') + " });\n";
await writeFile(runtimePath, runtime, 'utf8');
console.log('Configured Flock Android version ' + version + ' (versionCode ' + versionCode + '), target API 36, direct APK distribution, ' + (signingReady ? 'release signing enabled.' : 'release signing not configured; a debug-signed APK will be used.'));
