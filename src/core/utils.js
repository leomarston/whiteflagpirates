// Frozen shared utilities. See docs/CONTRACTS.md — do not edit from modules.
import { GERSTNER_WAVES, SEA_STATE_MIN_SCALE, WORLD } from './constants.js';

// ---------- RNG ----------

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hashSeed(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export const randRange = (rng, a, b) => a + rng() * (b - a);
export const randInt = (rng, a, b) => Math.floor(randRange(rng, a, b + 1));
export const pick = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];
export function shuffle(rng, arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

// ---------- math ----------

export const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
export const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
export const lerp = (a, b, t) => a + (b - a) * t;
export const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * (3 - 2 * t);
};
export const smootherstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a));
  return t * t * t * (t * (t * 6 - 15) + 10);
};
// Frame-rate independent exponential smoothing. lambda ~ [1..20]
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));

export const TAU = Math.PI * 2;
export function wrapAngle(a) {
  a = (a + Math.PI) % TAU;
  if (a < 0) a += TAU;
  return a - Math.PI;
}
export const angleLerp = (a, b, t) => a + wrapAngle(b - a) * t;
export const angleDamp = (a, b, lambda, dt) => a + wrapAngle(b - a) * (1 - Math.exp(-lambda * dt));
export const dist2 = (x1, z1, x2, z2) => {
  const dx = x2 - x1, dz = z2 - z1;
  return Math.sqrt(dx * dx + dz * dz);
};

// ---------- 2D simplex noise (seedable) ----------

const G2 = (3 - Math.sqrt(3)) / 6;
const F2 = 0.5 * (Math.sqrt(3) - 1);
const GRAD2 = [
  [1, 1], [-1, 1], [1, -1], [-1, -1],
  [1, 0], [-1, 0], [0, 1], [0, -1],
];

export class SimplexNoise {
  constructor(seed = 1337) {
    const rng = mulberry32(seed);
    this.perm = new Uint8Array(512);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1));
      [p[i], p[j]] = [p[j], p[i]];
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  // returns [-1, 1]
  noise2D(xin, yin) {
    const perm = this.perm;
    let n0 = 0, n1 = 0, n2 = 0;
    const s = (xin + yin) * F2;
    const i = Math.floor(xin + s), j = Math.floor(yin + s);
    const t = (i + j) * G2;
    const x0 = xin - (i - t), y0 = yin - (j - t);
    let i1, j1;
    if (x0 > y0) { i1 = 1; j1 = 0; } else { i1 = 0; j1 = 1; }
    const x1 = x0 - i1 + G2, y1 = y0 - j1 + G2;
    const x2 = x0 - 1 + 2 * G2, y2 = y0 - 1 + 2 * G2;
    const ii = i & 255, jj = j & 255;

    let t0 = 0.5 - x0 * x0 - y0 * y0;
    if (t0 >= 0) {
      const g = GRAD2[perm[ii + perm[jj]] % 8];
      t0 *= t0;
      n0 = t0 * t0 * (g[0] * x0 + g[1] * y0);
    }
    let t1 = 0.5 - x1 * x1 - y1 * y1;
    if (t1 >= 0) {
      const g = GRAD2[perm[ii + i1 + perm[jj + j1]] % 8];
      t1 *= t1;
      n1 = t1 * t1 * (g[0] * x1 + g[1] * y1);
    }
    let t2 = 0.5 - x2 * x2 - y2 * y2;
    if (t2 >= 0) {
      const g = GRAD2[perm[ii + 1 + perm[jj + 1]] % 8];
      t2 *= t2;
      n2 = t2 * t2 * (g[0] * x2 + g[1] * y2);
    }
    return 70 * (n0 + n1 + n2);
  }
}

// Fractal brownian motion over a SimplexNoise instance. Returns ~[-1, 1].
export function fbm2(noise, x, y, octaves = 4, lacunarity = 2.0, gain = 0.5) {
  let amp = 0.5, freq = 1, sum = 0, norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * noise.noise2D(x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}

// ---------- canonical ocean sampling (CPU mirror of the ocean GLSL) ----------

const WAVE_DATA = GERSTNER_WAVES.map((w) => {
  const len = Math.hypot(w.dir[0], w.dir[1]);
  const k = TAU / w.wavelength;
  return {
    dx: w.dir[0] / len,
    dz: w.dir[1] / len,
    k,
    c: Math.sqrt(WORLD.GRAVITY / k),
    a: w.steepness / k,
  };
});

export function seaStateScale(seaState) {
  return lerp(SEA_STATE_MIN_SCALE, 1.0, clamp01(seaState));
}

function gerstnerDisplace(px, pz, t, ampScale, out) {
  let dx = 0, dy = 0, dz = 0;
  for (let i = 0; i < WAVE_DATA.length; i++) {
    const w = WAVE_DATA[i];
    const a = w.a * ampScale;
    const f = w.k * (w.dx * px + w.dz * pz - w.c * t);
    const cf = Math.cos(f), sf = Math.sin(f);
    dx += w.dx * a * cf;
    dy += a * sf;
    dz += w.dz * a * cf;
  }
  out.x = dx; out.y = dy; out.z = dz;
  return out;
}

const _disp = { x: 0, y: 0, z: 0 };

/**
 * World-space water height at (x, z) at time t (seconds), seaState [0,1].
 * Inverts the horizontal Gerstner displacement with 3 fixed-point iterations.
 */
export function sampleOceanHeight(x, z, t, seaState = 0.35) {
  const s = seaStateScale(seaState);
  let px = x, pz = z;
  for (let it = 0; it < 3; it++) {
    gerstnerDisplace(px, pz, t, s, _disp);
    px = x - _disp.x;
    pz = z - _disp.z;
  }
  gerstnerDisplace(px, pz, t, s, _disp);
  return _disp.y;
}

/**
 * Approximate water surface normal via central differences.
 * `out` must be a THREE.Vector3-like ({x,y,z} with set/normalize optional).
 * Returns out. If out has no methods it's filled as a plain object (normalized).
 */
export function sampleOceanNormal(x, z, t, seaState, out) {
  const e = 1.2;
  const hL = sampleOceanHeight(x - e, z, t, seaState);
  const hR = sampleOceanHeight(x + e, z, t, seaState);
  const hD = sampleOceanHeight(x, z - e, t, seaState);
  const hU = sampleOceanHeight(x, z + e, t, seaState);
  let nx = hL - hR, ny = 2 * e, nz = hD - hU;
  const inv = 1 / Math.hypot(nx, ny, nz);
  nx *= inv; ny *= inv; nz *= inv;
  if (out && typeof out.set === 'function') return out.set(nx, ny, nz);
  return { x: nx, y: ny, z: nz };
}

// ---------- misc ----------

export function formatGold(n) {
  return `${Math.round(n).toLocaleString('en-US')} s`;
}

export function knots(mps) {
  return mps * 1.94384;
}
