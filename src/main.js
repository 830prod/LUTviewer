'use strict';

const { app, BrowserWindow, ipcMain, protocol, dialog, screen, shell, Menu, nativeTheme, net } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { Readable } = require('node:stream');
const LutParser = require('./renderer/lut.js');
const updater = require('./updater.js');

const SCHEME = 'lutv';
const RENDERER_DIR = path.join(__dirname, 'renderer');
const ASSETS_DIR = path.join(__dirname, '..', 'assets');
const SPLASH_MIN_MS = 2200;
const PROXY_SECONDS = 30;

const LUT_EXT = new Set(['.cube', '.3dl']);
const VIDEO_EXT = new Set(['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.mxf']);
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp']);
const CONVERT_IMAGE_EXT = new Set(['.tif', '.tiff', '.heic', '.heif', '.dng']);

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true } },
]);

// Dev/testing hooks: isolated profile, paths on the command line, and an automatic window capture.
if (process.env.LUTV_USER_DATA) app.setPath('userData', process.env.LUTV_USER_DATA);
const CAPTURE_TO = process.env.LUTV_CAPTURE;

let splashWin = null;
let aboutWin = null;
let mainWin = null;
let splashShownAt = 0;
let updaterStarted = false;
const pendingOpen = [];
const allowedMedia = new Set();

// ---------- Paths & persistence ----------
const dataDir = () => app.getPath('userData');
const lutDir = () => path.join(dataDir(), 'LUTs');
const libraryFile = () => path.join(dataDir(), 'library.json');
const settingsFile = () => path.join(dataDir(), 'settings.json');
const proxyDir = () => path.join(app.getPath('temp'), 'LUTviewer-proxies');

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function writeJSON(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

let library = null;
function getLibrary() {
  if (!library) library = readJSON(libraryFile(), { luts: [] });
  return library;
}
function saveLibrary() { writeJSON(libraryFile(), getLibrary()); }

let settings = null;
function getSettings() {
  if (!settings) settings = readJSON(settingsFile(), {});
  return settings;
}
function saveSettings() { writeJSON(settingsFile(), getSettings()); }

// ---------- Protocol: app pages + media with HTTP range support ----------
const MIME = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.gif': 'image/gif', '.bmp': 'image/bmp', '.mp4': 'video/mp4', '.m4v': 'video/mp4',
  '.mov': 'video/quicktime', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
};

