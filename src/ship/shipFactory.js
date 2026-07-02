// The shipwright: procedural hulls, masts, cloth sails, rigging, and flags.
// Ships are built along +Z (bow at +length/2). y=0 is the design waterline.
import * as THREE from 'three';
import { clamp01, lerp } from '../core/utils.js';
import { SHIP_TYPES } from './shipTypes.js';

const PAINTS = {
  default: { hull: '#5c4028', stripe: '#c9a24b' },
  storm: { hull: '#3d3a38', stripe: '#8a9aa8' },
  pearl: { hull: '#8a7a5c', stripe: '#e8dcc0' },
  blood: { hull: '#5c2018', stripe: '#c9a24b' },
  navy: { hull: '#2c3548', stripe: '#dfe3ec' },
  vermillion: { hull: '#6e2418', stripe: '#c9a24b' },
};

let _texCache = null;
function textures() {
  if (_texCache) return _texCache;
  _texCache = {};
  return _texCache;
}

function plankTexture(base, stripe) {
  const key = `plank:${base}:${stripe}`;
  const cache = textures();
  if (cache[key]) return cache[key];
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, 256, 256);
  // strakes
  for (let i = 0; i < 16; i++) {
    g.fillStyle = i % 2 ? 'rgba(0,0,0,0.13)' : 'rgba(255,255,255,0.045)';
    g.fillRect(0, i * 16, 256, 2.4);
    for (let j = 0; j < 4; j++) {
      g.fillStyle = 'rgba(0,0,0,0.2)';
      g.fillRect(((i * 67 + j * 61) % 250), i * 16 + 2, 2, 14);
    }
  }
  // waterline stripe near the bottom of the UV (v≈0.32 is just above waterline)
  g.fillStyle = stripe;
  g.fillRect(0, 150, 256, 10);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  cache[key] = tex;
  return tex;
}

function deckTexture() {
  const cache = textures();
  if (cache.deck) return cache.deck;
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#8a6a44';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 20; i++) {
    g.fillStyle = i % 2 ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.05)';
    g.fillRect(i * 13, 0, 2, 256);
    g.fillStyle = 'rgba(0,0,0,0.16)';
    g.fillRect(i * 13 + 2, (i * 83) % 256, 11, 2);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  cache.deck = tex;
  return tex;
}

