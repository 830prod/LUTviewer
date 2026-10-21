'use strict';

const CS = window.ColorScience;
const api = window.lutviewer;
const $ = (id) => document.getElementById(id);

const LUT_EXT = ['.cube', '.3dl'];
const MEDIA_EXT = ['.mp4', '.mov', '.m4v', '.mkv', '.webm', '.mxf', '.jpg', '.jpeg', '.png', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.heic', '.heif', '.dng'];
const THUMB_W = 256;
const PLAYING_THUMB_MS = 1200;

const state = {
  luts: [],              // library entries from main
  broken: new Set(),     // ids that failed to parse
  activeId: null,
  cameraId: 'sony-slog3c',
  tone: 'filmic',
  exposure: 0,
  fullRange: false,
  intensity: 1,
  split: false,
  splitPos: 0.5,
  showOriginal: false,
  search: '',
  favOnly: false,
  source: null,          // { kind: 'chart'|'video'|'image', el, name, proxy }
};

let renderer;
const thumbs = new Map();  // id ('' = no LUT) -> { card, canvas, visible }
const dirty = new Set();
let pumpQueued = false;
let lastPlayingThumbs = 0;
let observer;

// ---------- Helpers ----------
const ext = (p) => { const m = /\.[^./]+$/.exec(p); return m ? m[0].toLowerCase() : ''; };
const camera = () => CS.CAMERAS.find((c) => c.id === state.cameraId) || CS.CAMERAS[0];
const effectiveCamera = () => (state.source && state.source.kind === 'chart' ? CS.CAMERAS[0] : camera());
const activeEntry = () => state.luts.find((l) => l.id === state.activeId) || null;
const saveSettings = (patch) => api.settings.set(patch);

function toast(msg, ms = 3800) {
  const t = $('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => { t.hidden = true; }, ms);
}

function busy(text) {
  $('busy').hidden = !text;
  if (text) $('busyText').textContent = text;
}

function fmtTime(s) {
  if (!isFinite(s)) return '--:--';
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

function renderParams() {
  const entry = activeEntry();
  return {
    camera: effectiveCamera(),
    tone: state.tone,
    exposure: state.exposure,
    fullRange: state.fullRange,
    lutId: entry && !state.broken.has(entry.id) ? entry.id : null,
    lutLogInput: entry ? entry.logInput : false,
    intensity: state.intensity,
    split: state.split ? state.splitPos : -1,
    showOriginal: state.showOriginal,
  };
}

// ---------- Drawing ----------
function sizeCanvas() {
  const src = state.source;
  if (!src) return;
  const w = renderer.sourceW || 16, h = renderer.sourceH || 9;
  const stage = $('stage');
  stage.style.aspectRatio = `${w} / ${h}`;
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.min(w, Math.round(stage.clientWidth * dpr));
  const canvas = $('view');
  canvas.width = cw;
  canvas.height = Math.max(1, Math.round(cw * h / w));
}

function draw(upload = true) {
  const src = state.source;
  if (!src) return;
  if (upload) {
    const wasW = renderer.sourceW, wasH = renderer.sourceH;
    if (!renderer.upload(src.el)) return;
    if (wasW !== renderer.sourceW || wasH !== renderer.sourceH) sizeCanvas();
  }
  renderer.render(renderParams());
}

let drawQueued = false;
function queueDraw() {
  if (drawQueued) return;
  drawQueued = true;
  requestAnimationFrame(() => { drawQueued = false; draw(true); });
}

// ---------- Thumbnails ----------
function thumbSize() {
  const w = renderer.sourceW || 16, h = renderer.sourceH || 9;
  return [THUMB_W, Math.max(64, Math.min(THUMB_W, Math.round(THUMB_W * h / w)))];
}

function refreshThumbs() {
  for (const id of thumbs.keys()) dirty.add(id);
  queuePump();
}

function queuePump() {
  if (pumpQueued) return;
  pumpQueued = true;
  requestAnimationFrame(pump);
}

function pump() {
  pumpQueued = false;
  if (!state.source || !renderer.sourceW) return;
  const [w, h] = thumbSize();
  const p = renderParams();
  const start = performance.now();
  for (const id of dirty) {
    const t = thumbs.get(id);
    if (!t) { dirty.delete(id); continue; }
    if (!t.visible) continue;
    const entry = state.luts.find((l) => l.id === id);
    if (t.canvas.width !== w || t.canvas.height !== h) { t.canvas.width = w; t.canvas.height = h; }
    const img = renderer.renderThumb(p, id && !state.broken.has(id) ? id : null, entry ? entry.logInput : false, w, h);
    t.canvas.getContext('2d').putImageData(img, 0, 0);
    dirty.delete(id);
    if (performance.now() - start > 12) break; // keep the UI responsive
  }
  if ([...dirty].some((id) => thumbs.get(id)?.visible)) queuePump();
}

// ---------- Library grid ----------
function visibleLuts() {
  const q = state.search.trim().toLowerCase();
  return state.luts
    .filter((l) => (!state.favOnly || l.favorite) && (!q || `${l.name} ${l.group}`.toLowerCase().includes(q)))
    .sort((a, b) => (a.group || '').localeCompare(b.group || '') || a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// Order used by next/previous: "No LUT" first, then the grid order.
const navOrder = () => [null, ...visibleLuts().map((l) => l.id)];

function makeCard(entry) {
  const id = entry ? entry.id : '';
  const card = document.createElement('div');
  card.className = 'card' + (entry ? '' : ' none');
  card.tabIndex = 0;
  card.dataset.id = id;
  const canvas = document.createElement('canvas');
  const meta = document.createElement('div');
  meta.className = 'meta';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = entry ? entry.name : 'No LUT';
  name.title = entry ? `${entry.name}${entry.group ? ` — ${entry.group}` : ''}` : 'Camera conversion only';
  meta.append(name);
  if (entry && entry.logInput) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'LOG';
    tag.title = 'Applied straight to log footage';
    meta.append(tag);
  }
  if (entry && state.broken.has(entry.id)) {
    const tag = document.createElement('span');
    tag.className = 'tag';
    tag.textContent = 'ERR';
    tag.title = 'This LUT could not be read';
    meta.append(tag);
  }
  card.append(canvas, meta);
  if (entry && entry.favorite) {
    const star = document.createElement('span');
    star.className = 'star';
    star.textContent = '★';
    card.append(star);
  }
  card.addEventListener('click', () => selectLut(entry ? entry.id : null));
  if (entry) card.addEventListener('contextmenu', (e) => { e.preventDefault(); openCardMenu(entry, e.clientX, e.clientY); });
  thumbs.set(id, { card, canvas, visible: false });
  observer.observe(card);
  dirty.add(id);
  return card;
}

function buildGrid() {
  const grid = $('grid');
  for (const t of thumbs.values()) observer.unobserve(t.card);
  thumbs.clear();
  dirty.clear();
  grid.textContent = '';
  const list = visibleLuts();
  grid.append(makeCard(null));
  const groups = new Set(list.map((l) => l.group || ''));
  let lastGroup = null;
  for (const entry of list) {
    if (groups.size > 1 && entry.group !== lastGroup) {
      const h = document.createElement('div');
      h.className = 'group-title';
      h.textContent = entry.group || 'Ungrouped';
      grid.append(h);
      lastGroup = entry.group;
    }
    grid.append(makeCard(entry));
  }
  $('lutCount').textContent = state.luts.length;
  $('libEmpty').hidden = state.luts.length > 0;
  markActive();
  queuePump();
}

function markActive() {
  for (const [id, t] of thumbs) t.card.classList.toggle('active', (id || null) === state.activeId);
}

// ---------- Active LUT ----------
function selectLut(id, { scroll = false } = {}) {
  state.activeId = id;
  const entry = activeEntry();
  $('activeName').textContent = entry ? entry.name : 'No LUT';
  $('activeName').title = entry ? entry.name : '';
  $('btnFav').classList.toggle('on', !!(entry && entry.favorite));
  $('btnFav').disabled = !entry;
  setSeg('lutInput', entry ? (entry.logInput ? 'log' : 'rec709') : null);
  for (const b of $('lutInput').children) b.disabled = !entry;
  markActive();
  if (scroll) thumbs.get(id || '')?.card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  queueDraw();
  saveSettings({ activeId: id });
}

function step(dir) {
  const order = navOrder();
  const i = order.indexOf(state.activeId);
  const next = order[(i + dir + order.length) % order.length];
  selectLut(next, { scroll: true });
}

async function updateEntry(id, patch) {
  const updated = await api.library.update(id, patch);
  const i = state.luts.findIndex((l) => l.id === id);
  if (updated && i >= 0) state.luts[i] = updated;
  buildGrid();
  selectLut(state.activeId);
  refreshThumbs();
}

// ---------- Card context menu ----------
let menuEntry = null;
function openCardMenu(entry, x, y) {
  menuEntry = entry;
  const m = $('cardMenu');
  m.querySelector('[data-act=fav]').textContent = entry.favorite ? 'Remove from favorites' : 'Add to favorites';
  m.querySelector('[data-act=input]').textContent = entry.logInput ? 'Treat as a Look (Rec.709 in)' : 'Treat as Log-input LUT';
  m.hidden = false;
  const r = m.getBoundingClientRect();
  m.style.left = `${Math.min(x, innerWidth - r.width - 8)}px`;
  m.style.top = `${Math.min(y, innerHeight - r.height - 8)}px`;
}

function closeMenu() { $('cardMenu').hidden = true; }

$('cardMenu').addEventListener('click', async (e) => {
  const act = e.target.dataset.act;
  const entry = menuEntry;
  closeMenu();
  if (!act || !entry) return;
  if (act === 'fav') updateEntry(entry.id, { favorite: !entry.favorite });
  if (act === 'input') updateEntry(entry.id, { logInput: !entry.logInput });
  if (act === 'rename') startRename(entry);
  if (act === 'remove') {
    await api.library.remove(entry.id);
    renderer.removeLut(entry.id);
    state.luts = state.luts.filter((l) => l.id !== entry.id);
    if (state.activeId === entry.id) state.activeId = null;
    buildGrid();
    selectLut(state.activeId);
    toast(`Removed “${entry.name}” (moved to Trash)`);
  }
});
document.addEventListener('mousedown', (e) => { if (!$('cardMenu').contains(e.target)) closeMenu(); });

function startRename(entry) {
  const t = thumbs.get(entry.id);
  if (!t) return;
  const el = t.card.querySelector('.name');
  el.contentEditable = 'true';
  el.focus();
  document.getSelection().selectAllChildren(el);
  const finish = (save) => {
    el.contentEditable = 'false';
    const name = el.textContent.trim();
    if (save && name && name !== entry.name) updateEntry(entry.id, { name });
    else el.textContent = entry.name;
  };
  el.addEventListener('keydown', function onKey(e) {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); el.removeEventListener('keydown', onKey); finish(true); }
    if (e.key === 'Escape') { el.removeEventListener('keydown', onKey); finish(false); }
  });
  el.addEventListener('blur', () => finish(true), { once: true });
}

// ---------- Camera / conversion controls ----------
function buildCameraSelect() {
  const sel = $('camera');
  const brands = [...new Set(CS.CAMERAS.map((c) => c.brand))];
  for (const brand of brands) {
    const og = document.createElement('optgroup');
    og.label = brand;
    for (const c of CS.CAMERAS.filter((x) => x.brand === brand)) {
      const o = document.createElement('option');
      o.value = c.id;
      o.textContent = `${brand === 'Standard' ? '' : brand + ' — '}${c.name}`;
      og.append(o);
    }
    sel.append(og);
  }
  sel.value = state.cameraId;
  sel.addEventListener('change', () => {
    state.cameraId = sel.value;
    saveSettings({ cameraId: sel.value });
    onConversionChange();
  });
}

function updatePipeline() {
  const cam = camera();
  const el = $('pipeline');
  el.textContent = '';
  const chip = (t) => { const i = document.createElement('i'); i.textContent = t; return i; };
  if (state.source && state.source.kind === 'chart') {
    el.append('Test chart is already Rec.709. Your camera setting applies once you drop in footage.');
    return;
  }
  if (cam.curve === 'none') {
    el.append(chip('Rec.709'), ' footage, no conversion');
    return;
  }
  el.append(chip(CS.CURVES[cam.curve].name), ' + ', chip(CS.GAMUTS[cam.gamut].name), ' → ', chip(`Rec.709 · ${state.tone === 'clip' ? 'Clip' : 'Filmic'}`));
}

function setSeg(id, value) {
  for (const b of $(id).children) b.classList.toggle('on', b.dataset.v === value);
}

function onConversionChange() {
  updatePipeline();
  queueDraw();
  refreshThumbs();
}

function bindControls() {
  $('tone').addEventListener('click', (e) => {
    const v = e.target.dataset.v;
    if (!v) return;
    state.tone = v;
    setSeg('tone', v);
    saveSettings({ tone: v });
    onConversionChange();
  });
  $('exposure').addEventListener('input', (e) => {
    state.exposure = +e.target.value;
    $('exposureOut').textContent = (state.exposure > 0 ? '+' : '') + state.exposure.toFixed(1);
    queueDraw();
    clearTimeout(bindControls.expTimer);
    bindControls.expTimer = setTimeout(() => { refreshThumbs(); saveSettings({ exposure: state.exposure }); }, 200);
  });
  $('exposure').addEventListener('dblclick', (e) => { e.target.value = 0; e.target.dispatchEvent(new Event('input')); });
  $('fullRange').addEventListener('change', (e) => {
    state.fullRange = e.target.checked;
    saveSettings({ fullRange: state.fullRange });
    onConversionChange();
  });
  $('intensity').addEventListener('input', (e) => {
    state.intensity = +e.target.value / 100;
    $('intensityOut').textContent = `${e.target.value}%`;
    queueDraw();
  });
  $('intensity').addEventListener('change', () => saveSettings({ intensity: state.intensity }));
  $('lutInput').addEventListener('click', (e) => {
    const v = e.target.dataset.v;
    const entry = activeEntry();
    if (!v || !entry) return;
    updateEntry(entry.id, { logInput: v === 'log' });
  });

  $('btnPrev').addEventListener('click', () => step(-1));
  $('btnNext').addEventListener('click', () => step(1));
  $('btnFav').addEventListener('click', () => { const e = activeEntry(); if (e) updateEntry(e.id, { favorite: !e.favorite }); });
  $('btnFavFilter').addEventListener('click', () => {
    state.favOnly = !state.favOnly;
    $('btnFavFilter').classList.toggle('on', state.favOnly);
    saveSettings({ favOnly: state.favOnly });
    buildGrid();
  });
  $('search').addEventListener('input', (e) => { state.search = e.target.value; buildGrid(); });
  $('btnAddLuts').addEventListener('click', chooseLuts);
  $('btnAddLuts2').addEventListener('click', chooseLuts);
  $('btnOpen').addEventListener('click', chooseMedia);
  $('btnPin').addEventListener('click', async () => {
    const on = await api.win.pin(!$('btnPin').classList.contains('on'));
    $('btnPin').classList.toggle('on', on);
    toast(on ? 'LUTviewer stays on top of other windows' : 'LUTviewer no longer stays on top', 2000);
  });
  $('btnDock').addEventListener('click', () => api.win.dock());

  // Split wipe
  $('btnSplit').addEventListener('click', () => toggleSplit());
  const stage = $('stage');
  const setSplitFrom = (e) => {
    const r = $('view').getBoundingClientRect();
    state.splitPos = Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
    queueDraw();
  };
  stage.addEventListener('pointerdown', (e) => {
    if (!state.split) return;
    stage.setPointerCapture(e.pointerId);
    setSplitFrom(e);
    stage.onpointermove = setSplitFrom;
  });
  stage.addEventListener('pointerup', () => { stage.onpointermove = null; });

  // Transport
  $('btnPlay').addEventListener('click', togglePlay);
  $('scrub').addEventListener('input', (e) => {
    const v = state.source && state.source.kind === 'video' ? state.source.el : null;
    if (v && isFinite(v.duration)) v.currentTime = (e.target.value / 1000) * v.duration;
  });

  new ResizeObserver(() => { sizeCanvas(); queueDraw(); }).observe(stage);
}

function toggleSplit(force) {
  state.split = force ?? !state.split;
  $('btnSplit').classList.toggle('on', state.split);
  $('splitHandle').hidden = !state.split;
  $('stage').classList.toggle('splitting', state.split);
  queueDraw();
}

// ---------- Keyboard ----------
document.addEventListener('keydown', (e) => {
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' && document.activeElement.type !== 'range') return;
  if (tag === 'SELECT' || document.activeElement?.isContentEditable) return;
  if (e.metaKey || e.ctrlKey) return;
  switch (e.key) {
    case 'ArrowDown': case 'ArrowRight': e.preventDefault(); step(1); break;
    case 'ArrowUp': case 'ArrowLeft': e.preventDefault(); step(-1); break;
    case ' ': e.preventDefault(); togglePlay(); break;
    case 'f': case 'F': $('btnFav').click(); break;
    case 's': case 'S': toggleSplit(); break;
    case '0': selectLut(null, { scroll: true }); break;
    case '\\': if (!state.showOriginal) { state.showOriginal = true; queueDraw(); } break;
    case 'Escape': closeMenu(); break;
  }
});
document.addEventListener('keyup', (e) => {
  if (e.key === '\\') { state.showOriginal = false; queueDraw(); }
});

// ---------- Media ----------
function setSource(src) {
  const old = state.source;
  if (old && old.kind === 'video' && old.el !== src.el) { old.el.pause(); old.el.removeAttribute('src'); old.el.load(); }
  state.source = src;
  $('sourceBadge').textContent = src.kind === 'chart' ? 'Test chart' : src.proxy ? `Proxy · first ${src.proxySeconds}s` : src.kind === 'image' ? 'Still' : 'Video';
  $('sourceName').textContent = src.kind === 'chart' ? 'Drop footage anywhere to preview it' : src.name;
  $('sourceName').title = src.path || '';
  const isVideo = src.kind === 'video';
  $('btnPlay').disabled = !isVideo;
  $('scrub').disabled = !isVideo;
  $('time').textContent = isVideo ? fmtTime(src.el.currentTime) : '--:--';
  $('transport').classList.remove('playing');
  renderer.upload(src.el);
  sizeCanvas();
  updatePipeline();
  draw(false);
  refreshThumbs();
}

function loadVideo(url) {
  return new Promise((resolve, reject) => {
    const v = document.createElement('video');
    v.muted = true;
    v.loop = true;
    v.playsInline = true;
    v.preload = 'auto';
    const fail = () => reject(new Error('unsupported'));
    v.addEventListener('error', fail, { once: true });
    v.addEventListener('loadeddata', () => {
      v.removeEventListener('error', fail);
      if (!v.videoWidth) reject(new Error('unsupported')); else resolve(v);
    }, { once: true });
    v.src = url;
  });
}

function wireVideo(v) {
  v.addEventListener('seeked', () => { draw(true); if (v.paused) refreshThumbs(); });
  v.addEventListener('timeupdate', () => {
    $('time').textContent = fmtTime(v.currentTime);
    if (isFinite(v.duration) && document.activeElement !== $('scrub')) $('scrub').value = Math.round((v.currentTime / v.duration) * 1000);
  });
  v.addEventListener('pause', () => { $('transport').classList.remove('playing'); refreshThumbs(); });
  v.addEventListener('play', () => { $('transport').classList.add('playing'); frameLoop(v); });
}

function frameLoop(v) {
  const tick = () => {
    if (state.source?.el !== v || v.paused) return;
    draw(true);
    const now = performance.now();
    if (now - lastPlayingThumbs > PLAYING_THUMB_MS) { lastPlayingThumbs = now; refreshThumbs(); }
    v.requestVideoFrameCallback(tick);
  };
  v.requestVideoFrameCallback(tick);
}

function togglePlay() {
  const v = state.source && state.source.kind === 'video' ? state.source.el : null;
  if (!v) return;
  if (v.paused) v.play(); else v.pause();
}

async function openMedia(filePath) {
  const name = filePath.split('/').pop();
  try {
    busy(`Loading ${name}…`);
    const info = await api.media.prepare(filePath);
    if (info.kind === 'image') {
      const img = new Image();
      img.src = info.url;
      await img.decode();
      setSource({ kind: 'image', el: img, name, path: filePath });
    } else {
      let v, proxy = null;
      try {
        v = await loadVideo(info.url);
      } catch {
        busy(`This codec can't play directly (e.g. ProRes).\nMaking a preview proxy of ${name}…`);
        proxy = await api.media.proxy(filePath);
        v = await loadVideo(proxy.url);
      }
      wireVideo(v);
      setSource({ kind: 'video', el: v, name, path: filePath, proxy: !!proxy, proxySeconds: proxy?.proxySeconds });
      if (isFinite(v.duration) && v.duration > 1) v.currentTime = v.duration / 3; // skip slates / black lead-in
    }
    busy(null);
  } catch (err) {
    busy(null);
    console.error(err);
    toast(`Couldn't open ${name}. LUTviewer handles H.264, HEVC, ProRes and common stills. For BRAW, R3D or ARRIRAW, export a ProRes clip or still frame first.`, 7000);
  }
}

async function chooseMedia() {
  const p = await api.dialogs.media();
  if (p) openMedia(p);
}

// ---------- LUT import ----------
async function loadLutIntoGpu(entry) {
  try {
    const text = await api.library.read(entry.id);
    renderer.addLut(entry.id, LutParser.parseLut(text, entry.file));
    state.broken.delete(entry.id);
  } catch (e) {
    console.warn('LUT failed', entry.name, e);
    state.broken.add(entry.id);
  }
}

async function importLuts(paths) {
  busy('Adding LUTs…');
  try {
    const { added, skipped } = await api.library.import(paths);
    for (const entry of added) await loadLutIntoGpu(entry);
    state.luts.push(...added);
    buildGrid();
    refreshThumbs();
    const dupes = skipped.filter((s) => s.reason === 'Already in library').length;
    const bad = skipped.length - dupes;
    let msg = added.length ? `Added ${added.length} LUT${added.length === 1 ? '' : 's'}` : 'No new LUTs added';
    if (dupes) msg += ` · ${dupes} already in library`;
    if (bad) msg += ` · ${bad} couldn't be read (${skipped.find((s) => s.reason !== 'Already in library').file})`;
    toast(msg);
    if (added.length && !state.activeId) selectLut(added[0].id, { scroll: true });
  } finally {
    busy(null);
  }
}

async function chooseLuts() {
  const paths = await api.dialogs.luts();
  if (paths.length) importLuts(paths);
}

// Sort a set of dropped/opened paths into LUTs (files or folders) and footage.
function handlePaths(paths) {
  const luts = paths.filter((p) => LUT_EXT.includes(ext(p)) || !ext(p));
  const media = paths.filter((p) => MEDIA_EXT.includes(ext(p)));
  if (luts.length) importLuts(luts);
  if (media.length) openMedia(media[0]);
  if (!luts.length && !media.length) toast('Drop .cube / .3dl LUTs (or folders) and video or image files.');
}

// ---------- Drag & drop ----------
let dragDepth = 0;
document.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; $('dropOverlay').hidden = false; });
document.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; $('dropOverlay').hidden = true; } });
document.addEventListener('dragover', (e) => e.preventDefault());
document.addEventListener('drop', (e) => {
  e.preventDefault();
  dragDepth = 0;
  $('dropOverlay').hidden = true;
  const paths = [...e.dataTransfer.files].map((f) => api.pathForFile(f)).filter(Boolean);
  if (paths.length) handlePaths(paths);
});

