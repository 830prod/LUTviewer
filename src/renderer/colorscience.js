/*
 * LUTviewer color science.
 *
 * Every camera profile is a pair: a log/transfer curve (decoded in the shader)
 * and a gamut (converted to Rec.709 primaries with a 3x3 matrix computed here
 * from the published primaries). After decoding to scene-linear Rec.709 the
 * image goes through a display transform (filmic roll-off or hard clip) and is
 * encoded for a Rec.709 / BT.1886 display.
 *
 * Curve formulas follow the manufacturers' white papers (same constants as the
 * open-source colour-science library). Each curve is written against either:
 *   "full"  - normalised 10-bit code value, CV / 1023
 *   "video" - video-range normalised value, (CV - 64) / 876
 * The decoder hands us video-range-expanded RGB for normal (legal range)
 * camera files, so the shader converts between the two as needed.
 */
(function (root) {
  'use strict';

  // ---------- Gamuts (CIE xy primaries, all D65 white) ----------
  const D65 = [0.3127, 0.3290];
  const GAMUTS = {
    rec709:      { name: 'Rec.709',              p: [[0.640, 0.330], [0.300, 0.600], [0.150, 0.060]] },
    rec2020:     { name: 'Rec.2020',             p: [[0.708, 0.292], [0.170, 0.797], [0.131, 0.046]] },
    sgamut3:     { name: 'S-Gamut3',             p: [[0.730, 0.280], [0.140, 0.855], [0.100, -0.050]] },
    sgamut3cine: { name: 'S-Gamut3.Cine',        p: [[0.766, 0.275], [0.225, 0.800], [0.089, -0.087]] },
    cinemagamut: { name: 'Cinema Gamut',         p: [[0.740, 0.270], [0.170, 1.140], [0.080, -0.100]] },
    vgamut:      { name: 'V-Gamut',              p: [[0.730, 0.280], [0.165, 0.840], [0.100, -0.030]] },
    awg3:        { name: 'ARRI Wide Gamut 3',    p: [[0.6840, 0.3130], [0.2210, 0.8480], [0.0861, -0.1020]] },
    awg4:        { name: 'ARRI Wide Gamut 4',    p: [[0.7347, 0.2653], [0.1424, 0.8576], [0.0991, -0.0308]] },
    redwg:       { name: 'REDWideGamutRGB',      p: [[0.780308, 0.304253], [0.121595, 1.493994], [0.095612, -0.084589]] },
    bmdwg5:      { name: 'Blackmagic Wide Gamut', p: [[0.7177215, 0.3171181], [0.2280410, 0.8615690], [0.1005841, -0.0820452]] },
    dgamut:      { name: 'DJI D-Gamut',          p: [[0.71, 0.31], [0.21, 0.88], [0.09, -0.08]] },
    dwg:         { name: 'DaVinci Wide Gamut',   p: [[0.8000, 0.3130], [0.1682, 0.9877], [0.0790, -0.1155]] },
  };

  // ---------- Curves (id must match the shader) ----------
  const CURVES = {
    none:     { id: 0,  name: 'Rec.709 (no conversion)' },
    slog3:    { id: 1,  name: 'S-Log3' },
    slog2:    { id: 2,  name: 'S-Log2' },
    clog:     { id: 3,  name: 'Canon Log' },
    clog2:    { id: 4,  name: 'Canon Log 2' },
    clog3:    { id: 5,  name: 'Canon Log 3' },
    vlog:     { id: 6,  name: 'V-Log' },
    flog:     { id: 7,  name: 'F-Log' },
    flog2:    { id: 8,  name: 'F-Log2' },
    nlog:     { id: 9,  name: 'N-Log' },
    logc3:    { id: 10, name: 'LogC3 (EI 800)' },
    logc4:    { id: 11, name: 'LogC4' },
    log3g10:  { id: 12, name: 'Log3G10' },
    bmdfilm5: { id: 13, name: 'Blackmagic Film Gen 5' },
    dlog:     { id: 14, name: 'D-Log' },
    applelog: { id: 15, name: 'Apple Log' },
    protune:  { id: 16, name: 'Protune Flat' },
    hlg:      { id: 17, name: 'HLG' },
    davinci:  { id: 18, name: 'DaVinci Intermediate' },
  };

  // ---------- Camera profiles shown in the picker ----------
  const CAMERAS = [
    { id: 'rec709',       brand: 'Standard',   name: 'Rec.709 / already graded',       curve: 'none',     gamut: 'rec709' },
    { id: 'sony-slog3c',  brand: 'Sony',       name: 'S-Log3 / S-Gamut3.Cine',         curve: 'slog3',    gamut: 'sgamut3cine' },
    { id: 'sony-slog3',   brand: 'Sony',       name: 'S-Log3 / S-Gamut3',              curve: 'slog3',    gamut: 'sgamut3' },
    { id: 'sony-slog2',   brand: 'Sony',       name: 'S-Log2 / S-Gamut',               curve: 'slog2',    gamut: 'sgamut3' },
    { id: 'sony-hlg',     brand: 'Sony',       name: 'HLG / Rec.2020',                 curve: 'hlg',      gamut: 'rec2020' },
    { id: 'canon-clog3',  brand: 'Canon',      name: 'Canon Log 3 / Cinema Gamut',     curve: 'clog3',    gamut: 'cinemagamut' },
    { id: 'canon-clog2',  brand: 'Canon',      name: 'Canon Log 2 / Cinema Gamut',     curve: 'clog2',    gamut: 'cinemagamut' },
    { id: 'canon-clog',   brand: 'Canon',      name: 'Canon Log / Rec.709',            curve: 'clog',     gamut: 'rec709' },
    { id: 'pana-vlog',    brand: 'Panasonic',  name: 'V-Log / V-Gamut',                curve: 'vlog',     gamut: 'vgamut' },
    { id: 'fuji-flog2',   brand: 'Fujifilm',   name: 'F-Log2 / F-Gamut',               curve: 'flog2',    gamut: 'rec2020' },
    { id: 'fuji-flog',    brand: 'Fujifilm',   name: 'F-Log / F-Gamut',                curve: 'flog',     gamut: 'rec2020' },
    { id: 'nikon-nlog',   brand: 'Nikon',      name: 'N-Log / Rec.2020',               curve: 'nlog',     gamut: 'rec2020' },
    { id: 'bmd-gen5',     brand: 'Blackmagic', name: 'Film Gen 5 / Wide Gamut Gen 5',  curve: 'bmdfilm5', gamut: 'bmdwg5' },
    { id: 'arri-logc3',   brand: 'ARRI',       name: 'LogC3 / AWG3',                   curve: 'logc3',    gamut: 'awg3' },
    { id: 'arri-logc4',   brand: 'ARRI',       name: 'LogC4 / AWG4',                   curve: 'logc4',    gamut: 'awg4' },
    { id: 'red-log3g10',  brand: 'RED',        name: 'Log3G10 / REDWideGamutRGB',      curve: 'log3g10',  gamut: 'redwg' },
    { id: 'dji-dlog',     brand: 'DJI',        name: 'D-Log / D-Gamut',                curve: 'dlog',     gamut: 'dgamut' },
    { id: 'apple-log',    brand: 'Apple',      name: 'Apple Log (iPhone)',             curve: 'applelog', gamut: 'rec2020' },
    { id: 'gopro-flat',   brand: 'GoPro',      name: 'Protune Flat',                   curve: 'protune',  gamut: 'rec709' },
    { id: 'davinci-di',   brand: 'DaVinci',    name: 'DaVinci Intermediate / DWG',     curve: 'davinci',  gamut: 'dwg' },
  ];

  // ---------- Matrix helpers ----------
  function xyToXYZ([x, y]) { return [x / y, 1, (1 - x - y) / y]; }

  function inv3(m) {
    const [a, b, c, d, e, f, g, h, i] = m;
    const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
    const det = a * A + b * B + c * C;
    return [
      A / det, -(b * i - c * h) / det, (b * f - c * e) / det,
      B / det, (a * i - c * g) / det, -(a * f - c * d) / det,
      C / det, -(a * h - b * g) / det, (a * e - b * d) / det,
    ];
  }

  function mul3(a, b) {
    const r = new Array(9);
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) {
      r[i * 3 + j] = a[i * 3] * b[j] + a[i * 3 + 1] * b[3 + j] + a[i * 3 + 2] * b[6 + j];
    }
    return r;
  }

  // Row-major RGB -> XYZ matrix for a set of primaries.
  function rgbToXYZ(primaries, white = D65) {
    const [R, G, B] = primaries.map(xyToXYZ);
    const P = [R[0], G[0], B[0], R[1], G[1], B[1], R[2], G[2], B[2]];
    const W = xyToXYZ(white);
    const Pi = inv3(P);
    const S = [
      Pi[0] * W[0] + Pi[1] * W[1] + Pi[2] * W[2],
      Pi[3] * W[0] + Pi[4] * W[1] + Pi[5] * W[2],
      Pi[6] * W[0] + Pi[7] * W[1] + Pi[8] * W[2],
    ];
    return [
      P[0] * S[0], P[1] * S[1], P[2] * S[2],
      P[3] * S[0], P[4] * S[1], P[5] * S[2],
      P[6] * S[0], P[7] * S[1], P[8] * S[2],
    ];
  }

  // Row-major matrix converting linear camera RGB to linear Rec.709.
  function gamutToRec709(gamutId) {
    const src = rgbToXYZ(GAMUTS[gamutId].p);
    const dst = inv3(rgbToXYZ(GAMUTS.rec709.p));
    return mul3(dst, src);
  }

  // Column-major copy for gl.uniformMatrix3fv.
  function toColumnMajor(m) {
    return new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
  }

  // ---------- JS reference decoders (mirror the shader; used by tests) ----------
  const log10 = Math.log10;
  const toFull = (v) => v * 876 / 1023 + 64 / 1023;
  const DECODE = {
    none: (v) => v,
    slog3: (v) => {
      const cv = toFull(v) * 1023;
      return cv >= 171.2102946929
        ? Math.pow(10, (cv - 420) / 261.5) * 0.19 - 0.01
        : (cv - 95) * 0.01125 / (171.2102946929 - 95);
    },
    slog2: (v) => {
      const x = v >= 0.030001222851889303
        ? Math.pow(10, (v - 0.616596 - 0.03) / 0.432699) - 0.037584
        : (v - 0.030001222851889303) / 5;
      return x * 0.9 * 219 / 155;
    },
    clog: (v) => 0.9 * (v < 0.0730597
      ? -(Math.pow(10, (0.0730597 - v) / 0.529136) - 1) / 10.1596
      : (Math.pow(10, (v - 0.0730597) / 0.529136) - 1) / 10.1596),
    clog2: (v) => 0.9 * (v < 0.092864125
      ? -(Math.pow(10, (0.092864125 - v) / 0.24136077) - 1) / 87.09937546
      : (Math.pow(10, (v - 0.092864125) / 0.24136077) - 1) / 87.09937546),
    clog3: (v) => 0.9 * (v < 0.04076162
      ? -(Math.pow(10, (0.07623209 - v) / 0.42889912) - 1) / 14.98325
      : v <= 0.105357102
        ? (v - 0.0730597) / 2.3069815
        : (Math.pow(10, (v - 0.069886632) / 0.42889912) - 1) / 14.98325),
    vlog: (v) => { const V = toFull(v); return V < 0.181 ? (V - 0.125) / 5.6 : Math.pow(10, (V - 0.598206) / 0.241514) - 0.00873; },
    flog: (v) => { const V = toFull(v); return V >= 0.100537775223865 ? (Math.pow(10, (V - 0.790453) / 0.344676) - 0.009468) / 0.555556 : (V - 0.092864) / 8.735631; },
    flog2: (v) => { const V = toFull(v); return V >= 0.100686685370811 ? (Math.pow(10, (V - 0.384316) / 0.245281) - 0.064829) / 5.555556 : (V - 0.092864) / 8.799461; },
    nlog: (v) => { const V = toFull(v); return V < 452 / 1023 ? Math.pow(V / (650 / 1023), 3) - 0.0075 : Math.exp((V - 619 / 1023) / (150 / 1023)); },
    logc3: (v) => { const t = toFull(v); return t > 0.149658 ? (Math.pow(10, (t - 0.385537) / 0.247190) - 0.052272) / 5.555556 : (t - 0.092809) / 5.367655; },
    logc4: (v) => {
      const t = toFull(v);
      const a = (Math.pow(2, 18) - 16) / 117.45, b = (1023 - 95) / 1023, c = 95 / 1023;
      const s = (7 * Math.LN2 * Math.pow(2, 7 - 14 * c / b)) / (a * b);
      const tt = (Math.pow(2, 14 * (-c / b) + 6) - 64) / a;
      return t >= 0 ? (Math.pow(2, 14 * (t - c) / b + 6) - 64) / a : t * s + tt;
    },
    log3g10: (v) => { const y = toFull(v); return (y < 0 ? y / 15.1927 : (Math.pow(10, y / 0.224282) - 1) / 155.975327) - 0.01; },
    bmdfilm5: (v) => {
      const y = toFull(v);
      const A = 0.08692876065491224, B = 0.005494072432257808, C = 0.5300133392291939, D = 8.283605932402494, E = 0.09246575342465753;
      return y < D * 0.005 + E ? (y - E) / D : Math.exp((y - C) / A) - B;
    },
    dlog: (v) => { const x = toFull(v); return x <= 0.14 ? (x - 0.0929) / 6.025 : (Math.pow(10, 3.89616 * x - 2.27752) - 0.0108) / 0.9892; },
    applelog: (v) => {
      const R0 = -0.05641088, c = 47.28711236, b = 0.00964052, g = 0.08550479, d = 0.69336945;
      const Pt = c * Math.pow(0.01 - R0, 2);
      return v >= Pt ? Math.pow(2, (v - d) / g) - b : v >= 0 ? Math.sqrt(v / c) + R0 : R0;
    },
    protune: (v) => (Math.pow(113, v) - 1) / 112,
    hlg: (v) => 3.75 * (v <= 0.5 ? v * v / 3 : (Math.exp((v - 0.55991073) / 0.17883277) + 0.28466892) / 12),
    davinci: (v) => { const y = toFull(v); return y <= 0.02740668 ? y / 10.44426855 : Math.pow(2, y / 0.07329248 - 7) - 0.0075; },
  };

  // ---------- GLSL ----------
  const VERTEX_SHADER = `#version 300 es
in vec2 aPos;
out vec2 vUv;
uniform vec2 uScale;
uniform float uFlipY;
void main() {
  vUv = vec2(aPos.x * 0.5 + 0.5, mix(aPos.y * 0.5 + 0.5, 0.5 - aPos.y * 0.5, uFlipY));
  gl_Position = vec4(aPos * uScale, 0.0, 1.0);
}`;

  const FRAGMENT_SHADER = `#version 300 es
precision highp float;
precision highp sampler3D;
in vec2 vUv;
out vec4 outColor;

uniform sampler2D uImage;
uniform sampler3D uLut;
uniform int   uCurve;        // camera transfer curve
uniform mat3  uGamut;        // camera gamut -> Rec.709
uniform int   uTone;         // 0 = filmic, 1 = clip
uniform float uExposure;     // stops
uniform bool  uFullRange;    // source file uses full data levels
uniform bool  uHasLut;
uniform bool  uLutLogInput;  // LUT expects camera log instead of Rec.709
uniform float uLutSize;
uniform float uIntensity;
uniform float uSplit;        // < 0 disables; otherwise x position of the wipe
uniform bool  uShowOriginal;

float log10f(float x) { return log(x) / log(10.0); }
float toFull(float v) { return v * 876.0 / 1023.0 + 64.0 / 1023.0; }

float decode(float v) {
  if (uCurve == 1) {
    float cv = toFull(v) * 1023.0;
    return cv >= 171.2102946929 ? pow(10.0, (cv - 420.0) / 261.5) * 0.19 - 0.01
                                : (cv - 95.0) * 0.01125 / (171.2102946929 - 95.0);
  }
  if (uCurve == 2) {
    float x = v >= 0.030001222851889303 ? pow(10.0, (v - 0.646596) / 0.432699) - 0.037584
                                        : (v - 0.030001222851889303) / 5.0;
    return x * 0.9 * 219.0 / 155.0;
  }
  if (uCurve == 3) {
    return 0.9 * (v < 0.0730597 ? -(pow(10.0, (0.0730597 - v) / 0.529136) - 1.0) / 10.1596
                                :  (pow(10.0, (v - 0.0730597) / 0.529136) - 1.0) / 10.1596);
  }
  if (uCurve == 4) {
    return 0.9 * (v < 0.092864125 ? -(pow(10.0, (0.092864125 - v) / 0.24136077) - 1.0) / 87.09937546
                                  :  (pow(10.0, (v - 0.092864125) / 0.24136077) - 1.0) / 87.09937546);
  }
  if (uCurve == 5) {
    if (v < 0.04076162) return 0.9 * -(pow(10.0, (0.07623209 - v) / 0.42889912) - 1.0) / 14.98325;
    if (v <= 0.105357102) return 0.9 * (v - 0.0730597) / 2.3069815;
    return 0.9 * (pow(10.0, (v - 0.069886632) / 0.42889912) - 1.0) / 14.98325;
  }
  if (uCurve == 6) {
    float V = toFull(v);
    return V < 0.181 ? (V - 0.125) / 5.6 : pow(10.0, (V - 0.598206) / 0.241514) - 0.00873;
  }
  if (uCurve == 7) {
    float V = toFull(v);
    return V >= 0.100537775223865 ? (pow(10.0, (V - 0.790453) / 0.344676) - 0.009468) / 0.555556
                                  : (V - 0.092864) / 8.735631;
  }
  if (uCurve == 8) {
    float V = toFull(v);
    return V >= 0.100686685370811 ? (pow(10.0, (V - 0.384316) / 0.245281) - 0.064829) / 5.555556
                                  : (V - 0.092864) / 8.799461;
  }
  if (uCurve == 9) {
    float V = toFull(v);
    return V < 452.0 / 1023.0 ? pow(max(V, 0.0) / (650.0 / 1023.0), 3.0) - 0.0075
                              : exp((V - 619.0 / 1023.0) / (150.0 / 1023.0));
  }
  if (uCurve == 10) {
    float t = toFull(v);
    return t > 0.149658 ? (pow(10.0, (t - 0.385537) / 0.247190) - 0.052272) / 5.555556
                        : (t - 0.092809) / 5.367655;
  }
  if (uCurve == 11) {
    float t = toFull(v);
    float a = (262144.0 - 16.0) / 117.45;
    float b = (1023.0 - 95.0) / 1023.0;
    float c = 95.0 / 1023.0;
    float s = (7.0 * log(2.0) * pow(2.0, 7.0 - 14.0 * c / b)) / (a * b);
    float tt = (pow(2.0, 14.0 * (-c / b) + 6.0) - 64.0) / a;
    return t >= 0.0 ? (pow(2.0, 14.0 * (t - c) / b + 6.0) - 64.0) / a : t * s + tt;
  }
  if (uCurve == 12) {
    float y = toFull(v);
    return (y < 0.0 ? y / 15.1927 : (pow(10.0, y / 0.224282) - 1.0) / 155.975327) - 0.01;
  }
  if (uCurve == 13) {
    float y = toFull(v);
    float E = 0.09246575342465753, D = 8.283605932402494;
    return y < D * 0.005 + E ? (y - E) / D
                             : exp((y - 0.5300133392291939) / 0.08692876065491224) - 0.005494072432257808;
  }
  if (uCurve == 14) {
    float x = toFull(v);
    return x <= 0.14 ? (x - 0.0929) / 6.025 : (pow(10.0, 3.89616 * x - 2.27752) - 0.0108) / 0.9892;
  }
  if (uCurve == 15) {
    float R0 = -0.05641088, c = 47.28711236;
    float Pt = c * (0.01 - R0) * (0.01 - R0);
    if (v >= Pt) return pow(2.0, (v - 0.69336945) / 0.08550479) - 0.00964052;
    if (v >= 0.0) return sqrt(v / c) + R0;
    return R0;
  }
  if (uCurve == 16) return (pow(113.0, v) - 1.0) / 112.0;
  if (uCurve == 17) {
    return 3.75 * (v <= 0.5 ? v * v / 3.0 : (exp((v - 0.55991073) / 0.17883277) + 0.28466892) / 12.0);
  }
  if (uCurve == 18) {
    float y = toFull(v);
    return y <= 0.02740668 ? y / 10.44426855 : pow(2.0, y / 0.07329248 - 7.0) - 0.0075;
  }
  return v;
}

// ACES filmic approximation (Narkowicz) - gives a manufacturer-LUT-like roll-off.
vec3 filmic(vec3 x) {
  x *= 0.6;
  return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
}

vec3 rec709Oetf(vec3 L) {
  L = clamp(L, 0.0, 1.0);
  return mix(4.5 * L, 1.099 * pow(L, vec3(0.45)) - 0.099, step(0.018, L));
}

vec3 toRec709(vec3 rgb) {
  if (uCurve == 0) {
    if (uExposure == 0.0) return rgb;
    // Already display-referred: approximate exposure in linear light.
    return pow(pow(max(rgb, 0.0), vec3(2.4)) * exp2(uExposure), vec3(1.0 / 2.4));
  }
  vec3 lin = vec3(decode(rgb.r), decode(rgb.g), decode(rgb.b));
  lin = max(uGamut * lin, 0.0) * exp2(uExposure);
  if (uTone == 1) return rec709Oetf(lin);
  return pow(filmic(lin), vec3(1.0 / 2.4));
}

vec3 applyLut(vec3 c) {
  c = clamp(c, 0.0, 1.0);
  vec3 coord = c * ((uLutSize - 1.0) / uLutSize) + 0.5 / uLutSize;
  return texture(uLut, coord).rgb;
}

void main() {
  vec3 src = texture(uImage, vUv).rgb;
  if (uFullRange) src = (src * 1023.0 - 64.0) / 876.0;
  vec3 converted = toRec709(src);
  vec3 graded = converted;
  bool original = uShowOriginal || (uSplit >= 0.0 && vUv.x < uSplit);
  if (uHasLut && !original) {
    vec3 lutIn = uLutLogInput ? src : converted;
    graded = mix(converted, applyLut(lutIn), uIntensity);
  }
  if (uSplit >= 0.0 && abs(vUv.x - uSplit) < 0.0015) graded = vec3(1.0);
  outColor = vec4(clamp(graded, 0.0, 1.0), 1.0);
}`;

  const api = {
    GAMUTS, CURVES, CAMERAS, DECODE,
    gamutToRec709, toColumnMajor, rgbToXYZ,
    VERTEX_SHADER, FRAGMENT_SHADER,
  };
  root.ColorScience = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
