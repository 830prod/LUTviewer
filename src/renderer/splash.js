'use strict';

const video = document.getElementById('loop');
video.addEventListener('playing', () => video.classList.add('on'));

window.lutviewer.onSplashProgress(({ pct, label }) => {
  document.getElementById('bar').style.width = `${Math.max(4, Math.min(100, pct))}%`;
  if (label) document.getElementById('status').textContent = label;
});