// ---------- Startup ----------
async function start() {
  api.progress({ pct: 8, label: 'Starting color engine…' });
  try {
    renderer = new LutRenderer($('view'));
  } catch (e) {
    console.error(e);
    api.ready();
    toast(`LUTviewer couldn't start its GPU renderer: ${e.message}`, 15000);
    return;
  }
  observer = new IntersectionObserver((entries) => {
    for (const en of entries) {
      const t = thumbs.get(en.target.dataset.id);
      if (t) t.visible = en.isIntersecting;
    }
    queuePump();
  }, { root: document.querySelector('main'), rootMargin: '200px' });

  const s = await api.settings.get();
  if (CS.CAMERAS.some((c) => c.id === s.cameraId)) state.cameraId = s.cameraId;
  state.tone = s.tone || 'filmic';
  state.exposure = s.exposure || 0;
  state.fullRange = !!s.fullRange;
  state.intensity = s.intensity ?? 1;
  state.favOnly = !!s.favOnly;

  api.progress({ pct: 15, label: 'Reading LUT library…' });
  state.luts = await api.library.list();
  for (let i = 0; i < state.luts.length; i++) {
    await loadLutIntoGpu(state.luts[i]);
    api.progress({ pct: 15 + (75 * (i + 1)) / state.luts.length, label: `Loading LUTs ${i + 1} / ${state.luts.length}` });
  }

  api.progress({ pct: 95, label: 'Building preview…' });
  buildCameraSelect();
  bindControls();
  setSeg('tone', state.tone);
  $('exposure').value = state.exposure;
  $('exposureOut').textContent = (state.exposure > 0 ? '+' : '') + state.exposure.toFixed(1);
  $('fullRange').checked = state.fullRange;
  $('intensity').value = Math.round(state.intensity * 100);
  $('intensityOut').textContent = `${Math.round(state.intensity * 100)}%`;
  $('btnFavFilter').classList.toggle('on', state.favOnly);
  $('btnPin').classList.toggle('on', !!s.pinned);

  setSource({ kind: 'chart', el: makeTestChart(), name: 'Test chart' });
  buildGrid();
  selectLut(state.luts.some((l) => l.id === s.activeId) ? s.activeId : null);

  api.onOpenPaths(handlePaths);
  api.onMenu('open-media', chooseMedia);
  api.onMenu('add-luts', chooseLuts);

  api.progress({ pct: 100, label: state.luts.length ? `${state.luts.length} LUTs ready` : 'Ready' });
  api.ready();
}

start();
