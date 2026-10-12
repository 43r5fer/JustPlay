'use strict';

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const root = process.cwd();
const capacitor = JSON.parse(await readFile(path.join(root, 'capacitor.config.json'), 'utf8'));
const appId = String(capacitor.appId || '');
if (!/^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)+$/.test(appId)) {
  throw new Error('capacitor.config.json appId is not a valid Android application ID.');
}
const androidRoot = path.join(root, 'android', 'app', 'src', 'main');
const manifestPath = path.join(androidRoot, 'AndroidManifest.xml');
let manifest = await readFile(manifestPath, 'utf8');
for (const permission of [
  'android.permission.POST_NOTIFICATIONS',
  'android.permission.REQUEST_INSTALL_PACKAGES',
  'android.permission.INTERNET'
]) {
  if (!manifest.includes('android:name="' + permission + '"')) {
    const position = manifest.indexOf('<application');
    if (position < 0) throw new Error('AndroidManifest.xml is missing <application>.');
    manifest = manifest.slice(0, position) +
      '    <uses-permission android:name="' + permission + '" />\n    ' +
      manifest.slice(position);
  }
}
manifest = manifest.replace(/android:label="[^"]*"/, 'android:label="Clines"');
await writeFile(manifestPath, manifest, 'utf8');

const packagePath = appId.replace(/\./g, path.sep);
const javaRoot = path.join(androidRoot, 'java', packagePath);
await mkdir(javaRoot, { recursive: true });

