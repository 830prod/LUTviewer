'use strict';

/*
 * Auto-update from GitHub Releases.
 *
 * LUTviewer is distributed without a paid Apple Developer ID, so Electron's
 * built-in Squirrel updater (which requires a signed app) can't be used.
 * Instead: check the latest GitHub release, download LUTviewer.dmg, mount it,
 * swap the .app bundle in place and relaunch. If the app can't replace itself
 * (no write access, or running from the DMG / a translocated path), the DMG
 * is opened so the user can drag the new version into Applications.
 */

const { app, net, shell, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
// Plain fs, without Electron's asar handling, for deleting whole app bundles.
const rawFs = require('original-fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const REPO = '830prod/LUTviewer';
const ASSET_NAME = 'LUTviewer.dmg';
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const BUNDLE_ID = 'com.830productions.lutviewer';

let ctx = null;          // { getWindow, getSettings, saveSettings }
let latest = null;       // release info for the pending update
let busy = false;
let timer = null;

const currentVersion = () => process.env.LUTV_FAKE_VERSION || app.getVersion();

function send(channel, payload) {
  const win = ctx && ctx.getWindow();
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

// "1.10.0" > "1.9.2"; pre-release suffixes are ignored.
function isNewer(a, b) {
  const pa = String(a).replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  const pb = String(b).replace(/^v/, '').split(/[.-]/).map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
}

async function fetchLatest() {
  const res = await net.fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
    headers: { Accept: 'application/vnd.github+json', 'User-Agent': `LUTviewer/${app.getVersion()}` },
  });
  if (!res.ok) throw new Error(`GitHub responded ${res.status}`);
  const rel = await res.json();
  const asset = (rel.assets || []).find((a) => a.name === ASSET_NAME);
  return {
    version: String(rel.tag_name || '').replace(/^v/, ''),
    notes: rel.body || '',
    page: rel.html_url,
    url: asset && asset.browser_download_url,
    size: asset ? asset.size : 0,
    digest: asset && asset.digest, // "sha256:…" when GitHub provides it
  };
}

async function check({ manual = false } = {}) {
  if (busy) return;
  try {
    const rel = await fetchLatest();
    const settings = ctx.getSettings();
    if (rel.url && isNewer(rel.version, currentVersion())) {
      if (!manual && settings.skipVersion === rel.version) return;
      latest = rel;
      send('update:available', { version: rel.version, current: currentVersion(), notes: rel.notes, size: rel.size });
      if (process.env.LUTV_AUTO_INSTALL) install();
    } else if (manual) {
      dialog.showMessageBox(ctx.getWindow(), {
        type: 'info', message: 'LUTviewer is up to date',
        detail: `You have the latest version (${currentVersion()}).`,
      });
    }
  } catch (err) {
    if (manual) {
      dialog.showMessageBox(ctx.getWindow(), {
        type: 'warning', message: "Couldn't check for updates",
        detail: `Make sure you're online and try again.\n\n${err.message}`,
      });
    }
  }
}

async function download(rel) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'LUTviewer-update-'));
  const file = path.join(dir, ASSET_NAME);
  const res = await net.fetch(rel.url, { headers: { 'User-Agent': `LUTviewer/${app.getVersion()}` } });
  if (!res.ok || !res.body) throw new Error(`Download failed (${res.status})`);
  const total = Number(res.headers.get('content-length')) || rel.size || 0;
  const hash = crypto.createHash('sha256');
  const out = fs.createWriteStream(file);
  let received = 0, lastSent = 0;
  const reader = res.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    hash.update(value);
    received += value.length;
    if (!out.write(value)) await new Promise((r) => out.once('drain', r));
    const now = Date.now();
    if (now - lastSent > 150) { lastSent = now; send('update:progress', { phase: 'download', received, total }); }
  }
  await new Promise((resolve, reject) => out.end((err) => (err ? reject(err) : resolve())));
  if (rel.digest && rel.digest.startsWith('sha256:') && rel.digest.slice(7) !== hash.digest('hex')) {
    throw new Error('The downloaded update failed its integrity check');
  }
  return { dir, file };
}

// The running .app bundle, e.g. /Applications/LUTviewer.app
function currentBundle() {
  return path.resolve(process.execPath, '..', '..', '..');
}