async function serveFile(filePath, request) {
  let stat;
  try { stat = await fsp.stat(filePath); } catch { return new Response('Not found', { status: 404 }); }
  const type = MIME[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  const range = request.headers.get('range');
  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range);
    let start = m && m[1] ? parseInt(m[1], 10) : 0;
    let end = m && m[2] ? parseInt(m[2], 10) : stat.size - 1;
    if (m && !m[1] && m[2]) { start = stat.size - parseInt(m[2], 10); end = stat.size - 1; }
    end = Math.min(end, stat.size - 1);
    if (start > end || start >= stat.size) {
      return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${stat.size}` } });
    }
    const stream = Readable.toWeb(fs.createReadStream(filePath, { start, end }));
    return new Response(stream, {
      status: 206,
      headers: {
        'Content-Type': type, 'Accept-Ranges': 'bytes',
        'Content-Range': `bytes ${start}-${end}/${stat.size}`, 'Content-Length': String(end - start + 1),
      },
    });
  }
  return new Response(Readable.toWeb(fs.createReadStream(filePath)), {
    headers: { 'Content-Type': type, 'Accept-Ranges': 'bytes', 'Content-Length': String(stat.size) },
  });
}

function registerProtocol() {
  protocol.handle(SCHEME, (request) => {
    const url = new URL(request.url);
    const rel = decodeURIComponent(url.pathname).replace(/^\/+/, '');
    if (url.host === 'app' || url.host === 'assets') {
      const base = url.host === 'app' ? RENDERER_DIR : ASSETS_DIR;
      const file = path.normalize(path.join(base, rel));
      if (!file.startsWith(base)) return new Response('Forbidden', { status: 403 });
      return serveFile(file, request);
    }
    if (url.host === 'media') {
      const file = '/' + rel;
      if (!allowedMedia.has(file)) return new Response('Forbidden', { status: 403 });
      return serveFile(file, request);
    }
    return new Response('Not found', { status: 404 });
  });
}

function mediaUrl(filePath) {
  allowedMedia.add(filePath);
  return `${SCHEME}://media/${filePath.split('/').map(encodeURIComponent).join('/').replace(/^\//, '')}`;
}

// ---------- Dock icon follows the system appearance ----------
function updateDockIcon() {
  if (!app.dock) return;
  app.dock.setIcon(path.join(ASSETS_DIR, nativeTheme.shouldUseDarkColors ? 'icon-dark.png' : 'icon-light.png'));
}

// ---------- Ratings ----------
// Only the star count is sent (anonymously, and only when the user chooses to rate).
const RATING_ENDPOINT = 'https://830lutviewer.goatcounter.com/count';
async function sendRating(stars) {
  const n = Math.max(1, Math.min(5, Math.round(stars)));
  const params = new URLSearchParams({
    p: `rating/${n}-stars/v${app.getVersion()}`, t: `Rated ${n} stars`, e: 'true', rnd: String(Math.random()).slice(2),
  });
  try {
    await net.fetch(`${RATING_ENDPOINT}?${params}`, { headers: { 'User-Agent': `LUTviewer/${app.getVersion()} (Macintosh)` } });
    return true;
  } catch {
    return false;
  }
}

// ---------- Windows ----------
function showAbout() {
  if (aboutWin) { aboutWin.focus(); return; }
  aboutWin = new BrowserWindow({
    width: 380, height: 560, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    show: false, titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#021C30', title: 'About LUTviewer', parent: mainWin || undefined,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  aboutWin.loadURL(`${SCHEME}://app/about.html`);
  aboutWin.once('ready-to-show', () => aboutWin.show());
  aboutWin.on('closed', () => { aboutWin = null; });
  aboutWin.webContents.on('will-navigate', (e) => e.preventDefault());
}

function createSplash() {
  splashWin = new BrowserWindow({
    width: 560, height: 315, frame: false, resizable: false, movable: true, show: false,
    transparent: true, hasShadow: true, center: true, alwaysOnTop: true, skipTaskbar: true,
    backgroundColor: '#00000000',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  splashWin.loadURL(`${SCHEME}://app/splash.html`);
  splashWin.once('ready-to-show', () => {
    splashWin.show();
    splashShownAt = Date.now();
    if (process.env.LUTV_CAPTURE_SPLASH) {
      setTimeout(async () => fs.writeFileSync(process.env.LUTV_CAPTURE_SPLASH, (await splashWin.webContents.capturePage()).toPNG()), 1200);
    }
  });
  splashWin.on('closed', () => { splashWin = null; });
}

function sideBounds(width) {
  const area = screen.getPrimaryDisplay().workArea;
  const w = Math.min(width, area.width);
  return { x: area.x + area.width - w, y: area.y, width: w, height: area.height };
}

function createMain() {
  const s = getSettings();
  const bounds = s.bounds && boundsVisible(s.bounds) ? s.bounds : sideBounds(440);
  mainWin = new BrowserWindow({
    ...bounds, minWidth: 360, minHeight: 560, show: false,
    titleBarStyle: 'hiddenInset', trafficLightPosition: { x: 14, y: 14 },
    backgroundColor: '#021C30', alwaysOnTop: !!s.pinned,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, sandbox: true },
  });
  if (s.pinned) mainWin.setAlwaysOnTop(true, 'floating');
  mainWin.loadURL(`${SCHEME}://app/index.html`);
  const remember = () => { if (mainWin && !mainWin.isMinimized()) { getSettings().bounds = mainWin.getBounds(); saveSettings(); } };
  mainWin.on('moved', remember);
  mainWin.on('resized', remember);
  mainWin.on('closed', () => { mainWin = null; });
  mainWin.webContents.setWindowOpenHandler(({ url }) => { shell.openExternal(url); return { action: 'deny' }; });
  mainWin.webContents.on('will-navigate', (e) => e.preventDefault());
}

function boundsVisible(b) {
  return screen.getAllDisplays().some(({ workArea: a }) =>
    b.x < a.x + a.width && b.x + b.width > a.x && b.y < a.y + a.height && b.y + b.height > a.y);
}

function revealMain() {
  const wait = Math.max(0, SPLASH_MIN_MS - (Date.now() - splashShownAt));
  setTimeout(() => {
    if (mainWin) { mainWin.show(); mainWin.focus(); }
    if (splashWin) splashWin.close();
    flushPendingOpen();
    if (!updaterStarted) { updaterStarted = true; updater.schedule(); }
    if (process.env.LUTV_OPEN_ABOUT) showAbout();
    if (CAPTURE_TO && mainWin) {
      setTimeout(async () => {
        const img = await mainWin.webContents.capturePage();
        fs.writeFileSync(CAPTURE_TO, img.toPNG());
        if (process.env.LUTV_QUIT_AFTER_CAPTURE) app.quit();
      }, Number(process.env.LUTV_CAPTURE_DELAY || 4000));
    }
  }, wait);
}

// ---------- Opening files (drag onto Dock icon / Open With) ----------
function flushPendingOpen() {
  if (!mainWin || !mainWin.isVisible()) return;
  while (pendingOpen.length) mainWin.webContents.send('app:open-paths', [pendingOpen.shift()]);
}

app.on('open-file', (event, filePath) => {
  event.preventDefault();
  pendingOpen.push(filePath);
  flushPendingOpen();
});

// ---------- LUT library ----------
async function walk(p, out, depth = 0) {
  let st;
  try { st = await fsp.stat(p); } catch { return; }
  if (st.isDirectory()) {
    if (depth > 6) return;
    for (const name of await fsp.readdir(p)) {
      if (name.startsWith('.')) continue;
      await walk(path.join(p, name), out, depth + 1);
    }
  } else if (LUT_EXT.has(path.extname(p).toLowerCase())) {
    out.push(p);
  }
}

async function importLuts(inputPaths) {
  const files = [];
  for (const p of inputPaths) await walk(p, files);
  await fsp.mkdir(lutDir(), { recursive: true });
  const lib = getLibrary();
  const added = [], skipped = [];
  for (const file of files) {
    const text = await fsp.readFile(file, 'utf8').catch(() => null);
    const base = path.basename(file);
    if (text == null) { skipped.push({ file: base, reason: 'Could not read file' }); continue; }
    try { LutParser.parseLut(text, file); } catch (e) { skipped.push({ file: base, reason: e.message }); continue; }
    const hash = crypto.createHash('sha1').update(text).digest('hex').slice(0, 12);
    if (lib.luts.some((l) => l.hash === hash)) { skipped.push({ file: base, reason: 'Already in library' }); continue; }
    const id = `${Date.now().toString(36)}-${hash}`;
    const stored = `${id}${path.extname(file).toLowerCase()}`;
    await fsp.writeFile(path.join(lutDir(), stored), text);
    const name = path.basename(file, path.extname(file));
    const parent = path.basename(path.dirname(file));
    const entry = {
      id, hash, name, file: stored, group: parent,
      logInput: LutParser.guessLogInput(name), favorite: false, addedAt: Date.now(),
    };
    lib.luts.push(entry);
    added.push(entry);
  }
  saveLibrary();
  return { added, skipped };
}

// ---------- Media preparation ----------
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    execFile(cmd, args, { maxBuffer: 1 << 24 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout);
    });
  });
}