function sailTexture(isPlayer) {
  const key = isPlayer ? 'sail:player' : 'sail:plain';
  const cache = textures();
  if (cache[key]) return cache[key];
  const c = document.createElement('canvas');
  c.width = 256; c.height = 256;
  const g = c.getContext('2d');
  g.fillStyle = '#e9e2d0';
  g.fillRect(0, 0, 256, 256);
  for (let i = 0; i < 8; i++) {
    g.fillStyle = 'rgba(120,100,70,0.12)';
    g.fillRect(0, i * 32, 256, 2);
  }
  // patches & stains
  g.fillStyle = 'rgba(160,140,110,0.18)';
  g.fillRect(40, 170, 34, 26);
  g.fillRect(180, 60, 28, 30);
  if (isPlayer) {
    // faded white-flag gull emblem
    g.strokeStyle = 'rgba(90,102,114,0.4)';
    g.lineWidth = 7;
    g.beginPath();
    g.arc(100, 148, 52, Math.PI * 1.15, Math.PI * 1.62);
    g.stroke();
    g.beginPath();
    g.arc(156, 148, 52, Math.PI * 1.38, Math.PI * 1.85);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  cache[key] = tex;
  return tex;
}

function flagTexture(faction) {
  const key = `flag:${faction?.key ?? 'white'}`;
  const cache = textures();
  if (cache[key]) return cache[key];
  const c = document.createElement('canvas');
  c.width = 128; c.height = 80;
  const g = c.getContext('2d');
  const base = faction?.flag?.base ?? 'white';
  const colors = { white: '#e8e4da', blue: '#1e3a6e', red: '#7e2a1e', teal: '#1d6f6d' };
  g.fillStyle = colors[base] ?? '#e8e4da';
  g.fillRect(0, 0, 128, 80);
  const emblem = faction?.flag?.emblem ?? 'gull';
  g.strokeStyle = base === 'white' ? '#5a6672' : '#e8dcc0';
  g.fillStyle = g.strokeStyle;
  g.lineWidth = 4;
  if (emblem === 'gull') {
    g.beginPath(); g.arc(48, 48, 22, Math.PI * 1.15, Math.PI * 1.62); g.stroke();
    g.beginPath(); g.arc(78, 48, 22, Math.PI * 1.38, Math.PI * 1.85); g.stroke();
  } else if (emblem === 'crown') {
    g.fillRect(44, 40, 40, 14);
    for (let i = 0; i < 4; i++) g.fillRect(44 + i * 11, 28, 6, 14);
  } else if (emblem === 'scales') {
    g.fillRect(62, 24, 4, 32); g.fillRect(44, 24, 40, 4);
    g.beginPath(); g.arc(48, 40, 9, 0, Math.PI); g.stroke();
    g.beginPath(); g.arc(80, 40, 9, 0, Math.PI); g.stroke();
  } else { // spiral
    g.beginPath();
    for (let a = 0; a < Math.PI * 4; a += 0.2) {
      const r = 3 + a * 3.4;
      const x = 64 + Math.cos(a) * r, y = 40 + Math.sin(a) * r * 0.8;
      if (a === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  cache[key] = tex;
  return tex;
}

// ---- hull loft ----

function hullGeometry(type) {
  const L = type.length, B = type.beam, D = type.draft, F = type.freeboard;
  const NS = 13;  // stations along length
  const NC = 11;  // points per cross-section (gunwale→keel→gunwale)
  const positions = [];
  const uvs = [];
  const indices = [];

  const halfW = (t) => (B / 2) * Math.pow(Math.sin(Math.PI * Math.pow(t, 0.78)), 0.62);
  const draftAt = (t) => D * (0.3 + 0.7 * Math.pow(Math.sin(Math.PI * t), 0.7));
  const sheer = (t) => F * (1 + 0.6 * Math.pow(Math.abs(t - 0.42) / 0.58, 1.9));

  for (let i = 0; i < NS; i++) {
    const t = i / (NS - 1);          // 0 = stern, 1 = bow
    const z = -L / 2 + t * L;
    const hw = Math.max(halfW(t), 0.045);
    const dr = draftAt(t);
    const dy = sheer(t);
    for (let j = 0; j < NC; j++) {
      const a = (j / (NC - 1)) * Math.PI; // 0 starboard gunwale → π port gunwale
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
  const sternBase = 0;
  for (let j = 0; j < NC - 2; j++) {
    indices.push(sternBase, sternBase + j + 1, sternBase + j + 2);
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(indices);
  geo.computeVertexNormals();
  return { geo, halfW, sheer };
}

function deckGeometry(type, halfW, sheer) {
  const L = type.length;
  const NS = 13;
  const positions = [];
  const uvs = [];
  const indices = [];
  for (let i = 0; i < NS; i++) {
    const t = i / (NS - 1);
    const z = -L / 2 + t * L;
    const hw = Math.max(halfW(t) * 0.95, 0.03);
    const y = sheer(t) - Math.min(0.85, type.freeboard * 0.35);
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

/** Cloth billow via onBeforeCompile; per-ship uniforms in material.userData. */
function makeSailMaterial(isPlayer) {
  const mat = new THREE.MeshStandardMaterial({
    map: sailTexture(isPlayer),
    side: THREE.DoubleSide,
    roughness: 0.9,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uSail = { value: 1 };
    shader.uniforms.uAlign = { value: 1 };
    shader.uniforms.uTime = { value: 0 };
    mat.userData.shader = shader;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
uniform float uSail;
uniform float uAlign;
uniform float uTime;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  float dome = sin(3.14159 * uv.x) * sin(3.14159 * (uv.y * 0.85 + 0.075));
  float billow = uSail * (0.5 + 0.5 * uAlign);
  transformed.z += dome * billow * 1.35;
  float luff = (1.0 - uAlign) * uSail;
  transformed.z += sin(uTime * 9.0 + uv.y * 9.0 + uv.x * 4.0) * 0.06 * (luff + 0.12);
  // furling: shrink the sail upward as uSail drops
  transformed.y = mix(transformed.y, abs(transformed.y) * 0.06 + transformed.y * 0.06, (1.0 - uSail) * step(transformed.y, 0.0) );
}`);
  };
  return mat;
}

function makeFlagMaterial(faction) {
  const mat = new THREE.MeshStandardMaterial({
    map: flagTexture(faction),
    side: THREE.DoubleSide,
    roughness: 0.85,
  });
  mat.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    mat.userData.shader = shader;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
transformed.z += sin(uTime * 6.0 + uv.x * 7.0) * 0.16 * uv.x;
transformed.y += sin(uTime * 5.1 + uv.x * 5.0) * 0.05 * uv.x;`);
  };
  return mat;
}

export function buildShip(typeKey, opts = {}) {
  const type = SHIP_TYPES[typeKey] ?? SHIP_TYPES.sloop;
  const paint = PAINTS[opts.paint] ??
    (opts.faction?.key === 'crown' ? PAINTS.navy
      : opts.faction?.key === 'concern' ? PAINTS.vermillion : PAINTS.default);
  const group = new THREE.Group();
  group.name = `ship:${typeKey}`;

  const { geo: hullGeo, halfW, sheer } = hullGeometry(type);
  const hullMat = new THREE.MeshStandardMaterial({
    map: plankTexture(paint.hull, paint.stripe),
    roughness: 0.82,
    metalness: 0.04,
  });
  const hull = new THREE.Mesh(hullGeo, hullMat);
  hull.castShadow = true;
  hull.receiveShadow = true;
  group.add(hull);

  const deckMat = new THREE.MeshStandardMaterial({ map: deckTexture(), roughness: 0.9 });
  const deck = new THREE.Mesh(deckGeometry(type, halfW, sheer), deckMat);
  deck.receiveShadow = true;
  group.add(deck);
  const deckY = sheer(0.45) - Math.min(0.85, type.freeboard * 0.35);

  const darkWood = new THREE.MeshStandardMaterial({ color: 0x3e2f20, roughness: 0.9 });

  // stern castle on bigger hulls
  if (type.length >= 24) {
    const castle = new THREE.Mesh(
      new THREE.BoxGeometry(type.beam * 0.82, type.freeboard * 0.8, type.length * 0.18),
      hullMat,
    );
    castle.position.set(0, sheer(0.06) + type.freeboard * 0.28, -type.length * 0.38);
    castle.castShadow = true;
    group.add(castle);
    // stern gallery windows
    const winMat = new THREE.MeshStandardMaterial({
      color: 0x2a2018, emissive: 0xffb45e, emissiveIntensity: 0,
    });
    const windows = new THREE.Mesh(
      new THREE.PlaneGeometry(type.beam * 0.6, 0.5),
      winMat,
    );
    windows.position.set(0, sheer(0.02) + 0.5, -type.length / 2 - 0.01);
    windows.rotation.y = Math.PI;
    group.add(windows);
    group.userData.sternWindows = winMat;
  }

  // bowsprit
  const bowsprit = new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.12, type.length * 0.28, 6), darkWood);
  bowsprit.rotation.x = -Math.PI / 2 + 0.28;
  bowsprit.position.set(0, sheer(1) + 0.2, type.length / 2 + type.length * 0.1);
  group.add(bowsprit);

  // masts + yards + sails
  const isPlayer = !!opts.player;
  const sailMat = makeSailMaterial(isPlayer);
  const sails = [];
  const mastMat = darkWood;
  const mastPositions = type.masts === 1 ? [0.05]
    : type.masts === 2 ? [0.24, -0.22]
      : [0.3, 0.02, -0.28];
  const mastHeight = type.length * (type.masts === 1 ? 1.05 : 0.82);

  for (let m = 0; m < mastPositions.length; m++) {
    const mz = mastPositions[m] * type.length;
    const mh = mastHeight * (m === 1 ? 1.08 : 1) * (m === 2 ? 0.86 : 1);
    const mast = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.2, mh, 8), mastMat);
    mast.position.set(0, deckY + mh / 2, mz);
    mast.castShadow = true;
    group.add(mast);

    // two square sails per mast
    for (let s = 0; s < 2; s++) {
      const sw = type.beam * (1.5 - s * 0.35);
      const sh = mh * (0.32 - s * 0.05);
      const yardY = deckY + mh * (0.52 + s * 0.32);
      const yard = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, sw + 0.6, 6), mastMat);
      yard.rotation.z = Math.PI / 2;
      yard.position.set(0, yardY, mz);
      group.add(yard);

      const sail = new THREE.Mesh(new THREE.PlaneGeometry(sw, sh, 8, 8), sailMat);
      sail.position.set(0, yardY - sh / 2 - 0.1, mz - 0.12);
      sail.castShadow = true;
      group.add(sail);
      sails.push(sail);
    }

    // simple shrouds
    const rig = new THREE.BufferGeometry();
    const pts = [];
    for (const side of [-1, 1]) {
      pts.push(0, deckY + mh * 0.95, mz, side * type.beam * 0.48, deckY, mz + 1.2);
      pts.push(0, deckY + mh * 0.95, mz, side * type.beam * 0.48, deckY, mz - 1.2);
    }
    // stays fore/aft
    pts.push(0, deckY + mh * 0.98, mz, 0, sheer(1) + 0.3, type.length / 2 + 0.4);
    pts.push(0, deckY + mh * 0.98, mz, 0, sheer(0) + 0.4, -type.length / 2 + 0.2);
    rig.setAttribute('position', new THREE.Float32BufferAttribute(pts, 3));
    const rigLines = new THREE.LineSegments(rig, new THREE.LineBasicMaterial({ color: 0x241c12 }));
    group.add(rigLines);
  }

  // flag at the tallest mast
  const flagMat = makeFlagMaterial(isPlayer ? null : opts.faction);
  const flag = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 1.3, 6, 3), flagMat);
  const mainIdx = type.masts === 1 ? 0 : 1;
  const mainMz = mastPositions[Math.min(mainIdx, mastPositions.length - 1)] * type.length;
  const mainMh = mastHeight * (mastPositions.length > 1 ? 1.08 : 1);
  flag.position.set(1.15, deckY + mainMh + 0.7, mainMz);
  group.add(flag);

  // cannons through the bulwarks + fire points
  const cannonMat = new THREE.MeshStandardMaterial({ color: 0x1c1a18, roughness: 0.5, metalness: 0.6 });
  const firePointsL = [];
  const firePointsR = [];
  const n = type.cannonsPerSide;
  for (let i = 0; i < n; i++) {
    const t = 0.28 + (i / Math.max(n - 1, 1)) * 0.44; // spread amidships
    const z = -type.length / 2 + t * type.length;
    const hw = halfW(t);
    const y = sheer(t) - Math.min(0.85, type.freeboard * 0.35) + 0.32;
    for (const side of [-1, 1]) {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.12, 1.1, 6), cannonMat);
      barrel.rotation.z = Math.PI / 2;
      barrel.position.set(side * (hw - 0.1), y, z);
      group.add(barrel);
      const p = new THREE.Vector3(side * (hw + 0.5), y, z);
      (side < 0 ? firePointsL : firePointsR).push(p);
    }
  }

  // ship's wheel
  const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.42, 0.05, 6, 12), darkWood);
  wheel.position.set(0, deckY + 1.0, -type.length * 0.32);
  group.add(wheel);

  // stern lanterns
  const lanternMat = new THREE.MeshStandardMaterial({
    color: 0xfff2d0, emissive: 0xffb45e, emissiveIntensity: 0.25,
  });
  for (const side of [-1, 1]) {
    const lamp = new THREE.Mesh(new THREE.SphereGeometry(0.16, 8, 8), lanternMat);
    lamp.position.set(side * type.beam * 0.32, sheer(0.02) + 0.9, -type.length / 2 + 0.4);
    group.add(lamp);
  }
  let lanternLight = null;
  if (isPlayer) {
    lanternLight = new THREE.PointLight(0xffb45e, 0, 26, 2);
    lanternLight.position.set(0, deckY + 2.4, -type.length * 0.3);
    group.add(lanternLight);
  }

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
    hullMesh: hull,
  };
  group.userData.type = type;
  return group;
}

export { PAINTS };
