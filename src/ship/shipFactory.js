// The shipwright: hero-grade procedural hulls, rigging, cloth sails, and flags.
//
// Ships are built along +Z (bow at +length/2), y=0 is the design waterline.
// Everything is procedural — canvas textures, lofted/merged geometry, GLSL
// billow via onBeforeCompile. To keep draw calls sane every static prop is
// baked into a handful of merged meshes grouped by material; only the cloth
// (sails, flag) and the emissive glass stay as their own live meshes.
//
// CONTRACT (do not break): buildShip(typeKey, opts) -> THREE.Group with
//   userData.parts = { sails, sailMat, flag, flagMat, firePointsL, firePointsR,
//                      deckY, lanternMat, lanternLight, hullMesh }
//   userData.type, userData.sternWindows (emissive stern-gallery material).
import * as THREE from 'three';
import { clamp, lerp } from '../core/utils.js';
import { SHIP_TYPES } from './shipTypes.js';

// ---------------------------------------------------------------------------
// Paint schemes. `hull`/`stripe` feed the plank texture; `wale`/`gild`/`under`
// tune the wale band, gilded trim, and antifouling. Faction schemes below.
// ---------------------------------------------------------------------------
const PAINTS = {
  default: { hull: '#6f4c30', stripe: '#d8c48a', wale: '#33241a', gild: '#c9a24b', under: '#3a2a24' },
  storm: { hull: '#3c3936', stripe: '#9fb0bd', wale: '#242220', gild: '#8a9aa8', under: '#26282b' },
  pearl: { hull: '#8a7a5c', stripe: '#efe6cf', wale: '#4a4030', gild: '#e8dcc0', under: '#4a4436' },
  blood: { hull: '#5e2218', stripe: '#d8b25a', wale: '#2e120c', gild: '#c9a24b', under: '#34140f' },
  navy: { hull: '#26314a', stripe: '#e6ebf4', wale: '#161d2c', gild: '#dfe3ec', under: '#1c2233' },
  vermillion: { hull: '#6e241a', stripe: '#e6c266', wale: '#2c0f0a', gild: '#e6c266', under: '#361410' },
  tidebound: { hull: '#245b57', stripe: '#e8dcc0', wale: '#123230', gild: '#d8c9a0', under: '#173a37' },
};

// ---------------------------------------------------------------------------
// Texture + material caches (module-level; DOM only touched inside functions).
// ---------------------------------------------------------------------------
const _tex = {};
const _mat = {};

function shade(hex, k) {
  // multiply a #rrggbb by k, clamped — quick tint helper for canvas work
  const n = parseInt(hex.slice(1), 16);
  const r = clamp(((n >> 16) & 255) * k, 0, 255) | 0;
  const g = clamp(((n >> 8) & 255) * k, 0, 255) | 0;
  const b = clamp((n & 255) * k, 0, 255) | 0;
  return `rgb(${r},${g},${b})`;
}

function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  return c;
}

/**
 * Planked topsides. The hull loft maps v (0..1) around the girth
 * (gunwale -> keel -> gunwale) and u along the length, so a horizontal band in
 * this texture wraps the hull as a strake/stripe. We paint a symmetric profile:
 * caprail + gilt sheer line, planked topside with caulking & nail rows, a heavy
 * wale, a painted waterline stripe, then antifouling below.
 */
function plankTexture(paint) {
  const key = `plank:${paint.hull}:${paint.stripe}:${paint.wale}:${paint.gild}:${paint.under}`;
  if (_tex[key]) return _tex[key];
  const S = 512;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');

  // girth s in [0,1]: 0 = gunwale, 1 = keel. Symmetric about mid height.
  const yTop = (s) => s * (S / 2);
  const yBot = (s) => S - s * (S / 2);
  const colAt = (s) => {
    if (s < 0.045) return shade(paint.hull, 0.5);        // caprail shadow
    if (s < 0.20) return paint.hull;                     // upper topside
    if (s < 0.25) return paint.wale;                     // wale
    if (s < 0.285) return paint.stripe;                  // waterline stripe
    return shade(paint.under, lerp(1.0, 0.7, (s - 0.285) / 0.715)); // antifouling
  };

  // smooth mirrored base gradient
  const grad = g.createLinearGradient(0, 0, 0, S);
  for (let i = 0; i <= 40; i++) {
    const off = i / 40;
    const s = off <= 0.5 ? off * 2 : (1 - off) * 2;
    grad.addColorStop(off, colAt(s));
  }
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);

  const bandBoth = (s, px, style) => {
    g.fillStyle = style;
    g.fillRect(0, yTop(s) - px / 2, S, px);
    g.fillRect(0, yBot(s) - px / 2, S, px);
  };

  // strake caulking + nail rows across the planked topside
  for (let s = 0.055; s < 0.205; s += 0.019) {
    bandBoth(s, 2, 'rgba(0,0,0,0.34)');
    bandBoth(s - 0.004, 1, 'rgba(255,255,255,0.05)');
    g.fillStyle = 'rgba(0,0,0,0.4)';
    for (let x = 6; x < S; x += 34) {
      g.fillRect(x, yTop(s) - 3, 2, 2);
      g.fillRect(x, yBot(s) + 1, 2, 2);
    }
  }
  // staggered butt joints between planks
  g.fillStyle = 'rgba(0,0,0,0.28)';
  for (let s = 0.055, r = 0; s < 0.205; s += 0.019, r++) {
    for (let x = (r % 2) * 64; x < S; x += 128) {
      g.fillRect(x, yTop(s), 1.5, S / 2 * 0.019 + 2);
      g.fillRect(x, yBot(s) - S / 2 * 0.019 - 2, 1.5, S / 2 * 0.019 + 2);
    }
  }
  // heavy wale edges + gilt sheer line
  bandBoth(0.20, 3, shade(paint.wale, 0.7));
  bandBoth(0.25, 3, shade(paint.wale, 0.7));
  bandBoth(0.035, 2, paint.gild);
  // painted waterline stripe crisp edges
  bandBoth(0.252, 2, shade(paint.stripe, 0.75));
  bandBoth(0.285, 2, shade(paint.stripe, 0.6));

  // grime, streaks & wear
  for (let i = 0; i < 240; i++) {
    const x = Math.random() * S;
    const s = 0.05 + Math.random() * 0.42;
    const y = Math.random() < 0.5 ? yTop(s) : yBot(s);
    g.fillStyle = `rgba(20,14,8,${0.03 + Math.random() * 0.06})`;
    g.fillRect(x, y, 1 + Math.random() * 3, 2 + Math.random() * 22);
  }
  // salt/spray bleaching near the waterline
  for (let i = 0; i < 90; i++) {
    const x = Math.random() * S;
    g.fillStyle = `rgba(230,235,238,${0.02 + Math.random() * 0.05})`;
    g.fillRect(x, yTop(0.27) + (Math.random() - 0.5) * 26, 2 + Math.random() * 4, 2);
    g.fillRect(x, yBot(0.27) + (Math.random() - 0.5) * 26, 2 + Math.random() * 4, 2);
  }

  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  _tex[key] = tex;
  return tex;
}