async function prepareMedia(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  const name = path.basename(filePath);
  if (IMAGE_EXT.has(ext)) return { kind: 'image', url: mediaUrl(filePath), name, path: filePath };
  if (CONVERT_IMAGE_EXT.has(ext)) {
    await fsp.mkdir(proxyDir(), { recursive: true });
    const out = path.join(proxyDir(), `${crypto.createHash('sha1').update(filePath).digest('hex').slice(0, 12)}.png`);
    await run('/usr/bin/sips', ['-s', 'format', 'png', filePath, '--out', out]);
    return { kind: 'image', url: mediaUrl(out), name, path: filePath };
  }
  if (VIDEO_EXT.has(ext)) return { kind: 'video', url: mediaUrl(filePath), name, path: filePath };
  throw new Error(`${name} is not a supported video or image file`);
}

// Chromium can't decode ProRes; macOS's built-in avconvert makes a short H.264/HEVC proxy.
async function makeProxy(filePath) {
  await fsp.mkdir(proxyDir(), { recursive: true });
  const st = await fsp.stat(filePath);
  const key = crypto.createHash('sha1').update(`${filePath}:${st.size}:${st.mtimeMs}`).digest('hex').slice(0, 12);
  const out = path.join(proxyDir(), `${key}.mov`);
  if (!fs.existsSync(out)) {
    const tmp = path.join(proxyDir(), `${key}.partial.mov`);
    await run('/usr/bin/avconvert', [
      '--source', filePath, '--output', tmp, '--preset', 'PresetHEVC1920x1080',
      '--duration', String(PROXY_SECONDS), '--replace',
    ]).catch(() => run('/usr/bin/avconvert', [
      '--source', filePath, '--output', tmp, '--preset', 'Preset1920x1080',
      '--duration', String(PROXY_SECONDS), '--replace',
    ]));
    await fsp.rename(tmp, out);
  }
  return { kind: 'video', url: mediaUrl(out), proxy: true, proxySeconds: PROXY_SECONDS };
}

