import { access, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const extensionRoot = resolve('extension');
const manifestPath = resolve(extensionRoot, 'manifest.json');
const requiredFiles = [
  'manifest.json',
  'background.js',
  'content.js',
  'offscreen.html',
  'offscreen.js',
  'sidepanel/index.html',
  'sidepanel.js',
  'sidepanel/sidepanel.css',
  'styles/tokens.css',
  'icons/icon.png',
];

const missingFiles = [];

for (const relativePath of requiredFiles) {
  try {
    await access(resolve(extensionRoot, relativePath));
  } catch {
    missingFiles.push(relativePath);
  }
}

if (missingFiles.length > 0) {
  throw new Error(
    `Chrome extension runtime is incomplete. Missing: ${missingFiles.join(', ')}. Run npm run prepare:extension before sharing.`,
  );
}

const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));

if (manifest.manifest_version !== 3) {
  throw new Error(`Expected Manifest V3, received ${manifest.manifest_version}.`);
}

if (manifest.background?.service_worker !== 'background.js') {
  throw new Error('manifest.json must reference background.js as its service worker.');
}

const contentScripts = manifest.content_scripts?.flatMap((entry) => entry.js ?? []) ?? [];
if (!contentScripts.includes('content.js')) {
  throw new Error('manifest.json must reference content.js.');
}

for (const command of [
  'announce-progress',
  'announce-current-video-time',
  'toggle-audio-description',
]) {
  if (!manifest.commands?.[command]) {
    throw new Error(`manifest.json is missing the ${command} command.`);
  }
}

if (
  manifest.commands?.['announce-current-video-time']?.suggested_key?.default !==
  'Alt+Shift+J'
) {
  throw new Error('Playback position shortcut must avoid known Chrome and NVIDIA conflicts and use Alt+Shift+J.');
}

if (
  manifest.commands?.['toggle-audio-description']?.suggested_key?.default !==
  'Alt+Shift+H'
) {
  throw new Error('Audio-description shortcut must use Alt+Shift+H.');
}

if (!manifest.permissions?.includes('tts')) {
  throw new Error('manifest.json must include the tts permission for shortcut speech.');
}

const sidePanelHtml = await readFile(
  resolve(extensionRoot, 'sidepanel/index.html'),
  'utf8',
);
for (const id of [
  'accessibility-announcement',
  'accessibility-alert',
  'interaction-sounds-enabled',
  'interaction-sound-volume',
  'shortcut-speech-enabled',
  'position-announce',
]) {
  if (!sidePanelHtml.includes(`id="${id}"`)) {
    throw new Error(`Side Panel accessibility element is missing: ${id}.`);
  }
}

console.log(`Chrome extension runtime validated: ${requiredFiles.length} required files found.`);
