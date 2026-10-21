// Sanity checks for the camera decoders: published 18% grey code values should
// decode to ~0.18 scene-linear, and gamut matrices should map white to white.
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const CS = require('../src/renderer/colorscience.js');

// [curve, 10-bit code value of 18% grey (from manufacturer docs)]
const GREY = [
  ['slog3', 420], ['slog2', 347], ['clog', 351], ['clog2', 407], ['clog3', 351],
  ['vlog', 433], ['flog', 470], ['flog2', 391], ['nlog', 363], ['logc3', 400],
  ['logc4', 285], ['log3g10', 341], ['bmdfilm5', 389], ['dlog', 405],
  ['davinci', 344],
];
let fail = 0;
for (const [curve, cv] of GREY) {
  const v = (cv - 64) / 876; // what the video decoder hands the shader
  const lin = CS.DECODE[curve](v);
  const ok = Math.abs(lin - 0.18) / 0.18 < 0.12;
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${curve.padEnd(9)} CV ${cv} -> ${lin.toFixed(4)}`);
}
for (const g of Object.keys(CS.GAMUTS)) {
  const m = CS.gamutToRec709(g);
  const w = [m[0] + m[1] + m[2], m[3] + m[4] + m[5], m[6] + m[7] + m[8]];
  const ok = w.every((x) => Math.abs(x - 1) < 1e-4);
  if (!ok) fail++;
  console.log(`${ok ? 'ok  ' : 'FAIL'} gamut ${g} white -> ${w.map((x) => x.toFixed(4)).join(', ')}`);
}
for (const c of CS.CAMERAS) {
  if (!CS.CURVES[c.curve] || !CS.GAMUTS[c.gamut]) { fail++; console.log('FAIL camera', c.id); }
}
console.log(fail ? `${fail} failure(s)` : 'all color checks passed');
process.exit(fail ? 1 : 0);