// ---------- IPC ----------
function registerIpc() {
  ipcMain.handle('library:list', () => getLibrary().luts);
  ipcMain.handle('library:read', async (_e, id) => {
    const entry = getLibrary().luts.find((l) => l.id === id);
    if (!entry) throw new Error('LUT not found');
    return fsp.readFile(path.join(lutDir(), entry.file), 'utf8');
  });
  ipcMain.handle('library:import', (_e, paths) => importLuts(paths));
  ipcMain.handle('library:update', (_e, id, patch) => {
    const entry = getLibrary().luts.find((l) => l.id === id);
    if (!entry) return null;
    for (const k of ['name', 'logInput', 'favorite', 'group']) if (k in patch) entry[k] = patch[k];
    saveLibrary();
    return entry;
  });
  ipcMain.handle('library:remove', async (_e, id) => {
    const lib = getLibrary();
    const entry = lib.luts.find((l) => l.id === id);
    if (!entry) return false;
    lib.luts = lib.luts.filter((l) => l.id !== id);
    saveLibrary();
    // Move the stored copy to the Trash rather than deleting it outright.
    await shell.trashItem(path.join(lutDir(), entry.file)).catch(() => {});
    return true;
  });
  ipcMain.handle('library:reveal', () => { fs.mkdirSync(lutDir(), { recursive: true }); shell.openPath(lutDir()); });

  ipcMain.handle('dialog:luts', async () => {
    const r = await dialog.showOpenDialog(mainWin, {
      title: 'Add LUTs', buttonLabel: 'Add',
      properties: ['openFile', 'openDirectory', 'multiSelections'],
      filters: [{ name: 'LUTs', extensions: ['cube', '3dl'] }],
    });
    return r.canceled ? [] : r.filePaths;
  });
  ipcMain.handle('dialog:media', async () => {
    const r = await dialog.showOpenDialog(mainWin, {
      title: 'Open footage', properties: ['openFile'],
      filters: [{ name: 'Footage & stills', extensions: [...VIDEO_EXT, ...IMAGE_EXT, ...CONVERT_IMAGE_EXT].map((e) => e.slice(1)) }],
    });
    return r.canceled ? null : r.filePaths[0];
  });

  ipcMain.handle('media:prepare', (_e, p) => prepareMedia(p));
  ipcMain.handle('media:proxy', (_e, p) => makeProxy(p));

  ipcMain.handle('settings:get', () => getSettings());
  ipcMain.handle('settings:set', (_e, patch) => {
    Object.assign(getSettings(), patch);
    saveSettings();
    return getSettings();
  });

  ipcMain.handle('window:pin', (_e, on) => {
    if (!mainWin) return false;
    mainWin.setAlwaysOnTop(on, 'floating');
    getSettings().pinned = on;
    saveSettings();
    return on;
  });
  ipcMain.handle('window:dock', () => {
    if (!mainWin) return;
    const b = sideBounds(mainWin.getBounds().width);
    mainWin.setBounds(b, true);
  });

  ipcMain.on('app:progress', (_e, info) => { if (splashWin) splashWin.webContents.send('splash:progress', info); });
  ipcMain.on('app:ready', () => revealMain());

  ipcMain.handle('update:install', () => updater.install());
  ipcMain.handle('update:skip', () => updater.skip());
  ipcMain.handle('update:check', () => updater.check({ manual: true }));
  ipcMain.handle('app:version', () => app.getVersion());

  ipcMain.handle('rating:send', (_e, stars) => sendRating(stars));
  ipcMain.handle('about:info', () => {
    const st = getSettings();
    return {
      version: app.getVersion(),
      electron: process.versions.electron,
      chrome: process.versions.chrome,
      arch: process.arch,
      lutCount: getLibrary().luts.length,
      favorites: getLibrary().luts.filter((l) => l.favorite).length,
      exports: st.exportCount || 0,
      usageSeconds: st.usageSeconds || 0,
      autoUpdate: st.autoUpdate !== false,
    };
  });
  ipcMain.handle('about:rate', () => {
    if (aboutWin) aboutWin.close();
    if (mainWin) { mainWin.show(); mainWin.focus(); mainWin.webContents.send('menu:rate'); }
  });
  ipcMain.handle('shell:open-url', (_e, url) => {
    if (/^https:\/\/(github\.com\/830prod\/LUTviewer|830prod\.github\.io\/LUTviewer)(\/|$)/.test(url)) shell.openExternal(url);
  });

  ipcMain.handle('export:save', async (_e, data, suggested) => {
    const r = await dialog.showSaveDialog(mainWin, {
      title: 'Save before / after video',
      defaultPath: path.join(app.getPath('movies'), suggested.replace(/[\/:*?"<>|]+/g, '-')),
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    if (r.canceled || !r.filePath) return null;
    await fsp.writeFile(r.filePath, Buffer.from(data));
    return r.filePath;
  });
  ipcMain.handle('shell:reveal', (_e, p) => shell.showItemInFolder(p));
}

// ---------- Menu ----------
function buildMenu() {
  const send = (ch) => () => mainWin && mainWin.webContents.send(ch);
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    {
      role: 'appMenu',
      submenu: [
        { label: 'About LUTviewer', click: showAbout },
        { label: 'Check for Updates…', click: () => updater.check({ manual: true }) },
        { label: 'Rate LUTviewer…', click: send('menu:rate') },
        {
          label: 'Automatically Check for Updates', type: 'checkbox', checked: updater.autoCheckEnabled(),
          click: (item) => updater.setAutoCheck(item.checked),
        },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' }, { role: 'hideOthers' }, { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'File',
      submenu: [
        { label: 'Open Footage…', accelerator: 'CmdOrCtrl+O', click: send('menu:open-media') },
        { label: 'Add LUTs…', accelerator: 'CmdOrCtrl+Shift+L', click: send('menu:add-luts') },
        { label: 'Export Before / After Video…', accelerator: 'CmdOrCtrl+E', click: send('menu:export') },
        { type: 'separator' },
        { label: 'Show LUT Library in Finder', click: () => { fs.mkdirSync(lutDir(), { recursive: true }); shell.openPath(lutDir()); } },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { label: 'Dock to Right Edge', accelerator: 'CmdOrCtrl+Shift+D', click: () => mainWin && mainWin.setBounds(sideBounds(mainWin.getBounds().width), true) },
        { type: 'separator' },
        { role: 'reload' }, { role: 'toggleDevTools' }, { type: 'separator' }, { role: 'togglefullscreen' },
      ],
    },
    { role: 'windowMenu' },
  ]));
}

// ---------- Lifecycle ----------
if (!app.isPackaged) {
  for (const arg of process.argv.slice(2)) if (arg.startsWith('/') && fs.existsSync(arg)) pendingOpen.push(arg);
}

app.whenReady().then(() => {
  registerProtocol();
  registerIpc();
  updater.init({ getWindow: () => mainWin, getSettings, saveSettings });
  buildMenu();
  updateDockIcon();
  nativeTheme.on('updated', updateDockIcon);
  createSplash();
  createMain();
  app.on('activate', () => { if (!mainWin) createMain(); });
});

app.on('window-all-closed', () => app.quit());
app.on('will-quit', () => { fs.rmSync(proxyDir(), { recursive: true, force: true }); });