function canReplaceInPlace(bundle) {
  if (!app.isPackaged || !bundle.endsWith('.app')) return false;
  if (bundle.includes('/AppTranslocation/') || bundle.startsWith('/Volumes/')) return false;
  try { fs.accessSync(path.dirname(bundle), fs.constants.W_OK); return true; } catch { return false; }
}

async function swapBundle(dmg, bundle) {
  const mount = await fsp.mkdtemp(path.join(os.tmpdir(), 'LUTviewer-mount-'));
  await run('/usr/bin/hdiutil', ['attach', dmg, '-nobrowse', '-readonly', '-noautoopen', '-mountpoint', mount]);
  try {
    const name = (await fsp.readdir(mount)).find((n) => n.endsWith('.app'));
    if (!name) throw new Error('No app found in the update');
    const source = path.join(mount, name);
    const id = (await run('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', path.join(source, 'Contents', 'Info.plist')])).trim();
    if (id !== BUNDLE_ID) throw new Error('The update is not a LUTviewer build');

    const parent = path.dirname(bundle);
    const staged = path.join(parent, `.LUTviewer-update-${Date.now()}.app`);
    const backup = path.join(parent, `.LUTviewer-previous-${Date.now()}.app`);
    await run('/usr/bin/ditto', [source, staged]);
    await run('/usr/bin/xattr', ['-cr', staged]).catch(() => {});
    await fsp.rename(bundle, backup);
    try {
      await fsp.rename(staged, bundle);
    } catch (err) {
      await fsp.rename(backup, bundle); // put the old version back
      throw err;
    }
    // The old bundle is still in use until we relaunch; init() deletes it next launch.
  } finally {
    await run('/usr/bin/hdiutil', ['detach', mount, '-quiet']).catch(() => run('/usr/bin/hdiutil', ['detach', mount, '-force']));
  }
}

async function install() {
  if (busy || !latest) return;
  busy = true;
  let dl = null;
  try {
    send('update:progress', { phase: 'download', received: 0, total: latest.size });
    dl = await download(latest);
    const bundle = currentBundle();
    if (!canReplaceInPlace(bundle)) {
      send('update:progress', { phase: 'manual' });
      await shell.openPath(dl.file);
      busy = false;
      return;
    }
    send('update:progress', { phase: 'install' });
    await swapBundle(dl.file, bundle);
    send('update:progress', { phase: 'restart' });
    await fsp.rm(dl.dir, { recursive: true, force: true }).catch(() => {});
    setTimeout(() => { app.relaunch(); app.exit(0); }, 900);
  } catch (err) {
    busy = false;
    send('update:progress', { phase: 'error', message: err.message });
    if (dl) shell.openPath(dl.file); // fall back to a manual drag-install
  }
}

function skip() {
  if (!latest) return;
  ctx.getSettings().skipVersion = latest.version;
  ctx.saveSettings();
}

function setAutoCheck(on) {
  ctx.getSettings().autoUpdate = on;
  ctx.saveSettings();
  schedule();
}

function autoCheckEnabled() {
  return ctx.getSettings().autoUpdate !== false;
}

function schedule() {
  clearInterval(timer);
  timer = null;
  if (!autoCheckEnabled()) return;
  if (!app.isPackaged && !process.env.LUTV_FAKE_VERSION) return; // don't nag during development
  setTimeout(() => check(), 6000);
  timer = setInterval(() => check(), CHECK_EVERY_MS);
}

function init(context) {
  ctx = context;
  // Remove the previous version left behind by the last update (in the background,
  // since deleting a whole app bundle takes a few seconds).
  setTimeout(async () => {
    const parent = path.dirname(currentBundle());
    let names = [];
    try { names = await rawFs.promises.readdir(parent); } catch { return; }
    for (const n of names) {
      if (/^\.LUTviewer-(update|previous)-\d+\.app$/.test(n)) {
        await rawFs.promises.rm(path.join(parent, n), { recursive: true, force: true }).catch(() => {});
      }
    }
  }, 3000);
}

module.exports = { init, schedule, check, install, skip, setAutoCheck, autoCheckEnabled, isNewer };