const pluginJava = [
  'package ' + appId + ';',
  '',
  'import android.Manifest;',
  'import android.app.DownloadManager;',
  'import android.app.Notification;',
  'import android.app.NotificationChannel;',
  'import android.app.NotificationManager;',
  'import android.app.PendingIntent;',
  'import android.content.Context;',
  'import android.content.Intent;',
  'import android.database.Cursor;',
  'import android.net.Uri;',
  'import android.os.Build;',
  'import android.os.Environment;',
  'import android.provider.Settings;',
  '',
  'import com.getcapacitor.JSObject;',
  'import com.getcapacitor.PermissionState;',
  'import com.getcapacitor.Plugin;',
  'import com.getcapacitor.PluginCall;',
  'import com.getcapacitor.PluginMethod;',
  'import com.getcapacitor.annotation.CapacitorPlugin;',
  'import com.getcapacitor.annotation.Permission;',
  'import com.getcapacitor.annotation.PermissionCallback;',
  '',
  '@CapacitorPlugin(',
  '    name = "ClinesUpdater",',
  '    permissions = {',
  '        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })',
  '    }',
  ')',
  'public class ClinesUpdaterPlugin extends Plugin {',
  '    private static final String CHANNEL_ID = "clines_messages";',
  '',
  '    private DownloadManager getDownloadManager() {',
  '        return (DownloadManager) getContext().getSystemService(Context.DOWNLOAD_SERVICE);',
  '    }',
  '',
  '    @PluginMethod',
  '    public void startDownload(PluginCall call) {',
  '        String url = call.getString("url");',
  '        if (url == null || !url.startsWith("https://github.com/43r5fer/JustPlay/releases/download/") || !url.endsWith("/Clines.apk")) {',
  '            call.reject("Only the official Clines Android release can be downloaded.");',
  '            return;',
  '        }',
  '        try {',
  '            DownloadManager.Request request = new DownloadManager.Request(Uri.parse(url));',
  '            request.setTitle("Clines update");',
  '            request.setDescription("Downloading the required Clines update");',
  '            request.setMimeType("application/vnd.android.package-archive");',
  '            request.setAllowedOverMetered(true);',
  '            request.setAllowedOverRoaming(false);',
  '            request.setNotificationVisibility(DownloadManager.Request.VISIBILITY_VISIBLE_NOTIFY_COMPLETED);',
  '            request.setDestinationInExternalFilesDir(getContext(), Environment.DIRECTORY_DOWNLOADS, "Clines-update-" + System.currentTimeMillis() + ".apk");',
  '            long id = getDownloadManager().enqueue(request);',
  '            JSObject result = new JSObject();',
  '            result.put("downloadId", id);',
  '            call.resolve(result);',
  '        } catch (Exception error) {',
  '            call.reject("Could not start the APK download.", error);',
  '        }',
  '    }',
  '',
  '    @PluginMethod',
  '    public void getDownloadStatus(PluginCall call) {',
  '        Long requestedId = call.getLong("downloadId");',
  '        if (requestedId == null || requestedId <= 0) { call.reject("A valid download ID is required."); return; }',
  '        Cursor cursor = null;',
  '        try {',
  '            cursor = getDownloadManager().query(new DownloadManager.Query().setFilterById(requestedId));',
  '            if (cursor == null || !cursor.moveToFirst()) { call.reject("The Android download could not be found."); return; }',
  '            int statusValue = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_STATUS));',
  '            long received = Math.max(0L, cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_BYTES_DOWNLOADED_SO_FAR)));',
  '            long total = Math.max(0L, cursor.getLong(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_TOTAL_SIZE_BYTES)));',
  '            int reasonValue = cursor.getInt(cursor.getColumnIndexOrThrow(DownloadManager.COLUMN_REASON));',
  '            String status;',
  '            if (statusValue == DownloadManager.STATUS_SUCCESSFUL) status = "downloaded";',
  '            else if (statusValue == DownloadManager.STATUS_FAILED) status = "failed";',
  '            else if (statusValue == DownloadManager.STATUS_RUNNING) status = "running";',
  '            else status = "queued";',
  '            JSObject result = new JSObject();',
  '            result.put("status", status);',
  '            result.put("bytesDownloaded", received);',
  '            result.put("totalBytes", total);',
  '            if (status.equals("failed")) result.put("reason", "Android download failed (code " + reasonValue + ").");',
  '            call.resolve(result);',
  '        } catch (Exception error) {',
  '            call.reject("Could not read APK download progress.", error);',
  '        } finally { if (cursor != null) cursor.close(); }',
  '    }',
  '',
  '    @PluginMethod',
  '    public void installDownloaded(PluginCall call) {',
  '        Long requestedId = call.getLong("downloadId");',
  '        if (requestedId == null || requestedId <= 0) { call.reject("A valid download ID is required."); return; }',
  '        try {',
  '            Uri uri = getDownloadManager().getUriForDownloadedFile(requestedId);',
  '            if (uri == null) { call.reject("The APK has not finished downloading."); return; }',
  '            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O && !getContext().getPackageManager().canRequestPackageInstalls()) {',
  '                Intent settings = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + getContext().getPackageName()));',
  '                settings.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);',
  '                getActivity().startActivity(settings);',
  '                JSObject result = new JSObject(); result.put("needsPermission", true); call.resolve(result);',
  '                return;',
  '            }',
  '            Intent install = new Intent(Intent.ACTION_VIEW);',
  '            install.setDataAndType(uri, "application/vnd.android.package-archive");',
  '            install.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK | Intent.FLAG_GRANT_READ_URI_PERMISSION);',
  '            getActivity().startActivity(install);',
  '            call.resolve();',
  '        } catch (Exception error) { call.reject("Android could not open the APK installer.", error); }',
  '    }',
  '',
  '    @PluginMethod',
  '    public void requestNotificationsPermission(PluginCall call) {',
  '        if (Build.VERSION.SDK_INT < 33 || getPermissionState("notifications") == PermissionState.GRANTED) {',
  '            JSObject result = new JSObject(); result.put("granted", true); call.resolve(result); return;',
  '        }',
  '        requestPermissionForAlias("notifications", call, "notificationPermissionCallback");',
  '    }',
  '',
  '    @PermissionCallback',
  '    private void notificationPermissionCallback(PluginCall call) {',
  '        JSObject result = new JSObject();',
  '        result.put("granted", getPermissionState("notifications") == PermissionState.GRANTED);',
  '        call.resolve(result);',
  '    }',
  '',
  '    @PluginMethod',
  '    public void showMessageNotification(PluginCall call) {',
  '        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) { call.reject("Notification permission has not been granted."); return; }',
  '        String title = call.getString("title", "New Clines message");',
  '        String body = call.getString("body", "You have a new message.");',
  '        Integer givenId = call.getInt("id");',
  '        int notificationId = givenId == null ? (int) (System.currentTimeMillis() % 2000000000L) : Math.abs(givenId);',
  '        try {',
  '            NotificationManager manager = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);',
  '            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {',
  '                NotificationChannel channel = new NotificationChannel(CHANNEL_ID, "Clines messages", NotificationManager.IMPORTANCE_HIGH);',
  '                channel.setDescription("Notifications for incoming Clines messages");',
  '                manager.createNotificationChannel(channel);',
  '            }',
  '            Intent launch = getContext().getPackageManager().getLaunchIntentForPackage(getContext().getPackageName());',
  '            PendingIntent contentIntent = null;',
  '            if (launch != null) {',
  '                launch.addFlags(Intent.FLAG_ACTIVITY_CLEAR_TOP | Intent.FLAG_ACTIVITY_SINGLE_TOP);',
  '                contentIntent = PendingIntent.getActivity(getContext(), notificationId, launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);',
  '            }',
  '            Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O ? new Notification.Builder(getContext(), CHANNEL_ID) : new Notification.Builder(getContext());',
  '            builder.setSmallIcon(getContext().getApplicationInfo().icon).setContentTitle(title).setContentText(body).setStyle(new Notification.BigTextStyle().bigText(body)).setAutoCancel(true).setPriority(Notification.PRIORITY_HIGH);',
  '            if (contentIntent != null) builder.setContentIntent(contentIntent);',
  '            manager.notify(notificationId, builder.build());',
  '            call.resolve();',
  '        } catch (Exception error) { call.reject("Could not show a Clines message notification.", error); }',
  '    }',
  '}'
].join('\n');

const mainActivity = [
  'package ' + appId + ';',
  '',
  'import android.os.Bundle;',
  'import com.getcapacitor.BridgeActivity;',
  '',
  'public class MainActivity extends BridgeActivity {',
  '    @Override',
  '    public void onCreate(Bundle savedInstanceState) {',
  '        registerPlugin(ClinesUpdaterPlugin.class);',
  '        super.onCreate(savedInstanceState);',
  '    }',
  '}'
].join('\n');

await writeFile(path.join(javaRoot, 'ClinesUpdaterPlugin.java'), pluginJava, 'utf8');
await writeFile(path.join(javaRoot, 'MainActivity.java'), mainActivity, 'utf8');
console.log('Added ClinesUpdater download-progress, Android installer, and local-message-notification support.');