/** Holystoned deck planks running fore-and-aft, with caulk seams & butt joints. */
function deckTexture() {
  if (_tex.deck) return _tex.deck;
  const S = 512;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  const base = g.createLinearGradient(0, 0, S, 0);
  base.addColorStop(0, '#8a6a44');
  base.addColorStop(0.5, '#9a7a52');
  base.addColorStop(1, '#856642');
  g.fillStyle = base;
  g.fillRect(0, 0, S, S);
  // planks along v: constant-u seams (vertical lines)
  const planks = 22;
  for (let i = 0; i <= planks; i++) {
    const x = (i / planks) * S;
    g.fillStyle = 'rgba(0,0,0,0.32)';       // caulk seam
    g.fillRect(x, 0, 2, S);
    g.fillStyle = 'rgba(255,255,255,0.05)';
    g.fillRect(x + 2, 0, 1, S);
    // butt joints staggered per plank
    g.fillStyle = 'rgba(0,0,0,0.22)';
    for (let y = (i % 3) * 60; y < S; y += 180) g.fillRect(x, y, S / planks, 2);
    // caulk nails
    g.fillStyle = 'rgba(30,20,10,0.4)';
    for (let y = 8; y < S; y += 44) g.fillRect(x + 4, y, 2, 2);
  }
  // scuffs, foot-traffic wear, tar spots
  for (let i = 0; i < 260; i++) {
    g.fillStyle = `rgba(30,20,10,${0.02 + Math.random() * 0.06})`;
    g.fillRect(Math.random() * S, Math.random() * S, 2 + Math.random() * 5, 2 + Math.random() * 5);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  _tex.deck = tex;
  return tex;
}

/** Weathered sailcloth: vertical panel seams, reef bands, bolt-ropes, patches, AO. */
function sailTexture() {
  if (_tex.sail) return _tex.sail;
  const S = 512;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  // cloth base, faintly darker toward the foot (weight of the water it's caught)
  const grad = g.createLinearGradient(0, 0, 0, S);
  grad.addColorStop(0, '#efe7d6');
  grad.addColorStop(0.7, '#e7ddc9');
  grad.addColorStop(1, '#d9ccb4');
  g.fillStyle = grad;
  g.fillRect(0, 0, S, S);
  // vertical panel seams (cloth panels)
  const panels = 7;
  for (let i = 1; i < panels; i++) {
    const x = (i / panels) * S;
    g.fillStyle = 'rgba(120,102,72,0.16)';
    g.fillRect(x - 1, 0, 3, S);
    g.fillStyle = 'rgba(255,255,255,0.06)';
    g.fillRect(x + 2, 0, 1, S);
  }
  // reef bands with reef points
  for (const by of [0.34, 0.6]) {
    const y = by * S;
    g.fillStyle = 'rgba(120,102,72,0.2)';
    g.fillRect(0, y - 5, S, 10);
    g.fillStyle = 'rgba(60,48,30,0.5)';
    for (let x = 18; x < S; x += 40) g.fillRect(x, y - 9, 3, 18); // hanging reef points
  }
  // bolt-rope reinforced border
  g.strokeStyle = 'rgba(90,74,48,0.55)';
  g.lineWidth = 8;
  g.strokeRect(4, 4, S - 8, S - 8);
  g.strokeStyle = 'rgba(120,100,68,0.4)';
  g.lineWidth = 3;
  g.strokeRect(12, 12, S - 24, S - 24);
  // corner reinforcement patches (tack/clew/head/earing)
  g.fillStyle = 'rgba(150,132,98,0.3)';
  for (const [px, py] of [[0.06, 0.06], [0.94, 0.06], [0.06, 0.94], [0.94, 0.94]]) {
    g.beginPath();
    g.arc(px * S, py * S, 34, 0, Math.PI * 2);
    g.fill();
  }
  // patched wear & stains
  g.fillStyle = 'rgba(158,140,108,0.2)';
  g.fillRect(0.12 * S, 0.7 * S, 60, 44);
  g.fillRect(0.66 * S, 0.2 * S, 52, 40);
  for (let i = 0; i < 120; i++) {
    g.fillStyle = `rgba(120,104,74,${0.02 + Math.random() * 0.05})`;
    g.fillRect(Math.random() * S, Math.random() * S, 3 + Math.random() * 10, 3 + Math.random() * 30);
  }
  // baked ambient occlusion: darker toward edges (folds catch shadow)
  const vg = g.createRadialGradient(S / 2, S / 2, S * 0.2, S / 2, S / 2, S * 0.72);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(40,32,20,0.22)');
  g.fillStyle = vg;
  g.fillRect(0, 0, S, S);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 2;
  _tex.sail = tex;
  return tex;
}

/** Faded corsair emblem, blended onto the main course of white-flag ships. */
function emblemTexture() {
  if (_tex.emblem) return _tex.emblem;
  const S = 256;
  const c = makeCanvas(S, S);
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  g.strokeStyle = 'rgba(70,78,90,0.5)';
  g.fillStyle = 'rgba(70,78,90,0.5)';
  g.lineWidth = 10;
  g.lineCap = 'round';
  // a gull in flight — two swept wings meeting mid-sail
  g.beginPath(); g.arc(96, 132, 52, Math.PI * 1.14, Math.PI * 1.66); g.stroke();
  g.beginPath(); g.arc(160, 132, 52, Math.PI * 1.34, Math.PI * 1.86); g.stroke();
  // small body
  g.beginPath(); g.ellipse(128, 128, 7, 15, 0, 0, Math.PI * 2); g.fill();
  // weathered ring
  g.strokeStyle = 'rgba(70,78,90,0.16)';
  g.lineWidth = 5;
  g.beginPath(); g.arc(128, 128, 92, 0, Math.PI * 2); g.stroke();
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  _tex.emblem = tex;
  return tex;
}

function flagTexture(faction) {
  const key = `flag:${faction?.key ?? 'white'}`;
  if (_tex[key]) return _tex[key];
  const W = 160, H = 96;
  const c = makeCanvas(W, H);
  const g = c.getContext('2d');
  const base = faction?.flag?.base ?? 'white';
  const bg = { white: '#e9e4d8', blue: '#20386a', red: '#7e2a1e', teal: '#1d6f6d' };
  g.fillStyle = bg[base] ?? '#e9e4d8';
  g.fillRect(0, 0, W, H);
  // hoist band
  g.fillStyle = 'rgba(0,0,0,0.14)';
  g.fillRect(0, 0, 8, H);
  const ink = base === 'white' ? '#4a5560' : '#e8dcc0';
  g.strokeStyle = ink; g.fillStyle = ink; g.lineWidth = 5; g.lineCap = 'round';
  const emblem = faction?.flag?.emblem ?? 'gull';
  if (emblem === 'gull') {
    g.beginPath(); g.arc(60, 56, 26, Math.PI * 1.14, Math.PI * 1.64); g.stroke();
    g.beginPath(); g.arc(96, 56, 26, Math.PI * 1.36, Math.PI * 1.86); g.stroke();
    g.beginPath(); g.ellipse(78, 52, 4, 9, 0, 0, Math.PI * 2); g.fill();
  } else if (emblem === 'crown') {
    g.fillRect(54, 50, 52, 16);
    for (let i = 0; i < 5; i++) g.fillRect(54 + i * 11, 34, 7, 18);
    g.beginPath();
    for (let i = 0; i < 5; i++) { g.moveTo(58 + i * 11, 34); g.lineTo(60 + i * 11, 26); g.lineTo(62 + i * 11, 34); }
    g.fill();
  } else if (emblem === 'scales') {
    g.fillRect(78, 30, 4, 40); g.fillRect(54, 32, 52, 4);
    g.beginPath(); g.arc(60, 50, 11, 0, Math.PI); g.stroke();
    g.beginPath(); g.arc(100, 50, 11, 0, Math.PI); g.stroke();
  } else { // spiral
    g.beginPath();
    for (let a = 0; a < Math.PI * 4; a += 0.18) {
      const r = 3 + a * 3.6;
      const x = 80 + Math.cos(a) * r, y = 48 + Math.sin(a) * r * 0.82;
      if (a === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }
  // fly-end fray + wear
  for (let i = 0; i < 40; i++) {
    g.fillStyle = `rgba(0,0,0,${0.02 + Math.random() * 0.05})`;
    g.fillRect(Math.random() * W, Math.random() * H, 2, 2 + Math.random() * 5);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  _tex[key] = tex;
  return tex;
}

// ---------------------------------------------------------------------------
// Shared static materials (never mutated per-ship -> safe to cache & reuse).
// ---------------------------------------------------------------------------
function plankMaterial(paint) {
  const key = `pm:${paint.hull}:${paint.stripe}:${paint.wale}`;
  if (_mat[key]) return _mat[key];
  const m = new THREE.MeshStandardMaterial({
    map: plankTexture(paint), roughness: 0.74, metalness: 0.06, side: THREE.DoubleSide,
  });
  _mat[key] = m; return m;
}
function deckMaterial() {
  if (_mat.deck) return _mat.deck;
  _mat.deck = new THREE.MeshStandardMaterial({ map: deckTexture(), roughness: 0.82, metalness: 0.02 });
  return _mat.deck;
}
function timberMaterial() {
  if (_mat.timber) return _mat.timber;
  _mat.timber = new THREE.MeshStandardMaterial({ color: 0x3a2a1b, roughness: 0.8, metalness: 0.03 });
  return _mat.timber;
}
function giltMaterial() {
  if (_mat.gilt) return _mat.gilt;
  _mat.gilt = new THREE.MeshStandardMaterial({
    color: 0xc79a44, roughness: 0.34, metalness: 0.9, emissive: 0x3a2708, emissiveIntensity: 0.12,
  });
  return _mat.gilt;
}
function ironMaterial() {
  if (_mat.iron) return _mat.iron;
  _mat.iron = new THREE.MeshStandardMaterial({ color: 0x17150f, roughness: 0.52, metalness: 0.7 });
  return _mat.iron;
}

/** Cloth billow + furl + optional corsair emblem, all on one per-ship material. */
function makeSailMaterial(corsair) {
  const mat = new THREE.MeshStandardMaterial({
    map: sailTexture(),
    side: THREE.DoubleSide,
    roughness: 0.86,
    metalness: 0.0,
    emissive: 0x8a8474,       // cloth catches skylight; readable at grazing sun
    emissiveIntensity: 0.24,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSail = { value: 1 };
    shader.uniforms.uAlign = { value: 1 };
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uEmblem = { value: corsair ? 1 : 0 };
    shader.uniforms.uEmblemMap = { value: emblemTexture() };
    mat.userData.shader = shader;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
uniform float uSail;
uniform float uAlign;
uniform float uTime;
attribute float aEmblem;
varying float vEmblem;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
vEmblem = aEmblem;
{
  float edgeX = sin(3.14159 * uv.x);
  float belly = sin(3.14159 * (uv.y * 0.86 + 0.07));
  float dome  = edgeX * belly;
  float drive = uSail * (0.32 + 0.68 * uAlign);
  // main belly bows to leeward (+z), deeper toward the foot
  transformed.z += dome * drive * (1.15 + 0.55 * (1.0 - uv.y));
  // catenary sag along the foot
  transformed.y -= (1.0 - uv.y) * edgeX * drive * 0.14;
  // luffing shiver when the sail is off the wind
  float luff = (1.0 - uAlign) * uSail;
  float ripple = sin(uTime * 9.0 + uv.y * 10.0 + uv.x * 5.0)
               + 0.5 * sin(uTime * 13.0 - uv.x * 8.0 + uv.y * 3.0);
  transformed.z += ripple * (0.055 * luff + 0.012) * edgeX;
  // living draw-breathing even when full
  transformed.z += sin(uTime * 1.7 + uv.x * 2.0) * 0.03 * uSail * edgeX;
  // furl: gather the cloth up to the yard (head sits at local y = 0)
  transformed.y *= mix(0.05, 1.0, smoothstep(0.0, 1.0, uSail));
}`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uEmblemMap;
uniform float uEmblem;
varying float vEmblem;`)
      .replace('#include <map_fragment>', `#include <map_fragment>
{
  vec4 em = texture2D(uEmblemMap, vMapUv);
  float k = em.a * uEmblem * vEmblem;
  diffuseColor.rgb = mix(diffuseColor.rgb, em.rgb, k);
}`);
  };
  return mat;
}

function makeFlagMaterial(faction) {
  const mat = new THREE.MeshStandardMaterial({
    map: flagTexture(faction),
    side: THREE.DoubleSide,
    roughness: 0.82,
    metalness: 0.0,
    emissive: 0x6f6f6f,
    emissiveIntensity: 0.2,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    mat.userData.shader = shader;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  float t = uTime;
  float fly = uv.x;
  transformed.z += (sin(t * 6.0 + fly * 7.0) + 0.4 * sin(t * 9.3 + fly * 13.0)) * 0.17 * fly;
  transformed.y += sin(t * 5.1 + fly * 5.0) * 0.05 * fly;
  transformed.x += sin(t * 4.0 + fly * 3.0) * 0.02 * fly;
}`);
  };
  return mat;
}

// ---------------------------------------------------------------------------
// Geometry helpers. Everything is built at origin then baked into place with
// translate/rotate/scale so it can be merged per material.
// ---------------------------------------------------------------------------
function scaleUV(geo, su, sv) {
  const uv = geo.attributes.uv;
  if (!uv) return geo;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * su, uv.getY(i) * sv);
  uv.needsUpdate = true;
  return geo;
}

/** Bake a transform into a geometry and return it (rotate -> scale -> move). */
function place(geo, o = {}) {
  if (o.su || o.sv) scaleUV(geo, o.su ?? 1, o.sv ?? 1);
  if (o.rx) geo.rotateX(o.rx);
  if (o.ry) geo.rotateY(o.ry);
  if (o.rz) geo.rotateZ(o.rz);
  if (o.sx || o.sy || o.sz) geo.scale(o.sx ?? 1, o.sy ?? 1, o.sz ?? 1);
  if (o.x || o.y || o.z) geo.translate(o.x ?? 0, o.y ?? 0, o.z ?? 0);
  return geo;
}

/** Merge same-material geometries into one buffer (position/normal/uv only). */
function mergeGeos(geos) {
  const prepared = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  let total = 0;
  for (const g of prepared) total += g.attributes.position.count;
  const position = new Float32Array(total * 3);
  const normal = new Float32Array(total * 3);
  const uv = new Float32Array(total * 2);
  let po = 0, no = 0, uo = 0;
  for (const g of prepared) {
    const p = g.attributes.position.array;
    position.set(p, po); po += p.length;
    if (g.attributes.normal) { normal.set(g.attributes.normal.array, no); }
    no += g.attributes.position.count * 3;
    if (g.attributes.uv) { uv.set(g.attributes.uv.array, uo); }
    uo += g.attributes.position.count * 2;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(position, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normal, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return out;
}

function meshFromBucket(bucket, material, { cast = true, receive = true } = {}) {
  if (!bucket.length) return null;
  const mesh = new THREE.Mesh(mergeGeos(bucket), material);
  mesh.castShadow = cast;
  mesh.receiveShadow = receive;
  return mesh;
}

// ---- hull loft -------------------------------------------------------------
function hullGeometry(type) {
  const L = type.length, B = type.beam, D = type.draft, F = type.freeboard;
  const NS = 15;
  const NC = 13;
  const positions = [];
  const uvs = [];
  const indices = [];

  const halfW = (t) => (B / 2) * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.78)), 0.62);
  const draftAt = (t) => D * (0.3 + 0.7 * Math.pow(Math.sin(Math.PI * t), 0.7));
  const sheer = (t) => F * (1 + 0.6 * Math.pow(Math.abs(t - 0.42) / 0.58, 1.9));

  for (let i = 0; i < NS; i++) {
    const t = i / (NS - 1);
    const z = -L / 2 + t * L;
    const hw = Math.max(halfW(t), 0.045);
    const dr = draftAt(t);
    const dy = sheer(t);
    for (let j = 0; j < NC; j++) {
      const a = (j / (NC - 1)) * Math.PI;
      const x = Math.cos(a) * hw;
      const y = dy - (dy + dr) * Math.pow(Math.sin(a), 0.85);
      positions.push(x, y, z);
      uvs.push(t * (L / 6), j / (NC - 1));
    }
  }
  for (let i = 0; i < NS - 1; i++) {
    for (let j = 0; j < NC - 1; j++) {
      const a = i * NC + j;
      const b = a + NC;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  // transom (stern cap)
  for (let j = 0; j < NC - 2; j++) indices.push(0, j + 1, j + 2);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return { geo, halfW, sheer, draftAt };
}

function deckGeometry(type, halfW, sheer, deckY) {
  const L = type.length;
  const NS = 15;
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let i = 0; i < NS; i++) {
    const t = i / (NS - 1);
    const z = -L / 2 + t * L;
    const hw = Math.max(halfW(t) * 0.95, 0.03);
    const y = deckY;
    positions.push(-hw, y, z, hw, y, z);
    uvs.push(0, t * (L / 4), 1.2, t * (L / 4));
  }
  for (let i = 0; i < NS - 1; i++) {
    const a = i * 2;
    indices.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return geo;
}

// ---------------------------------------------------------------------------
// The shipwright.
// ---------------------------------------------------------------------------
export function buildShip(typeKey, opts = {}) {
  const type = SHIP_TYPES[typeKey] ?? SHIP_TYPES.sloop;
  const isPlayer = !!opts.player;
  const factionKey = opts.faction?.key;
  const corsair = isPlayer || factionKey === 'corsairs';
  const paint = PAINTS[opts.paint] ?? (
    factionKey === 'crown' ? PAINTS.navy
      : factionKey === 'concern' ? PAINTS.vermillion
        : factionKey === 'tidebound' ? PAINTS.tidebound
          : PAINTS.default);

  const group = new THREE.Group();
  group.name = `ship:${typeKey}`;

  const L = type.length, B = type.beam, F = type.freeboard;
  const { geo: hullGeo, halfW, sheer } = hullGeometry(type);
  const deckY = sheer(0.45) - Math.min(0.85, F * 0.35);   // CONTRACT: walkable deck height

  // material buckets — one merged mesh per material keeps draw calls low
  const plankB = [hullGeo];
  const deckB = [];
  const timberB = [];
  const giltB = [];
  const ironB = [];
  const standing = [];   // {x1..z2} tarred standing rigging
  const running = [];    // lighter running rigging
  const sails = [];

  const plankMat = plankMaterial(paint);
  const deckMat = deckMaterial();
  const timberMat = timberMaterial();
  const giltMat = giltMaterial();
  const ironMat = ironMaterial();
  const sailMat = makeSailMaterial(corsair);

  // ---- main deck --------------------------------------------------------
  deckB.push(deckGeometry(type, halfW, sheer, deckY));

  // ---- caprail: a rounded rail wrapping the sheer, both sides + transom --
  const railPts = [];
  for (let i = 0; i <= 14; i++) {
    const t = i / 14;
    railPts.push(new THREE.Vector3(halfW(t) * 0.98, sheer(t) + 0.02, -L / 2 + t * L));
  }
  const railR = clamp(B * 0.02, 0.05, 0.16);
  for (const s of [-1, 1]) {
    const pts = railPts.map((p) => new THREE.Vector3(p.x * s, p.y, p.z));
    const curve = new THREE.CatmullRomCurve3(pts);
    timberB.push(new THREE.TubeGeometry(curve, 24, railR, 5, false));
    // a gilt sheer strake just under the rail
    const gpts = railPts.map((p) => new THREE.Vector3(p.x * s * 1.005, p.y - 0.28, p.z));
    giltB.push(new THREE.TubeGeometry(new THREE.CatmullRomCurve3(gpts), 24, railR * 0.5, 4, false));
  }
  // transom caprail
  timberB.push(place(new THREE.CylinderGeometry(railR, railR, halfW(0) * 1.9, 6), {
    rz: Math.PI / 2, x: 0, y: sheer(0) + 0.02, z: -L / 2,
  }));

  // ---- raised quarterdeck (poop) + forecastle -------------------------
  const qz0 = 0.60, qz1 = 0.96;                    // quarterdeck spans stern
  const qRaise = clamp(F * 0.42, 0.5, 1.1);
  const qMidT = (qz0 + qz1) / 2;
  const qHW = halfW(qMidT) * 0.9;
  // quarterdeck platform
  deckB.push(place(new THREE.BoxGeometry(qHW * 2, 0.12, (qz1 - qz0) * L), {
    su: qHW * 0.5, sv: (qz1 - qz0) * L * 0.4,
    x: 0, y: deckY + qRaise, z: -L / 2 + qMidT * L,
  }));
  // supporting bulkhead at its forward break, with a doorway
  plankB.push(place(new THREE.BoxGeometry(qHW * 1.7, qRaise, 0.14), {
    su: qHW * 0.8, sv: qRaise * 0.8, x: 0, y: deckY + qRaise / 2, z: -L / 2 + qz0 * L,
  }));
  timberB.push(place(new THREE.BoxGeometry(0.5, qRaise, 0.16), { x: 0, y: deckY + qRaise / 2, z: -L / 2 + qz0 * L + 0.02 }));
  // quarterdeck rail with turned stanchions
  for (const s of [-1, 1]) {
    timberB.push(place(new THREE.BoxGeometry(0.08, 0.08, (qz1 - qz0) * L), {
      x: s * qHW, y: deckY + qRaise + 0.5, z: -L / 2 + qMidT * L,
    }));
    const nS = 5;
    for (let k = 0; k <= nS; k++) {
      const z = -L / 2 + (qz0 + (qz1 - qz0) * (k / nS)) * L;
      timberB.push(place(new THREE.CylinderGeometry(0.03, 0.035, 0.5, 5), { x: s * qHW, y: deckY + qRaise + 0.25, z }));
    }
  }
  // a short companion ladder down to the waist
  for (let k = 0; k < 3; k++) {
    timberB.push(place(new THREE.BoxGeometry(0.7, 0.05, 0.24), {
      x: B * 0.14, y: deckY + qRaise - 0.18 - k * (qRaise / 3), z: -L / 2 + qz0 * L - 0.3 - k * 0.24,
    }));
  }

  if (L >= 20) {
    // forecastle deck forward
    const fz0 = 0.80, fz1 = 0.98;
    const fRaise = clamp(F * 0.3, 0.35, 0.8);
    const fMidT = (fz0 + fz1) / 2;
    const fHW = halfW(fMidT) * 0.9;
    deckB.push(place(new THREE.BoxGeometry(fHW * 2, 0.1, (fz1 - fz0) * L), {
      su: fHW * 0.5, sv: (fz1 - fz0) * L * 0.4, x: 0, y: deckY + fRaise, z: -L / 2 + fMidT * L,
    }));
    plankB.push(place(new THREE.BoxGeometry(fHW * 1.7, fRaise, 0.12), {
      su: fHW * 0.8, sv: fRaise * 0.8, x: 0, y: deckY + fRaise / 2, z: -L / 2 + fz0 * L,
    }));
  }

  // ---- stern gallery: carved transom, windows, quarter-galleries -------
  const transomHW = halfW(0) * 1.02;
  const galleryY = deckY + 0.55;
  const sternWinMat = new THREE.MeshStandardMaterial({
    color: 0x241a12, emissive: 0xffb45e, emissiveIntensity: 0, roughness: 0.4, metalness: 0.1,
  });
  // window band (emissive glass) — one merged mesh from a row of panes
  const winB = [];
  const nWin = L >= 30 ? 5 : L >= 20 ? 4 : 3;
  const winW = (transomHW * 1.5) / nWin;
  for (let i = 0; i < nWin; i++) {
    const x = -transomHW * 0.75 + (i + 0.5) * winW;
    winB.push(place(new THREE.PlaneGeometry(winW * 0.7, 0.62), { ry: Math.PI, x, y: galleryY, z: -L / 2 - 0.02 }));
    // gilt mullion/frame around each pane
    giltB.push(place(new THREE.BoxGeometry(winW * 0.82, 0.72, 0.06), { x, y: galleryY, z: -L / 2 - 0.005 }));
  }
  const sternWindows = new THREE.Mesh(mergeGeos(winB), sternWinMat);
  sternWindows.name = 'sternWindows';
  group.add(sternWindows);
  // carved taffrail band + a name-board in gilt
  giltB.push(place(new THREE.BoxGeometry(transomHW * 1.7, 0.16, 0.12), { x: 0, y: galleryY + 0.55, z: -L / 2 - 0.04 }));
  giltB.push(place(new THREE.BoxGeometry(transomHW * 1.7, 0.14, 0.1), { x: 0, y: galleryY - 0.42, z: -L / 2 - 0.04 }));
  // quarter-galleries: rounded bumps at the stern corners w/ tiny windows
  for (const s of [-1, 1]) {
    plankB.push(place(new THREE.CylinderGeometry(0.34, 0.28, 1.5, 8, 1, false, 0, Math.PI), {
      ry: s > 0 ? 0 : Math.PI, x: s * transomHW * 0.92, y: galleryY + 0.1, z: -L / 2 + 0.5,
    }));
    giltB.push(place(new THREE.CylinderGeometry(0.36, 0.3, 0.14, 8), { x: s * transomHW * 0.92, y: galleryY + 0.85, z: -L / 2 + 0.5 }));
  }

  // ---- stern lanterns (per-ship emissive glass) -----------------------
  const lanternMat = new THREE.MeshStandardMaterial({
    color: 0xfff2d0, emissive: 0xffb45e, emissiveIntensity: 0.25, roughness: 0.3,
  });
  const lampB = [];
  for (const s of [-1, 1]) {
    const lx = s * transomHW * 0.7, ly = galleryY + 1.15, lz = -L / 2 + 0.25;
    // gilt post + cap (shared gilt), iron cage bars, glass globe (per-ship)
    giltB.push(place(new THREE.CylinderGeometry(0.05, 0.05, 0.5, 6), { x: lx, y: ly - 0.35, z: lz }));
    giltB.push(place(new THREE.ConeGeometry(0.16, 0.18, 6), { x: lx, y: ly + 0.24, z: lz }));
    lampB.push(place(new THREE.SphereGeometry(0.15, 10, 8), { x: lx, y: ly, z: lz }));
  }
  const lanternGlass = new THREE.Mesh(mergeGeos(lampB), lanternMat);
  group.add(lanternGlass);
  let lanternLight = null;
  if (isPlayer) {
    lanternLight = new THREE.PointLight(0xffb45e, 0, 26, 2);
    lanternLight.position.set(0, deckY + 2.4, -L * 0.3);
    group.add(lanternLight);
  }

  // ---- bow: figurehead, headrails, trailboards, bowsprit --------------
  const bowZ = L / 2;
  const bowY = sheer(1);
  // bowsprit (timber) + jib-boom
  timberB.push(place(new THREE.CylinderGeometry(0.07, 0.13, L * 0.3, 7), {
    rx: -Math.PI / 2 + 0.26, x: 0, y: bowY + 0.2, z: bowZ + L * 0.11,
  }));
  // trailboards / cheeks (gilt scrolls flanking the stem)
  for (const s of [-1, 1]) {
    giltB.push(place(new THREE.BoxGeometry(0.06, 0.14, L * 0.16), {
      rx: 0.5, x: s * halfW(0.96) * 0.5, y: bowY - 0.2, z: bowZ + 0.1,
    }));
    // headrail
    timberB.push(place(new THREE.CylinderGeometry(0.04, 0.04, L * 0.18, 5), {
      rx: -Math.PI / 2 + 0.5, x: s * 0.28, y: bowY - 0.05, z: bowZ + 0.35,
    }));
  }
  // figurehead — a stylised gilded gull/spirit under the bowsprit
  const fhY = bowY - 0.35, fhZ = bowZ + 0.55;
  giltB.push(place(new THREE.ConeGeometry(0.18, 0.7, 7), { rx: Math.PI / 2 + 0.4, x: 0, y: fhY, z: fhZ }));
  giltB.push(place(new THREE.SphereGeometry(0.16, 8, 8), { x: 0, y: fhY + 0.28, z: fhZ + 0.2 }));
  for (const s of [-1, 1]) {
    giltB.push(place(new THREE.BoxGeometry(0.5, 0.1, 0.04), { rz: s * 0.5, ry: s * 0.3, x: s * 0.24, y: fhY + 0.1, z: fhZ + 0.05 }));
  }

  // ---- deck furniture: capstan, bitts, gratings, hatches, boat, wheel --
  const waistZ = -L * 0.05;
  // capstan
  timberB.push(place(new THREE.CylinderGeometry(0.28, 0.34, 0.7, 10), { x: 0, y: deckY + 0.35, z: waistZ + L * 0.12 }));
  timberB.push(place(new THREE.CylinderGeometry(0.34, 0.34, 0.1, 10), { x: 0, y: deckY + 0.72, z: waistZ + L * 0.12 }));
  // main hatch grating (dark inset framed in timber)
  deckB.push(place(new THREE.BoxGeometry(B * 0.34, 0.12, L * 0.1), { x: 0, y: deckY + 0.08, z: waistZ }));
  ironB.push(place(new THREE.BoxGeometry(B * 0.28, 0.04, L * 0.08), { x: 0, y: deckY + 0.15, z: waistZ }));
  // cargo hatches
  for (const hz of [-0.28, 0.24]) {
    deckB.push(place(new THREE.BoxGeometry(B * 0.26, 0.16, 0.9), {
      su: B * 0.13, sv: 0.5, x: 0, y: deckY + 0.1, z: hz * L,
    }));
  }
  // bitts (mooring posts) near the bow
  for (const s of [-1, 1]) {
    timberB.push(place(new THREE.BoxGeometry(0.12, 0.5, 0.12), { x: s * B * 0.2, y: deckY + 0.25, z: L * 0.34 }));
  }
  // ship's boat stowed amidships (small open hull + thwarts)
  const boatL = clamp(L * 0.16, 2.4, 5), boatB = clamp(B * 0.3, 0.9, 2);
  timberB.push(place(new THREE.SphereGeometry(1, 10, 6, 0, Math.PI * 2, Math.PI * 0.5, Math.PI * 0.5), {
    sx: boatB / 2, sy: 0.5, sz: boatL / 2, x: 0, y: deckY + 0.4, z: -L * 0.02,
  }));
  for (let k = -1; k <= 1; k++) {
    timberB.push(place(new THREE.BoxGeometry(boatB * 0.9, 0.05, 0.12), { x: 0, y: deckY + 0.5, z: -L * 0.02 + k * boatL * 0.28 }));
  }
  // ship's wheel + binnacle at the quarterdeck
  const wheelZ = -L * 0.32, wheelY = deckY + qRaise + 0.55;
  timberB.push(place(new THREE.TorusGeometry(0.42, 0.05, 6, 14), { x: 0, y: wheelY, z: wheelZ }));
  for (let k = 0; k < 8; k++) {
    timberB.push(place(new THREE.CylinderGeometry(0.02, 0.02, 0.9, 4), { rz: (k / 8) * Math.PI, x: 0, y: wheelY, z: wheelZ }));
  }
  timberB.push(place(new THREE.BoxGeometry(0.1, 0.7, 0.1), { x: 0, y: wheelY - 0.4, z: wheelZ }));   // pedestal
  timberB.push(place(new THREE.BoxGeometry(0.4, 0.5, 0.3), { x: 0, y: deckY + qRaise + 0.25, z: wheelZ + 0.6 })); // binnacle

  // belaying-pin racks at the mast partners (added per-mast below)

  // ---- masts, tops, yards, rigging & sails ----------------------------
  const masts = type.masts;
  const mastFrac = masts === 1 ? [0.06] : masts === 2 ? [0.26, -0.2] : [0.32, 0.0, -0.3];
  const mastHtMul = masts === 1 ? [1.12] : masts === 2 ? [1.0, 1.12] : [1.0, 1.16, 0.84];
  const baseMastH = L * (masts === 1 ? 1.12 : 0.92);
  const mainMastIndex = masts === 1 ? 0 : 1;

  const squaresFor = (i) => {
    if ((type.key === 'frigate' || type.key === 'galleon') && i < 2) return 3;
    return 2;
  };

  const mastMeta = [];   // remember masthead + base for stays
  for (let m = 0; m < mastFrac.length; m++) {
    const mz = mastFrac[m] * L;
    const mh = baseMastH * mastHtMul[m];
    const baseY = deckY;
    const topY = baseY + mh;
    mastMeta.push({ mz, mh, topY, baseY });

    // lower mast + topmast taper
    timberB.push(place(new THREE.CylinderGeometry(0.11, 0.22, mh, 9), { x: 0, y: baseY + mh / 2, z: mz }));
    timberB.push(place(new THREE.CylinderGeometry(0.05, 0.09, mh * 0.28, 7), { x: 0, y: topY - mh * 0.05, z: mz }));
    // mast bands (iron hoops)
    for (let b = 0; b < 3; b++) {
      ironB.push(place(new THREE.TorusGeometry(0.14 + b * 0.01, 0.02, 5, 10), { rx: Math.PI / 2, x: 0, y: baseY + mh * (0.25 + b * 0.22), z: mz }));
    }
    // mast partner + belaying-pin rack at the foot
    timberB.push(place(new THREE.BoxGeometry(0.6, 0.16, 0.6), { x: 0, y: baseY + 0.1, z: mz }));
    for (let s = -1; s <= 1; s += 2) {
      timberB.push(place(new THREE.BoxGeometry(0.5, 0.08, 0.08), { x: 0, y: baseY + 0.55, z: mz + s * 0.42 }));
      for (let p = -1; p <= 1; p++) {
        timberB.push(place(new THREE.CylinderGeometry(0.02, 0.02, 0.22, 4), { x: p * 0.16, y: baseY + 0.5, z: mz + s * 0.42 }));
      }
    }
    // fighting top (platform + crosstrees) on the bigger classes
    const hasTop = L >= 22;
    const topPlatY = baseY + mh * 0.62;
    if (hasTop) {
      deckB.push(place(new THREE.CylinderGeometry(B * 0.16, B * 0.16, 0.08, 10), { su: 3, sv: 3, x: 0, y: topPlatY, z: mz }));
      for (const s of [-1, 1]) {
        timberB.push(place(new THREE.BoxGeometry(0.08, 0.08, B * 0.34), { x: s * B * 0.14, y: topPlatY - 0.06, z: mz }));
      }
    }

    // --- yards + square sails (head at yard, hanging down) ---
    const nSq = squaresFor(m);
    for (let s = 0; s < nSq; s++) {
      const frac = 0.30 + s * (0.52 / Math.max(nSq, 1));
      const yardY = baseY + mh * frac;
      const sw = B * (1.75 - s * 0.36) * (masts === 1 ? 1.05 : 1);
      const sh = mh * (0.26 - s * 0.03);
      // yard: tapered spar with iron truss
      timberB.push(place(new THREE.CylinderGeometry(0.045, 0.07, sw + 0.7, 6), { rz: Math.PI / 2, x: 0, y: yardY, z: mz }));
      ironB.push(place(new THREE.TorusGeometry(0.1, 0.02, 5, 8), { x: 0, y: yardY, z: mz }));

      const seg = 12;
      const sg = new THREE.PlaneGeometry(sw, sh, seg, 8);
      sg.translate(0, -sh / 2, 0);   // head (top) at local y = 0
      // emblem only on the main course (lowest sail of the main mast) for corsairs
      const isMainCourse = corsair && m === mainMastIndex && s === 0;
      const n = sg.attributes.position.count;
      const emb = new Float32Array(n);
      if (isMainCourse) emb.fill(1);
      sg.setAttribute('aEmblem', new THREE.BufferAttribute(emb, 1));
      const sail = new THREE.Mesh(sg, sailMat);
      sail.position.set(0, yardY - 0.05, mz - 0.12);
      sail.castShadow = true;
      sail.receiveShadow = false;
      group.add(sail);
      sails.push(sail);

      // running rigging: braces from the yard-arms aft, plus clew lines
      const ya = sw / 2 + 0.35;
      running.push(ya, yardY, mz, ya + 0.4, yardY - 0.3, mz - 1.6);
      running.push(-ya, yardY, mz, -ya - 0.4, yardY - 0.3, mz - 1.6);
      running.push(ya * 0.9, yardY - sh, mz, ya * 0.6, deckY + 0.4, mz + 0.4);
      running.push(-ya * 0.9, yardY - sh, mz, -ya * 0.6, deckY + 0.4, mz + 0.4);
    }

    // --- standing rigging: shrouds with ratline crosshatch, both sides ---
    const chanY = sheer(mastFrac[m] * 0.5 + 0.5) + 0.02;
    const chanHW = halfW(clamp(mastFrac[m] * 0.5 + 0.5, 0, 1)) * 0.98;
    const nShroud = L >= 30 ? 5 : L >= 20 ? 4 : 3;
    const shroudTopY = baseY + mh * (hasTop ? 0.6 : 0.72);
    for (const side of [-1, 1]) {
      // channel (chain-wale board) + deadeyes
      timberB.push(place(new THREE.BoxGeometry(0.3, 0.08, nShroud * 0.24 + 0.3), { x: side * chanHW, y: chanY, z: mz }));
      const baseCol = [];
      for (let k = 0; k < nShroud; k++) {
        const bz = mz + (k - (nShroud - 1) / 2) * 0.24;
        const bx = side * (chanHW + 0.06);
        baseCol.push(new THREE.Vector3(bx, chanY + 0.06, bz));
        ironB.push(place(new THREE.SphereGeometry(0.05, 6, 5), { x: bx, y: chanY + 0.08, z: bz }));
      }
      const top = new THREE.Vector3(side * 0.16, shroudTopY, mz);
      // shroud lines
      for (const b of baseCol) standing.push(b.x, b.y, b.z, top.x, top.y, top.z);
      // ratline rungs between adjacent shrouds up ~70% of the height
      const rungs = clamp(Math.round((shroudTopY - chanY) / 0.42), 4, 22);
      for (let r = 1; r <= rungs; r++) {
        const f = (r / (rungs + 2));
        for (let k = 0; k < nShroud - 1; k++) {
          const a = baseCol[k], b2 = baseCol[k + 1];
          const ax = lerp(a.x, top.x, f), ay = lerp(a.y, top.y, f), az = lerp(a.z, top.z, f);
          const bx = lerp(b2.x, top.x, f), by = lerp(b2.y, top.y, f), bz = lerp(b2.z, top.z, f);
          standing.push(ax, ay, az, bx, by, bz);
        }
      }
    }
  }

  // fore/back stays running the length of the ship
  for (let m = 0; m < mastMeta.length; m++) {
    const mm = mastMeta[m];
    const headY = mm.topY - mm.mh * 0.06;
    // forestay toward the bow (or next mast forward)
    const fz = m === 0 ? bowZ + L * 0.16 : mastMeta[m - 1].mz;
    const fy = m === 0 ? bowY + 0.2 : mastMeta[m - 1].topY - mastMeta[m - 1].mh * 0.2;
    standing.push(0, headY, mm.mz, 0, fy, fz);
    // backstay toward the stern
    standing.push(0, headY, mm.mz, 0, sheer(0.02) + 0.4, -L / 2 + 0.3);
  }

  // --- headsails (jibs) on the forestays ---
  const foreMz = mastMeta[0].mz;
  const foreTopY = mastMeta[0].topY - mastMeta[0].mh * 0.22;
  const nJib = masts === 1 ? 1 : 2;
  for (let j = 0; j < nJib; j++) {
    const headZ = bowZ + L * (0.14 - j * 0.09);
    const headY = bowY + 0.2 + (foreTopY - (bowY + 0.2)) * (0.7 - j * 0.3);
    const tackZ = bowZ + L * (0.02 - j * 0.02);
    const jw = B * (0.9 - j * 0.15);
    const jh = headY - (deckY + F * 0.4);
    // triangle in local XY (normal +z), head at (0,0), foot below, clew to +x
    const jg = new THREE.BufferGeometry();
    const pos = new Float32Array([0, 0, 0, 0, -jh, 0, jw, -jh * 0.55, 0]);
    const uv = new Float32Array([0.5, 1, 0, 0, 1, 0.28]);
    const nrm = new Float32Array([0, 0, 1, 0, 0, 1, 0, 0, 1]);
    jg.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    jg.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    jg.setAttribute('normal', new THREE.BufferAttribute(nrm, 3));
    jg.setAttribute('aEmblem', new THREE.BufferAttribute(new Float32Array(3), 1));
    const jib = new THREE.Mesh(jg, sailMat);
    jib.rotation.y = Math.PI / 2;                 // lie athwartships so it bellies sideways
    jib.position.set(0, headY, headZ);
    jib.castShadow = true; jib.receiveShadow = false;
    group.add(jib);
    sails.push(jib);
    // its stay + sheet
    standing.push(0, headY, headZ, 0, deckY + F * 0.4, tackZ);
    running.push(0, headY - jh * 0.55, headZ + 0.2, foreMz * 0.5, deckY + 0.4, foreMz + 1);
  }

  // --- spanker (gaff sail) aft on the mizzen/main for multi-masted ships ---
  if (masts >= 2) {
    const am = mastMeta[mastMeta.length - 1];
    const spW = clamp(L * 0.14, 2, 5);
    const spH = am.mh * 0.42;
    const spGeo = new THREE.PlaneGeometry(spW, spH, 6, 6);
    spGeo.translate(-spW / 2, -spH / 2, 0);       // luff (leading edge) toward the mast
    spGeo.setAttribute('aEmblem', new THREE.BufferAttribute(new Float32Array(spGeo.attributes.position.count), 1));
    const spanker = new THREE.Mesh(spGeo, sailMat);
    spanker.rotation.y = Math.PI / 2;
    spanker.position.set(0, am.baseY + am.mh * 0.5, am.mz - 0.15);
    spanker.castShadow = true; spanker.receiveShadow = false;
    group.add(spanker);
    sails.push(spanker);
    // gaff (upper, peaked) + boom (lower) spars — laid fore-and-aft along Z
    const spMidY = am.baseY + am.mh * 0.5;
    timberB.push(place(new THREE.CylinderGeometry(0.04, 0.05, spW + 0.4, 5), { rx: Math.PI / 2, rz: 0.32, x: 0, y: spMidY + spH / 2, z: am.mz - spW / 2 }));
    timberB.push(place(new THREE.CylinderGeometry(0.045, 0.05, spW + 0.4, 5), { rx: Math.PI / 2, x: 0, y: spMidY - spH / 2, z: am.mz - spW / 2 }));
  }

  // ---- cannons + gun ports + fire points ------------------------------
  const firePointsL = [];
  const firePointsR = [];
  const nGun = type.cannonsPerSide;
  for (let i = 0; i < nGun; i++) {
    const t = 0.28 + (i / Math.max(nGun - 1, 1)) * 0.44;
    const z = -L / 2 + t * L;
    const hw = halfW(t);
    const gy = deckY + 0.5;
    for (const side of [-1, 1]) {
      const sx = side * (hw - 0.05);
      // barrel (iron) + carriage (timber) + gilt port frame
      ironB.push(place(new THREE.CylinderGeometry(0.08, 0.11, 1.0, 7), { rz: Math.PI / 2, x: sx, y: gy, z }));
      ironB.push(place(new THREE.SphereGeometry(0.1, 6, 6), { x: side * (hw - 0.45), y: gy, z })); // cascabel
      timberB.push(place(new THREE.BoxGeometry(0.3, 0.28, 0.5), { x: side * (hw - 0.35), y: gy - 0.25, z }));
      giltB.push(place(new THREE.TorusGeometry(0.2, 0.03, 5, 10), { ry: Math.PI / 2, x: side * (hw + 0.02), y: gy, z }));
      (side < 0 ? firePointsL : firePointsR).push(new THREE.Vector3(side * (hw + 0.5), gy, z));
    }
  }

  // ---- anchor at the cathead (bow) ------------------------------------
  for (const s of [-1, 1]) {
    const cx = s * halfW(0.9) * 0.95, cy = deckY + 0.4, cz = L * 0.4;
    // cathead beam
    timberB.push(place(new THREE.BoxGeometry(0.12, 0.12, 0.9), { rx: 0.3, ry: s * 0.5, x: cx, y: cy + 0.2, z: cz + 0.3 }));
    if (s === -1) {
      // stocked anchor hanging on the port cathead (iron)
      const ax = cx - 0.3, ay = cy - 0.5, az = cz + 0.4;
      ironB.push(place(new THREE.CylinderGeometry(0.05, 0.05, 1.3, 6), { x: ax, y: ay, z: az }));           // shank
      ironB.push(place(new THREE.TorusGeometry(0.13, 0.04, 6, 8, Math.PI), { rz: 0, x: ax, y: ay - 0.6, z: az })); // arms/crown
      ironB.push(place(new THREE.ConeGeometry(0.1, 0.22, 5), { rz: Math.PI / 2, x: ax - 0.34, y: ay - 0.62, z: az }));
      ironB.push(place(new THREE.ConeGeometry(0.1, 0.22, 5), { rz: -Math.PI / 2, x: ax + 0.34, y: ay - 0.62, z: az }));
      ironB.push(place(new THREE.BoxGeometry(0.7, 0.06, 0.06), { x: ax, y: ay + 0.6, z: az }));              // stock
      ironB.push(place(new THREE.TorusGeometry(0.08, 0.02, 5, 8), { rx: Math.PI / 2, x: ax, y: ay + 0.68, z: az })); // ring
    }
  }

  // ---- flag at the tallest masthead -----------------------------------
  const flagMat = makeFlagMaterial(isPlayer ? null : opts.faction);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(2.3, 1.35, 8, 4), flagMat);
  flag.geometry.translate(1.15, 0, 0);   // hoist edge at the halyard
  flag.receiveShadow = false;
  const mainMm = mastMeta[mainMastIndex];
  flag.position.set(0, mainMm.topY + 0.7, mainMm.mz);
  group.add(flag);
  // ensign halyard
  standing.push(0, mainMm.topY + 0.7, mainMm.mz, 0, mainMm.topY, mainMm.mz);

  // ---- bake merged meshes ---------------------------------------------
  const hullMesh = meshFromBucket(plankB, plankMat, { cast: true, receive: true });
  group.add(hullMesh);
  const deckMesh = meshFromBucket(deckB, deckMat, { cast: false, receive: true });
  if (deckMesh) group.add(deckMesh);
  const timberMesh = meshFromBucket(timberB, timberMat, { cast: true, receive: true });
  if (timberMesh) group.add(timberMesh);
  const giltMesh = meshFromBucket(giltB, giltMat, { cast: true, receive: false });
  if (giltMesh) group.add(giltMesh);
  const ironMesh = meshFromBucket(ironB, ironMat, { cast: true, receive: false });
  if (ironMesh) group.add(ironMesh);

  if (standing.length) {
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.Float32BufferAttribute(standing, 3));
    group.add(new THREE.LineSegments(sg, new THREE.LineBasicMaterial({ color: 0x161009, transparent: true, opacity: 0.9 })));
  }
  if (running.length) {
    const rg = new THREE.BufferGeometry();
    rg.setAttribute('position', new THREE.Float32BufferAttribute(running, 3));
    group.add(new THREE.LineSegments(rg, new THREE.LineBasicMaterial({ color: 0x5b4a30, transparent: true, opacity: 0.75 })));
  }

  // ---- CONTRACT: publish parts ----------------------------------------
  group.userData.parts = {
    sails,
    sailMat,
    flag,
    flagMat,
    firePointsL,
    firePointsR,
    deckY,
    lanternMat,
    lanternLight,
    hullMesh,
  };
  group.userData.type = type;
  group.userData.sternWindows = sternWinMat;
  return group;
}

export { PAINTS };
