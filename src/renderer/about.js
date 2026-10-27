'use strict';

const api = window.lutviewer;
const $ = (id) => document.getElementById(id);
const SITE = 'https://830prod.github.io/LUTviewer/';
const REPO = 'https://github.com/830prod/LUTviewer';

function fmtTime(seconds) {
  const m = Math.floor(seconds / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  return h < 100 ? `${h}h ${m % 60}m` : `${h}h`;
}

// Count numbers up from zero for a little life.
function countUp(el, to, format = (n) => String(n)) {
  const start = performance.now(), dur = 700;
  const tick = (now) => {
    const t = Math.min(1, (now - start) / dur);
    el.textContent = format(Math.round(to * (1 - Math.pow(1 - t, 3))));
    if (t < 1) requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

api.about.info().then((info) => {
  $('ver').textContent = `Version ${info.version}`;
  $('arch').textContent = info.arch === 'arm64' ? 'Apple Silicon' : 'Intel';
  $('year').textContent = String(new Date().getFullYear());
  $('tech').textContent = `Electron ${info.electron} · Chromium ${info.chrome.split('.')[0]} · mp4-muxer`;
  countUp($('sLuts'), info.lutCount);
  countUp($('sExports'), info.exports);
  countUp($('sTime'), info.usageSeconds, fmtTime);
});

const video = $('loop');
video.addEventListener('playing', () => { document.querySelector('.hero .bg').style.opacity = 0; });

// Click the icon to "grade" the background with a few looks.
const LOOKS = [
  ['Teal & Orange', 'saturate(1.35) hue-rotate(-12deg) contrast(1.08)'],
  ['Golden Hour', 'sepia(.55) saturate(1.5) hue-rotate(-18deg) brightness(1.05)'],
  ['Noir', 'grayscale(1) contrast(1.35) brightness(.9)'],
  ['Cool Night', 'saturate(.7) hue-rotate(18deg) brightness(.8) contrast(1.1)'],
  ['Faded Film', 'contrast(.82) saturate(.75) brightness(1.08) sepia(.15)'],
  ['No LUT', 'none'],
];
let look = -1;
let lookTimer;
$('icon').addEventListener('click', () => {
  look = (look + 1) % LOOKS.length;
  const [name, filter] = LOOKS[look];
  video.style.filter = filter;
  $('look').textContent = name;
  $('look').classList.add('show');
  clearTimeout(lookTimer);
  lookTimer = setTimeout(() => $('look').classList.remove('show'), 1400);
});

$('aRate').addEventListener('click', () => api.about.rate());
$('aUpdate').addEventListener('click', () => api.update.check());
$('aSite').addEventListener('click', () => api.openUrl(SITE));
$('aGitHub').addEventListener('click', () => api.openUrl(REPO));
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') window.close(); });
