/*
 * LUT parsing. Supports .cube (3D and 1D, with DOMAIN_MIN/MAX) and .3dl.
 * Everything is normalised to a 3D table: { size, data: Float32Array(size^3 * 3) }
 * with red varying fastest (the layout WebGL's texImage3D expects).
 */
(function (root) {
  'use strict';

  function parseCube(text) {
    let size3d = 0, size1d = 0;
    let dmin = [0, 0, 0], dmax = [1, 1, 1];
    let title = '';
    const values = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line[0] === '#') continue;
      const parts = line.split(/\s+/);
      const key = parts[0].toUpperCase();
      if (key === 'TITLE') { title = line.slice(5).trim().replace(/^"|"$/g, ''); continue; }
      if (key === 'LUT_3D_SIZE') { size3d = parseInt(parts[1], 10); continue; }
      if (key === 'LUT_1D_SIZE') { size1d = parseInt(parts[1], 10); continue; }
      if (key === 'DOMAIN_MIN') { dmin = parts.slice(1, 4).map(Number); continue; }
      if (key === 'DOMAIN_MAX') { dmax = parts.slice(1, 4).map(Number); continue; }
      if (key === 'LUT_3D_INPUT_RANGE' || key === 'LUT_1D_INPUT_RANGE') {
        const lo = Number(parts[1]), hi = Number(parts[2]);
        dmin = [lo, lo, lo]; dmax = [hi, hi, hi];
        continue;
      }
      if (/^[A-Z_]+$/.test(key)) continue; // unknown keyword
      if (parts.length >= 3) values.push(+parts[0], +parts[1], +parts[2]);
    }

    const domainIsUnit = dmin.every((v) => v === 0) && dmax.every((v) => v === 1);
    if (size3d) {
      if (values.length < size3d ** 3 * 3) throw new Error('LUT data is shorter than LUT_3D_SIZE says');
      let data = new Float32Array(values.slice(0, size3d ** 3 * 3));
      if (!domainIsUnit) data = resampleDomain3D(data, size3d, dmin, dmax);
      return { title, size: size3d, data, kind: '3D' };
    }
    if (size1d) {
      if (values.length < size1d * 3) throw new Error('LUT data is shorter than LUT_1D_SIZE says');
      return { title, ...expand1D(values, size1d, dmin, dmax), kind: '1D' };
    }
    throw new Error('Not a valid .cube file (no LUT size found)');
  }

  // A 3D table whose input domain is not 0..1: bake the domain into a new 0..1 table.
  function resampleDomain3D(src, n, dmin, dmax) {
    const out = new Float32Array(n * n * n * 3);
    for (let b = 0; b < n; b++) for (let g = 0; g < n; g++) for (let r = 0; r < n; r++) {
      const inp = [r, g, b].map((v, c) => ((v / (n - 1)) - dmin[c]) / (dmax[c] - dmin[c]));
      const s = sample3D(src, n, inp);
      out.set(s, ((b * n + g) * n + r) * 3);
    }
    return out;
  }

  function sample3D(data, n, rgb) {
    const p = rgb.map((v) => Math.min(Math.max(v, 0), 1) * (n - 1));
    const i0 = p.map((v) => Math.min(Math.floor(v), n - 2));
    const f = p.map((v, k) => v - i0[k]);
    const at = (r, g, b) => ((b * n + g) * n + r) * 3;
    const res = [0, 0, 0];
    for (let dz = 0; dz < 2; dz++) for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
      const w = (dx ? f[0] : 1 - f[0]) * (dy ? f[1] : 1 - f[1]) * (dz ? f[2] : 1 - f[2]);
      const o = at(i0[0] + dx, i0[1] + dy, i0[2] + dz);
      res[0] += data[o] * w; res[1] += data[o + 1] * w; res[2] += data[o + 2] * w;
    }
    return res;
  }

  function expand1D(values, n, dmin, dmax) {
    const size = 33;
    const data = new Float32Array(size ** 3 * 3);
    const curve = (v, c) => {
      const t = Math.min(Math.max((v - dmin[c]) / (dmax[c] - dmin[c]), 0), 1) * (n - 1);
      const i = Math.min(Math.floor(t), n - 2), f = t - i;
      return values[i * 3 + c] * (1 - f) + values[(i + 1) * 3 + c] * f;
    };
    for (let b = 0; b < size; b++) for (let g = 0; g < size; g++) for (let r = 0; r < size; r++) {
      const o = ((b * size + g) * size + r) * 3;
      data[o] = curve(r / (size - 1), 0);
      data[o + 1] = curve(g / (size - 1), 1);
      data[o + 2] = curve(b / (size - 1), 2);
    }
    return { size, data };
  }

  // Autodesk / Lustre .3dl: optional shaper line, then integer triplets with blue fastest.
  function parse3dl(text) {
    const rows = [];
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line[0] === '#' || /^[A-Za-z]/.test(line)) continue;
      rows.push(line.split(/\s+/).map(Number));
    }
    if (rows.length && rows[0].length > 3) rows.shift(); // shaper / mesh line
    const triplets = rows.filter((r) => r.length === 3);
    const n = Math.round(Math.cbrt(triplets.length));
    if (n < 2 || n ** 3 !== triplets.length) throw new Error('Unrecognised .3dl layout');
    let max = 0;
    for (const t of triplets) max = Math.max(max, t[0], t[1], t[2]);
    const scale = max <= 1 ? 1 : 2 ** Math.ceil(Math.log2(max + 1)) - 1;
    const data = new Float32Array(n ** 3 * 3);
    let i = 0;
    for (let r = 0; r < n; r++) for (let g = 0; g < n; g++) for (let b = 0; b < n; b++, i++) {
      const o = ((b * n + g) * n + r) * 3;
      data[o] = triplets[i][0] / scale;
      data[o + 1] = triplets[i][1] / scale;
      data[o + 2] = triplets[i][2] / scale;
    }
    return { title: '', size: n, data, kind: '3D' };
  }

  function parseLut(text, filename) {
    return /\.3dl$/i.test(filename) ? parse3dl(text) : parseCube(text);
  }

  // Guess whether a LUT wants camera log in (a "conversion" LUT) or Rec.709 in (a "look").
  function guessLogInput(name) {
    const n = name.toLowerCase().replace(/[\s_\-.]+/g, '');
    if (/(to|2)(rec)?709/.test(n)) return true;
    return /(slog|clog|canonlog|vlog|flog|nlog|logc|log3g10|dlog|applelog|bmdfilm|blackmagicfilm|redlog|hlg)/.test(n);
  }

  const api = { parseLut, parseCube, parse3dl, guessLogInput };
  root.LutParser = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
