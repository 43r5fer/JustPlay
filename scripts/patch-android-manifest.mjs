'use strict';

import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const file = path.join(process.cwd(), 'android', 'app', 'src', 'main', 'AndroidManifest.xml');
let xml = await readFile(file, 'utf8');
const permissions = [
  'android.permission.INTERNET',
  'android.permission.RECORD_AUDIO',
  'android.permission.CAMERA',
  'android.permission.MODIFY_AUDIO_SETTINGS'
];
for (const permission of permissions) {
  const declaration = '<uses-permission android:name="' + permission + '" />';
  if (!xml.includes('android:name="' + permission + '"')) {
    const position = xml.indexOf('<application');
    if (position < 0) throw new Error('AndroidManifest.xml is missing the <application> element.');
    xml = xml.slice(0, position) + '    ' + declaration + '\n    ' + xml.slice(position);
  }
}
if (!xml.includes('android:name="android.hardware.camera"')) {
  const position = xml.indexOf('<application');
  xml = xml.slice(0, position) + '    <uses-feature android:name="android.hardware.camera" android:required="false" />\n    ' + xml.slice(position);
}
xml = xml.replace(/android:label="[^"]*"/, 'android:label="Flock"');
await writeFile(file, xml, 'utf8');
console.log('Added Flock media permissions to AndroidManifest.xml.');
