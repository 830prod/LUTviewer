/*
 * Built-in Rec.709 test chart, shown before any footage is loaded so LUT
 * thumbnails have something meaningful to show right after import.
 */
(function (root) {
  'use strict';

  // ColorChecker-style patches (approximate sRGB values).
  const PATCHES = [
    '#735244', '#c29682', '#627a9d', '#576c43', '#8580b1', '#67bdaa',
    '#d67e2c', '#505ba6', '#c15a63', '#5e3c6c', '#9dbc40', '#e0a32e',
    '#383d96', '#469449', '#af363c', '#e7c71f', '#bb5695', '#0885a1',
  ];

  function makeTestChart(w = 960, h = 540) {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    const g = c.getContext('2d');
    g.fillStyle = '#202020';
    g.fillRect(0, 0, w, h);

    // Hue sweep with a fade to white and black.
    const sweepH = h * 0.22;
    const hue = g.createLinearGradient(0, 0, w, 0);
    for (let i = 0; i <= 6; i++) hue.addColorStop(i / 6, `hsl(${i * 60}, 85%, 50%)`);
    g.fillStyle = hue;
    g.fillRect(0, 0, w, sweepH);
    const fade = g.createLinearGradient(0, 0, 0, sweepH);
    fade.addColorStop(0, 'rgba(255,255,255,0.75)');
    fade.addColorStop(0.5, 'rgba(255,255,255,0)');
    fade.addColorStop(0.5, 'rgba(0,0,0,0)');
    fade.addColorStop(1, 'rgba(0,0,0,0.75)');
    g.fillStyle = fade;
    g.fillRect(0, 0, w, sweepH);

    // Patch grid.
    const cols = 6, rows = 3, pad = w * 0.012;
    const gridTop = sweepH + pad, gridH = h * 0.5;
    const pw = (w * 0.66 - pad * (cols + 1)) / cols;
    const ph = (gridH - pad * (rows + 1)) / rows;
    PATCHES.forEach((col, i) => {
      g.fillStyle = col;
      g.fillRect(pad + (i % cols) * (pw + pad), gridTop + pad + Math.floor(i / cols) * (ph + pad), pw, ph);
    });

    // Skin tone strip.
    const skinX = w * 0.66 + pad, skinW = w - skinX - pad;
    const skins = ['#f3d4c0', '#e5b597', '#c98e69', '#a46c4b', '#7a4b31', '#4d2e1f'];
    const sh = (gridH - pad * 2) / skins.length;
    skins.forEach((s, i) => { g.fillStyle = s; g.fillRect(skinX, gridTop + pad + i * sh, skinW, sh); });

    // Grey ramp + steps.
    const rampTop = gridTop + gridH + pad;
    const rampH = (h - rampTop - pad * 2) / 2;
    const ramp = g.createLinearGradient(0, 0, w, 0);
    ramp.addColorStop(0, '#000'); ramp.addColorStop(1, '#fff');
    g.fillStyle = ramp;
    g.fillRect(pad, rampTop, w - pad * 2, rampH);
    const steps = 11, sw = (w - pad * 2) / steps;
    for (let i = 0; i < steps; i++) {
      const v = Math.round((i / (steps - 1)) * 255);
      g.fillStyle = `rgb(${v},${v},${v})`;
      g.fillRect(pad + i * sw, rampTop + rampH + pad, sw, rampH);
    }
    return c;
  }

  root.makeTestChart = makeTestChart;
})(window);
