'use strict';

import { readdir, readFile, writeFile } from 'node:fs/promises';
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

async function findNamedFile(dir, name) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isFile() && entry.name === name) return full;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === 'build' || entry.name === '.gradle') continue;
    const found = await findNamedFile(path.join(dir, entry.name), name).catch(() => null);
    if (found) return found;
  }
  return null;
}

const appGradlePath = path.join(androidRoot, 'app', 'build.gradle');
let appGradle = await readFile(appGradlePath, 'utf8');
if (!appGradle.includes('android {')) throw new Error('Unexpected Capacitor Android app/build.gradle format.');
appGradle = appGradle.replace(/applicationId\s+["'][^"']+["']/, 'applicationId "' + appId + '"');
if (!/versionCode\s+\d+/.test(appGradle)) throw new Error('Could not locate versionCode in app/build.gradle.');
if (!/versionName\s+["'][^"']+["']/.test(appGradle)) throw new Error('Could not locate versionName in app/build.gradle.');
appGradle = appGradle.replace(/versionCode\s+\d+/, 'versionCode ' + versionCode);
appGradle = appGradle.replace(/versionName\s+["'][^"']+["']/, 'versionName "' + version + '"');

if (!appGradle.includes('com.google.android.play:app-update:')) {
  const match = appGradle.match(/(^[ \t]*dependencies[ \t]*\{)/m);
  if (!match || match.index == null) throw new Error('Could not locate dependencies block in app/build.gradle.');
  const at = match.index + match[0].length;
  appGradle = appGradle.slice(0, at) + "\n    implementation 'com.google.android.play:app-update:2.1.0'" + appGradle.slice(at);
}
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

const mainActivityPath = await findNamedFile(path.join(androidRoot, 'app', 'src', 'main', 'java'), 'MainActivity.java');
if (!mainActivityPath) throw new Error('Could not find generated MainActivity.java.');
const mainExisting = await readFile(mainActivityPath, 'utf8');
const packageMatch = mainExisting.match(/^\s*package\s+([A-Za-z0-9_.]+)\s*;/m);
const javaPackage = packageMatch ? packageMatch[1] : appId;
const mainJava = 'package ' + javaPackage + ';\n\n' +
'import android.os.Bundle;\n' +
'import androidx.activity.result.ActivityResultLauncher;\n' +
'import androidx.activity.result.IntentSenderRequest;\n' +
'import androidx.activity.result.contract.ActivityResultContracts;\n' +
'import com.getcapacitor.BridgeActivity;\n' +
'import com.google.android.play.core.appupdate.AppUpdateInfo;\n' +
'import com.google.android.play.core.appupdate.AppUpdateManager;\n' +
'import com.google.android.play.core.appupdate.AppUpdateManagerFactory;\n' +
'import com.google.android.play.core.appupdate.AppUpdateOptions;\n' +
'import com.google.android.play.core.install.model.AppUpdateType;\n\n' +
'public class MainActivity extends BridgeActivity {\n' +
'    private ActivityResultLauncher<IntentSenderRequest> flockUpdateLauncher;\n' +
'    private AppUpdateManager flockUpdateManager;\n\n' +
'    @Override\n' +
'    public void onCreate(Bundle savedInstanceState) {\n' +
'        registerPlugin(FlockUpdatesPlugin.class);\n' +
'        super.onCreate(savedInstanceState);\n' +
'        flockUpdateManager = AppUpdateManagerFactory.create(this);\n' +
'        flockUpdateLauncher = registerForActivityResult(\n' +
'            new ActivityResultContracts.StartIntentSenderForResult(),\n' +
'            result -> { /* The web UI re-checks update/install status when it resumes. */ }\n' +
'        );\n' +
'    }\n\n' +
'    public void startFlockPlayUpdate(AppUpdateInfo info, int updateType) {\n' +
'        if (flockUpdateLauncher == null || flockUpdateManager == null) {\n' +
'            throw new IllegalStateException("The Flock update flow is not ready yet.");\n' +
'        }\n' +
'        AppUpdateOptions options = AppUpdateOptions.newBuilder(updateType).build();\n' +
'        flockUpdateManager.startUpdateFlowForResult(info, flockUpdateLauncher, options);\n' +
'    }\n\n' +
'    public AppUpdateManager getFlockUpdateManager() {\n' +
'        if (flockUpdateManager == null) {\n' +
'            flockUpdateManager = AppUpdateManagerFactory.create(this);\n' +
'        }\n' +
'        return flockUpdateManager;\n' +
'    }\n' +
'}\n';
await writeFile(mainActivityPath, mainJava, 'utf8');

const pluginPath = path.join(path.dirname(mainActivityPath), 'FlockUpdatesPlugin.java');
const pluginJava = 'package ' + javaPackage + ';\n\n' +
'import com.getcapacitor.JSObject;\n' +
'import com.getcapacitor.Plugin;\n' +
'import com.getcapacitor.PluginCall;\n' +
'import com.getcapacitor.PluginMethod;\n' +
'import com.getcapacitor.annotation.CapacitorPlugin;\n' +
'import com.google.android.play.core.appupdate.AppUpdateInfo;\n' +
'import com.google.android.play.core.appupdate.AppUpdateManager;\n' +
'import com.google.android.play.core.appupdate.AppUpdateOptions;\n' +
'import com.google.android.play.core.install.model.AppUpdateType;\n' +
'import com.google.android.play.core.install.model.InstallStatus;\n' +
'import com.google.android.play.core.install.model.UpdateAvailability;\n\n' +
'@CapacitorPlugin(name = "FlockUpdates")\n' +
'public class FlockUpdatesPlugin extends Plugin {\n' +
'    private AppUpdateManager manager() {\n' +
'        return ((MainActivity) getActivity()).getFlockUpdateManager();\n' +
'    }\n\n' +
'    @PluginMethod\n' +
'    public void getInfo(PluginCall call) {\n' +
'        manager().getAppUpdateInfo()\n' +
'            .addOnSuccessListener(info -> call.resolve(toResult(info)))\n' +
'            .addOnFailureListener(error -> call.reject("Google Play could not check for updates.", error));\n' +
'    }\n\n' +
'    @PluginMethod\n' +
'    public void startUpdate(PluginCall call) {\n' +
'        String mode = call.getString("mode", "flexible");\n' +
'        int updateType = "immediate".equalsIgnoreCase(mode) ? AppUpdateType.IMMEDIATE : AppUpdateType.FLEXIBLE;\n' +
'        AppUpdateOptions options = AppUpdateOptions.newBuilder(updateType).build();\n' +
'        manager().getAppUpdateInfo().addOnSuccessListener(info -> {\n' +
'            int availability = info.updateAvailability();\n' +
'            if (availability != UpdateAvailability.UPDATE_AVAILABLE && availability != UpdateAvailability.DEVELOPER_TRIGGERED_UPDATE_IN_PROGRESS) {\n' +
'                call.reject("Google Play does not currently report an available update.");\n' +
'                return;\n' +
'            }\n' +
'            if (!info.isUpdateTypeAllowed(options)) {\n' +
'                call.reject("Google Play does not allow this update flow for this version.");\n' +
'                return;\n' +
'            }\n' +
'            try {\n' +
'                ((MainActivity) getActivity()).startFlockPlayUpdate(info, updateType);\n' +
'                call.resolve(toResult(info));\n' +
'            } catch (Exception error) {\n' +
'                call.reject("Could not start the Google Play update.", error);\n' +
'            }\n' +
'        }).addOnFailureListener(error -> call.reject("Google Play could not start the update.", error));\n' +
'    }\n\n' +
'    @PluginMethod\n' +
'    public void completeUpdate(PluginCall call) {\n' +
'        manager().completeUpdate()\n' +
'            .addOnSuccessListener(unused -> call.resolve())\n' +
'            .addOnFailureListener(error -> call.reject("Could not complete the Google Play update.", error));\n' +
'    }\n\n' +
'    private JSObject toResult(AppUpdateInfo info) {\n' +
'        JSObject result = new JSObject();\n' +
'        result.put("updateAvailability", info.updateAvailability());\n' +
'        result.put("availableVersionCode", info.availableVersionCode());\n' +
'        result.put("installStatus", info.installStatus());\n' +
'        result.put("flexibleAllowed", info.isUpdateTypeAllowed(AppUpdateOptions.newBuilder(AppUpdateType.FLEXIBLE).build()));\n' +
'        result.put("immediateAllowed", info.isUpdateTypeAllowed(AppUpdateOptions.newBuilder(AppUpdateType.IMMEDIATE).build()));\n' +
'        result.put("updateAvailable", info.updateAvailability() == UpdateAvailability.UPDATE_AVAILABLE);\n' +
'        result.put("downloaded", info.installStatus() == InstallStatus.DOWNLOADED);\n' +
'        return result;\n' +
'    }\n' +
'}\n';
await writeFile(pluginPath, pluginJava, 'utf8');

const runtimePath = path.join(androidRoot, 'app', 'src', 'main', 'assets', 'public', 'flock-runtime.js');
const runtime = "'use strict';\nwindow.FLOCK_RUNTIME = Object.freeze({ version: " + JSON.stringify(version) +
  ", releaseSigned: " + (signingReady ? 'true' : 'false') + " });\n";
await writeFile(runtimePath, runtime, 'utf8');
console.log('Configured Flock Android version ' + version + ' (versionCode ' + versionCode + '), target API 36, Google Play in-app updates, ' + (signingReady ? 'release signing enabled.' : 'release signing not configured; Play Store AAB skipped.'));
