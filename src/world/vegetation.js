// Instanced flora: palms, broadleaf & jungle canopy, mangrove root tangles,
// ferns, flowering shrubs, grass, rocks — deterministic per island seed, with
// vertex wind sway (uniform-driven by ctx.weather.wind) and golden-hour leaf
// translucency. Every prop type is a single InstancedMesh; canopies/shrubs get
// per-instance colour variation via instanceColor. Zero per-frame allocation.
import * as THREE from 'three';
import { clamp, clamp01, mulberry32, randRange } from '../core/utils.js';

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _col = new THREE.Color();
const _up = new THREE.Vector3(0, 1, 0);

// ---------- procedural textures ----------

function frondTexture(base = [58, 110, 40]) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 128;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 256, 128);
  const midY = 64;
  g.lineCap = 'round';
  // rachis
  g.strokeStyle = '#335d1e';
  g.lineWidth = 4.5;
  g.beginPath(); g.moveTo(6, midY); g.quadraticCurveTo(150, midY - 6, 248, midY - 2); g.stroke();
  const N = 27;
  for (let i = 0; i < N; i++) {
    const p = i / (N - 1);
    const x = 8 + p * 236;
    const yb = midY - 6 * Math.sin(p * Math.PI);
    const len = (1 - Math.abs(p - 0.4)) * 42 * (1 - p * 0.3) + 6;
    const r = Math.round(base[0] + p * 62);
    const gg = Math.round(base[1] + p * 46);
    const b = Math.round(base[2] + p * 30);
    g.strokeStyle = `rgba(${r},${gg},${b},${0.9 - p * 0.18})`; // translucent tips
    g.lineWidth = 2.3;
    g.beginPath(); g.moveTo(x, yb); g.lineTo(x - len * 0.5, yb - len); g.stroke();
    g.beginPath(); g.moveTo(x, yb); g.lineTo(x - len * 0.5, yb + len); g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

function grassTexture() {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 64;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 64, 64);
  g.lineCap = 'round';
  for (let i = 0; i < 18; i++) {
    const x = 3 + i * 3.4;
    const h = 22 + ((i * 53) % 28);
    const p = (i % 4) / 4;
    g.strokeStyle = `rgba(${60 + (p * 30 | 0)},${108 + (p * 42 | 0)},${46 + (p * 22 | 0)},0.92)`;
    g.lineWidth = 1.8;
    g.beginPath();
    g.moveTo(x, 64);
    g.quadraticCurveTo(x + 3, 64 - h * 0.6, x + ((i % 2) * 7 - 3), 64 - h);
    g.stroke();
  }
  // a few flower specks
  const flowers = ['#e8d26a', '#e0a0c0', '#f2f2ee'];
  for (let i = 0; i < 3; i++) {
    g.fillStyle = flowers[i];
    g.beginPath(); g.arc(12 + i * 20, 22 + ((i * 13) % 16), 2.3, 0, 6.283); g.fill();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

// ---------- sway shader ----------

// Uniform-driven vertex sway. Phase is derived from each instance's world
// translation (instanceMatrix column 3) so a coherent gust travels across the
// field; tips move, roots stay. `flutter` adds a fast leaf shimmer.
function addSway(material, amount, height, flutter = 0) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uWind = { value: 1 };
    material.userData.shader = shader;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nuniform float uTime;\nuniform float uWind;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  vec3 iw = vec3(instanceMatrix[3][0], instanceMatrix[3][1], instanceMatrix[3][2]);
  float ph = iw.x * 0.06 + iw.z * 0.055 + float(gl_InstanceID) * 0.6;
  float hn = clamp(position.y / ${height.toFixed(2)}, 0.0, 1.0);
  float k = pow(hn, 1.5);
  float gust = 0.75 + 0.25 * sin(uTime * 0.5 + ph * 0.2);
  float bend = (sin(uTime * 1.5 + ph) + 0.35 * sin(uTime * 3.3 + ph * 1.7)) * ${amount.toFixed(3)} * uWind * k * gust;
  transformed.x += bend;
  transformed.z += bend * 0.65;
  ${flutter > 0 ? `float fl = sin(uTime * 7.0 + ph * 3.0 + position.x * 4.0) * ${flutter.toFixed(3)} * uWind * k;
  transformed.y += fl * 0.3; transformed.x += fl;` : ''}
}`);
  };
  return material;
}

// ---------- geometry helpers ----------

function mergeGeoms(geos) {
  const flat = geos.map((g) => (g.index ? g.toNonIndexed() : g));
  let total = 0;
  for (const g of flat) total += g.attributes.position.count;
  const posArr = new Float32Array(total * 3);
  const normArr = new Float32Array(total * 3);
  const uvArr = new Float32Array(total * 2);
  let vo = 0;
  for (const ng of flat) {
    const p = ng.attributes.position;
    posArr.set(p.array, vo * 3);
    if (ng.attributes.normal) normArr.set(ng.attributes.normal.array, vo * 3);
    if (ng.attributes.uv) uvArr.set(ng.attributes.uv.array, vo * 2);
    vo += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normArr, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
  return out;
}

function palmGeometry() {
  const parts = [];
  let y = 0, x = 0;
  for (let i = 0; i < 6; i++) {
    const r0 = Math.max(0.05, 0.16 - i * 0.017);
    const r1 = Math.max(0.06, 0.19 - i * 0.017);
    const seg = new THREE.CylinderGeometry(r0, r1, 1.35, 7);
    seg.translate(0, 0.675, 0);
    const bend = 0.06 * i;
    seg.rotateZ(bend);
    seg.translate(x, y, 0);
    y += Math.cos(bend) * 1.32;
    x += Math.sin(bend) * 1.32;
    parts.push(seg);
  }
  return { trunk: mergeGeoms(parts), top: new THREE.Vector3(x, y, 0) };
}

function frondCrown(top) {
  const parts = [];
  const tiers = [
    { count: 7, tilt: -0.32, len: 2.9, w: 1.15 },
    { count: 6, tilt: 0.28, len: 2.35, w: 0.95 },
  ];
  for (const tier of tiers) {
    for (let i = 0; i < tier.count; i++) {
      const fg = new THREE.PlaneGeometry(tier.len, tier.w);
      fg.translate(tier.len * 0.5, 0, 0);
      fg.rotateZ(tier.tilt);
      fg.rotateY((i / tier.count) * Math.PI * 2 + tier.tilt);
      fg.translate(top.x, top.y, top.z);
      parts.push(fg);
    }
  }
  return mergeGeoms(parts);
}

function canopyTree({ trunkH, trunkR, blobs }) {
  const trunk = new THREE.CylinderGeometry(trunkR * 0.7, trunkR, trunkH, 7);
  trunk.translate(0, trunkH / 2, 0);
  const parts = [];
  for (const b of blobs) {
    const g = new THREE.IcosahedronGeometry(b.r, 1);
    g.scale(b.sx ?? 1, b.sy ?? 0.8, b.sz ?? 1);
    g.translate(b.x ?? 0, b.y ?? 0, b.z ?? 0);
    parts.push(g);
  }
  return { trunk, canopy: mergeGeoms(parts) };
}

function mangroveGeometry() {
  const parts = [];
  const nRoots = 9;
  for (let i = 0; i < nRoots; i++) {
    const ang = (i / nRoots) * Math.PI * 2;
    const root = new THREE.CylinderGeometry(0.045, 0.08, 1.75, 4);
    root.translate(0, 0.85, 0);
    root.rotateZ(0.55);
    root.rotateY(ang);
    root.translate(Math.cos(ang) * 0.35, 0, Math.sin(ang) * 0.35);
    parts.push(root);
  }
  const trunk = new THREE.CylinderGeometry(0.13, 0.17, 1.7, 6);
  trunk.translate(0, 2.05, 0);
  parts.push(trunk);
  const canopy = new THREE.IcosahedronGeometry(1.35, 1);
  canopy.scale(1.35, 0.62, 1.35);
  canopy.translate(0, 3.05, 0);
  return { structure: mergeGeoms(parts), canopy: mergeGeoms([canopy]) };
}

function fernGeometry() {
  const parts = [];
  const n = 7;
  for (let i = 0; i < n; i++) {
    const fg = new THREE.PlaneGeometry(1.2, 0.5);
    fg.translate(0.6, 0, 0);
    fg.rotateZ(0.18 + (i % 2) * 0.12);
    fg.rotateY((i / n) * Math.PI * 2);
    fg.translate(0, 0.18, 0);
    parts.push(fg);
  }
  return mergeGeoms(parts);
}

function shrubGeometry() {
  const b1 = new THREE.IcosahedronGeometry(0.6, 1); b1.scale(1, 0.82, 1); b1.translate(0, 0.5, 0);
  const b2 = new THREE.IcosahedronGeometry(0.42, 1); b2.translate(0.35, 0.44, 0.2);
  const b3 = new THREE.IcosahedronGeometry(0.38, 1); b3.translate(-0.3, 0.42, -0.15);
  return mergeGeoms([b1, b2, b3]);
}

function rockGeometry(seed) {
  const geo = new THREE.IcosahedronGeometry(1, 1);
  const p = geo.attributes.position;
  const rng = mulberry32(seed);
  for (let i = 0; i < p.count; i++) {
    p.setXYZ(i,
      p.getX(i) * randRange(rng, 0.78, 1.24),
      p.getY(i) * randRange(rng, 0.6, 1.12),
      p.getZ(i) * randRange(rng, 0.78, 1.24));
  }
  geo.computeVertexNormals();
  return geo;
}

function deadTreeGeometry() {
  const parts = [];
  const trunk = new THREE.CylinderGeometry(0.08, 0.18, 4.4, 5);
  trunk.translate(0, 2.2, 0);
  parts.push(trunk);
  for (let i = 0; i < 4; i++) {
    const br = new THREE.CylinderGeometry(0.03, 0.06, 1.7, 4);
    br.translate(0, 0.85, 0);
    br.rotateZ(0.9);
    br.rotateY(i * 1.7);
    br.translate(0, 2.3 + i * 0.6, 0);
    parts.push(br);
  }
  return mergeGeoms(parts);
}

// ---------- build ----------

export function buildVegetation(ctx, world) {
  const density = ctx.engine?.qualityProfile?.vegDensity ?? 1;
  const shadows = ctx.engine?.qualityProfile?.shadows ?? true;
  const group = new THREE.Group();
  group.name = 'vegetation';
  ctx.scene.add(group);

  const P = { palm: [], tree: [], jungle: [], mangrove: [], fern: [], shrub: [], grass: [], rock: [], deadtree: [] };

  for (const isl of world.islands) {
    const rng = mulberry32(isl.def.seed + 99);
    const R = isl.radius * 1.25;
    const biome = isl.def.biome;
    const tries = Math.round(isl.radius * 2.8 * density);
    for (let i = 0; i < tries; i++) {
      const x = isl.center.x + randRange(rng, -R, R);
      const z = isl.center.z + randRange(rng, -R, R);
      const h = world.field.heightAt(x, z);
      if (h < -1.8 || h > 130) continue;
      const slope = h > 0.4 ? world.field.slopeAt(x, z) : 1;
      const r = rng();
      const base = { x, z, rot: rng() * 6.283, k: rng() };

      // steep rocky faces at any altitude
      if (h > 2.5 && slope > 0.42 && r < 0.4) {
        P.rock.push({ ...base, y: h - 0.3, s: randRange(rng, 0.7, 2.4) });
        continue;
      }

      if (biome === 'mangrove') {
        if (h > -1.6 && h < 2.2) {
          if (r < 0.6) P.mangrove.push({ ...base, y: Math.max(h, -0.5), s: randRange(rng, 0.8, 1.45) });
          else if (r < 0.8) P.grass.push({ ...base, y: h, s: randRange(rng, 0.7, 1.2) });
          else P.fern.push({ ...base, y: h, s: randRange(rng, 0.8, 1.3) });
        } else if (h >= 2.2 && h < 45 && slope < 0.5) {
          if (r < 0.4) P.tree.push({ ...base, y: h - 0.2, s: randRange(rng, 0.9, 1.5) });
          else if (r < 0.7) P.shrub.push({ ...base, y: h, s: randRange(rng, 0.7, 1.4) });
          else P.grass.push({ ...base, y: h, s: randRange(rng, 0.8, 1.2) });
        }
        continue;
      }

      if (biome === 'volcanic') {
        if (h > 0.9 && h < 5 && slope < 0.4) {
          if (r < 0.5) P.grass.push({ ...base, y: h, s: randRange(rng, 0.6, 1.0) });
          else if (r < 0.7) P.shrub.push({ ...base, y: h, s: randRange(rng, 0.6, 1.1) });
        } else if (h >= 4 && h < 95) {
          if (r < 0.16) P.deadtree.push({ ...base, y: h - 0.1, s: randRange(rng, 0.8, 1.4) });
          else if (r < 0.4) P.rock.push({ ...base, y: h - 0.3, s: randRange(rng, 0.7, 2.2) });
          else if (r < 0.5 && h < 40) P.shrub.push({ ...base, y: h, s: randRange(rng, 0.5, 0.9) });
        }
        continue;
      }

      if (biome === 'rock') {
        if (h > 1.5) {
          if (r < 0.4) P.rock.push({ ...base, y: h - 0.3, s: randRange(rng, 0.8, 2.6) });
          else if (slope < 0.5 && r < 0.62) P.grass.push({ ...base, y: h, s: randRange(rng, 0.7, 1.2) });
          else if (slope < 0.5 && r < 0.75) P.shrub.push({ ...base, y: h, s: randRange(rng, 0.6, 1.1) });
          else if (slope < 0.45 && h > 6 && r < 0.83) P.deadtree.push({ ...base, y: h - 0.1, s: randRange(rng, 0.7, 1.1) });
        }
        continue;
      }

      // tropical / atoll / jungle (lush)
      const isJungle = biome === 'jungle';
      if (h > 0.8 && h < 6 && slope < 0.42) {
        if (r < (isJungle ? 0.28 : 0.42)) P.palm.push({ ...base, y: h - 0.15, s: randRange(rng, 0.85, 1.4), sy: randRange(rng, 1.0, 1.25) });
        else if (r < 0.6) P.grass.push({ ...base, y: h, s: randRange(rng, 0.7, 1.3) });
        else if (r < 0.78) P.shrub.push({ ...base, y: h, s: randRange(rng, 0.7, 1.4) });
        else if (isJungle && r < 0.92) P.fern.push({ ...base, y: h, s: randRange(rng, 0.8, 1.4) });
      } else if (h >= 6 && h < (isJungle ? 120 : 80) && slope < 0.55) {
        if (isJungle) {
          if (r < 0.5) P.jungle.push({ ...base, y: h - 0.2, s: randRange(rng, 0.9, 1.7) });
          else if (r < 0.68) P.tree.push({ ...base, y: h - 0.2, s: randRange(rng, 0.9, 1.5) });
          else if (r < 0.82) P.fern.push({ ...base, y: h, s: randRange(rng, 0.8, 1.3) });
          else if (r < 0.92) P.shrub.push({ ...base, y: h, s: randRange(rng, 0.7, 1.3) });
          else P.grass.push({ ...base, y: h, s: randRange(rng, 0.8, 1.2) });
        } else {
          if (r < 0.4) P.tree.push({ ...base, y: h - 0.2, s: randRange(rng, 0.9, 1.7) });
          else if (r < 0.62) P.shrub.push({ ...base, y: h, s: randRange(rng, 0.7, 1.3) });
          else if (r < 0.82) P.grass.push({ ...base, y: h, s: randRange(rng, 0.8, 1.2) });
        }
      }
    }
  }

  const meshes = [];
  const swayMats = [];
  const glowMats = [];

  function instantiate(geo, material, list, opts = {}) {
    if (list.length === 0) return null;
    const { shadow = false, sway = null, vary = null } = opts;
    if (sway) { addSway(material, sway.amount, sway.height, sway.flutter ?? 0); swayMats.push(material); }
    const im = new THREE.InstancedMesh(geo, material, list.length);
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      _p.set(it.x, it.y, it.z);
      _q.setFromAxisAngle(_up, it.rot);
      _s.set(it.sx ?? it.s, it.sy ?? it.s, it.sz ?? it.s);
      _m.compose(_p, _q, _s);
      im.setMatrixAt(i, _m);
      if (vary) { vary(it, _col); im.setColorAt(i, _col); }
    }
    im.castShadow = shadow && shadows;
    im.instanceMatrix.needsUpdate = true;
    if (im.instanceColor) im.instanceColor.needsUpdate = true;
    im.frustumCulled = false;
    group.add(im);
    meshes.push(im);
    return im;
  }

  // per-instance colour variety (base materials are white so this is the colour)
  const greenVary = (it, c) => c.setHSL(0.26 + (it.k - 0.5) * 0.05, 0.5 + it.k * 0.12, 0.33 + (it.k - 0.5) * 0.14);
  const jungleVary = (it, c) => c.setHSL(0.29 + (it.k - 0.5) * 0.04, 0.55 + it.k * 0.12, 0.26 + (it.k - 0.5) * 0.12);
  const mangVary = (it, c) => c.setHSL(0.27 + (it.k - 0.5) * 0.03, 0.42, 0.28 + it.k * 0.1);
  const rockVary = (it, c) => c.setHSL(0.08, 0.1 + (it.k - 0.5) * 0.06, 0.36 + (it.k - 0.5) * 0.18);
  const shrubVary = (it, c) => {
    if (it.k < 0.24) { // flowering
      const hues = [0.92, 0.78, 0.14];
      c.setHSL(hues[Math.floor(it.k * 12) % 3], 0.55, 0.6);
    } else {
      c.setHSL(0.28 + (it.k - 0.5) * 0.06, 0.5, 0.4 + (it.k - 0.5) * 0.1);
    }
  };

  // shared trunk/bark material (no sway)
  const barkMat = new THREE.MeshStandardMaterial({ color: 0x7c5a38, roughness: 0.92 });

  // ---- palms ----
  const { trunk: palmTrunkGeo, top } = palmGeometry();
  const nutParts = [palmTrunkGeo];
  for (let i = 0; i < 4; i++) {
    const nut = new THREE.IcosahedronGeometry(0.15, 0);
    nut.translate(top.x + Math.cos(i * 1.7) * 0.22, top.y - 0.18, top.z + Math.sin(i * 1.7) * 0.22);
    nutParts.push(nut);
  }
  instantiate(mergeGeoms(nutParts), barkMat, P.palm, { shadow: true });
  const frondMat = new THREE.MeshStandardMaterial({
    map: frondTexture(), alphaTest: 0.42, side: THREE.DoubleSide, roughness: 0.66,
    color: 0xffffff, emissive: new THREE.Color(0x24401a), emissiveIntensity: 0.06,
  });
  glowMats.push({ mat: frondMat, base: 0.06, boost: 0.5, cool: new THREE.Color(0x24401a), warm: new THREE.Color(0x7a5e16) });
  instantiate(frondCrown(top), frondMat, P.palm, { sway: { amount: 0.22, height: top.y + 1, flutter: 0.05 } });

  // ---- broadleaf trees ----
  const broad = canopyTree({
    trunkH: 3.4, trunkR: 0.26,
    blobs: [{ r: 1.9, y: 4.1, sy: 0.75 }, { r: 1.3, x: 0.9, y: 3.3, z: 0.5 }, { r: 1.2, x: -0.8, y: 3.6, z: -0.4 }],
  });
  const canopyBroadMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.86 });
  instantiate(broad.trunk, barkMat, P.tree, { shadow: true });
  instantiate(broad.canopy, canopyBroadMat, P.tree, { shadow: true, sway: { amount: 0.12, height: 5.6 }, vary: greenVary });

  // ---- jungle emergent trees (taller, wider crown) ----
  const jungle = canopyTree({
    trunkH: 6.6, trunkR: 0.34,
    blobs: [{ r: 2.7, y: 7.6, sy: 0.62, sx: 1.15, sz: 1.15 }, { r: 1.8, x: 1.4, y: 6.6, z: 0.8 }, { r: 1.6, x: -1.2, y: 6.9, z: -0.7 }],
  });
  const canopyJungleMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.88 });
  instantiate(jungle.trunk, barkMat, P.jungle, { shadow: true });
  instantiate(jungle.canopy, canopyJungleMat, P.jungle, { shadow: true, sway: { amount: 0.1, height: 9.5 }, vary: jungleVary });

  // ---- mangroves ----
  const mang = mangroveGeometry();
  const mangBarkMat = new THREE.MeshStandardMaterial({ color: 0x5a4a34, roughness: 0.95 });
  const mangCanopyMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  instantiate(mang.structure, mangBarkMat, P.mangrove, { shadow: true });
  instantiate(mang.canopy, mangCanopyMat, P.mangrove, { shadow: true, sway: { amount: 0.05, height: 3.6 }, vary: mangVary });

  // ---- ferns (understory) ----
  const fernMat = new THREE.MeshStandardMaterial({
    map: frondTexture([70, 130, 52]), alphaTest: 0.4, side: THREE.DoubleSide, roughness: 0.7,
    color: 0xffffff, emissive: new THREE.Color(0x2a4a1c), emissiveIntensity: 0.05,
  });
  glowMats.push({ mat: fernMat, base: 0.05, boost: 0.4, cool: new THREE.Color(0x2a4a1c), warm: new THREE.Color(0x6f6420) });
  instantiate(fernGeometry(), fernMat, P.fern, { sway: { amount: 0.14, height: 0.7, flutter: 0.06 } });

  // ---- flowering shrubs ----
  const shrubMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.9 });
  instantiate(shrubGeometry(), shrubMat, P.shrub, { shadow: true, sway: { amount: 0.08, height: 1.1 }, vary: shrubVary });

  // ---- grass tufts ----
  const grassMat = new THREE.MeshStandardMaterial({
    map: grassTexture(), alphaTest: 0.32, side: THREE.DoubleSide, roughness: 1, color: 0xffffff,
  });
  const gq1 = new THREE.PlaneGeometry(1.1, 0.85); gq1.translate(0, 0.42, 0);
  const gq2 = gq1.clone(); gq2.rotateY(Math.PI / 2);
  const gq3 = gq1.clone(); gq3.rotateY(Math.PI / 4);
  instantiate(mergeGeoms([gq1, gq2, gq3]), grassMat, P.grass, { sway: { amount: 0.13, height: 0.95, flutter: 0.05 } });

  // ---- rocks ----
  const rockMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95 });
  instantiate(rockGeometry(555), rockMat, P.rock, { shadow: true, vary: rockVary });

  // ---- dead trees (ash slopes / crags) ----
  const deadMat = new THREE.MeshStandardMaterial({ color: 0x3c3733, roughness: 1 });
  instantiate(deadTreeGeometry(), deadMat, P.deadtree, { shadow: true });

  return {
    group,
    meshes,
    update() {
      const t = ctx.time.t;
      const wind = ctx.weather?.wind;
      let windK = clamp((wind?.speed ?? 5) / 8, 0.25, 2.4);
      windK *= 0.86 + 0.14 * Math.sin(t * 0.27); // slow global gusting
      for (const mat of swayMats) {
        const sh = mat.userData.shader;
        if (sh) { sh.uniforms.uTime.value = t; sh.uniforms.uWind.value = windK; }
      }
      // golden-hour translucency: leaves warm and glow when the sun is low
      const sunY = ctx.sky?.sunDir?.y ?? 1;
      const low = clamp01(1 - sunY / 0.45);
      for (const gm of glowMats) {
        gm.mat.emissiveIntensity = gm.base + low * gm.boost;
        gm.mat.emissive.copy(gm.cool).lerp(gm.warm, low);
      }
    },
  };
}
