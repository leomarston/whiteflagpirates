// Instanced flora: palms, canopy trees, mangroves, grass, rocks — with wind sway.
import * as THREE from 'three';
import { mulberry32, randRange } from '../core/utils.js';

const _m = new THREE.Matrix4();
const _p = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _up = new THREE.Vector3(0, 1, 0);

function frondTexture() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.clearRect(0, 0, 128, 128);
  // a feathered palm frond drawn along +Y
  g.strokeStyle = '#3c6b2f';
  g.lineWidth = 3;
  g.beginPath(); g.moveTo(64, 124); g.lineTo(64, 8); g.stroke();
  for (let i = 0; i < 22; i++) {
    const y = 12 + i * 5;
    const len = 34 * (1 - Math.abs(i / 22 - 0.35));
    g.strokeStyle = i % 2 ? '#41752f' : '#356328';
    g.lineWidth = 2.4;
    g.beginPath(); g.moveTo(64, y); g.lineTo(64 - len, y + 9); g.stroke();
    g.beginPath(); g.moveTo(64, y); g.lineTo(64 + len, y + 9); g.stroke();
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
  for (let i = 0; i < 14; i++) {
    const x = 4 + i * 4.2;
    const h = 20 + (i * 37 % 30);
    g.strokeStyle = i % 3 ? '#4d7a3a' : '#3e6830';
    g.lineWidth = 1.6;
    g.beginPath();
    g.moveTo(x, 64);
    g.quadraticCurveTo(x + 3, 64 - h * 0.6, x + ((i % 2) * 8 - 4), 64 - h);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Adds gl_InstanceID-phased sway to a material (tips move, roots stay). */
function addSway(material, amount, height) {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uTime = { value: 0 };
    shader.uniforms.uWind = { value: 1 };
    material.userData.shader = shader;
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
uniform float uTime;
uniform float uWind;`)
      .replace('#include <begin_vertex>', `#include <begin_vertex>
{
  float phase = float(gl_InstanceID) * 1.71;
  float k = pow(max(position.y, 0.0) / ${height.toFixed(1)}, 1.6);
  float sway = sin(uTime * 1.4 + phase) * ${amount.toFixed(3)} * uWind * k;
  transformed.x += sway;
  transformed.z += sway * 0.6;
}`);
  };
  return material;
}

function palmGeometry() {
  const parts = [];
  // curved trunk from stacked cylinders
  let y = 0, x = 0;
  for (let i = 0; i < 4; i++) {
    const seg = new THREE.CylinderGeometry(0.11 - i * 0.015, 0.14 - i * 0.015, 1.6, 6);
    seg.translate(0, 0.8, 0);
    seg.rotateZ(0.07 * i);
    seg.translate(x, y, 0);
    y += Math.cos(0.07 * i) * 1.55;
    x += Math.sin(0.07 * i) * 1.55 * 0.5;
    parts.push(seg);
  }
  const trunk = mergeGeoms(parts);
  return { trunk, top: new THREE.Vector3(x, y, 0) };
}

function mergeGeoms(geos) {
  // minimal merge (positions/normals/uvs) to avoid the addons import here
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
    normArr.set(ng.attributes.normal.array, vo * 3);
    if (ng.attributes.uv) uvArr.set(ng.attributes.uv.array, vo * 2);
    vo += p.count;
  }
  const out = new THREE.BufferGeometry();
  out.setAttribute('position', new THREE.BufferAttribute(posArr, 3));
  out.setAttribute('normal', new THREE.BufferAttribute(normArr, 3));
  out.setAttribute('uv', new THREE.BufferAttribute(uvArr, 2));
  return out;
}

export function buildVegetation(ctx, world) {
  const density = ctx.engine?.qualityProfile?.vegDensity ?? 1;
  const shadows = ctx.engine?.qualityProfile?.shadows ?? true;
  const group = new THREE.Group();
  group.name = 'vegetation';
  ctx.scene.add(group);

  // ---- gather placements per type across ALL islands ----
  const placements = { palm: [], tree: [], mangrove: [], grass: [], rock: [], deadtree: [] };

  for (const isl of world.islands) {
    const rng = mulberry32(isl.def.seed + 99);
    const R = isl.radius * 1.25;
    const biome = isl.def.biome;
    const tries = Math.round(isl.radius * 2.4 * density);
    for (let i = 0; i < tries; i++) {
      const x = isl.center.x + randRange(rng, -R, R);
      const z = isl.center.z + randRange(rng, -R, R);
      const h = world.field.heightAt(x, z);
      const slope = h > 0.5 ? world.field.slopeAt(x, z) : 1;
      const r = rng();

      if (biome === 'mangrove' && h > -1.5 && h < 2 && r < 0.5) {
        placements.mangrove.push({ x, y: Math.max(h, -0.6), z, s: randRange(rng, 0.8, 1.4), rot: rng() * 6.28 });
      } else if (h > 0.8 && h < 6 && slope < 0.4 && (biome === 'tropical' || biome === 'atoll' || biome === 'jungle')) {
        if (r < 0.45) placements.palm.push({ x, y: h - 0.15, z, s: randRange(rng, 0.8, 1.5), rot: rng() * 6.28 });
        else if (r < 0.75) placements.grass.push({ x, y: h, z, s: randRange(rng, 0.7, 1.3), rot: rng() * 6.28 });
      } else if (h > 5 && h < 80 && slope < 0.5 && (biome === 'jungle' || biome === 'tropical')) {
        if (r < (biome === 'jungle' ? 0.75 : 0.4)) {
          placements.tree.push({ x, y: h - 0.2, z, s: randRange(rng, 0.9, 1.8), rot: rng() * 6.28 });
        } else if (r < 0.85) placements.grass.push({ x, y: h, z, s: randRange(rng, 0.8, 1.2), rot: rng() * 6.28 });
      } else if (h > 2 && slope > 0.35 && r < 0.3) {
        placements.rock.push({ x, y: h - 0.3, z, s: randRange(rng, 0.6, 2.2), rot: rng() * 6.28 });
      } else if (biome === 'volcanic' && h > 4 && h < 60 && r < 0.12) {
        placements.deadtree.push({ x, y: h - 0.1, z, s: randRange(rng, 0.8, 1.3), rot: rng() * 6.28 });
      } else if (biome === 'rock' && h > 2 && slope < 0.6 && r < 0.2) {
        placements.rock.push({ x, y: h - 0.3, z, s: randRange(rng, 0.8, 2.6), rot: rng() * 6.28 });
      }
    }
  }

  const meshes = [];
  const swayMats = [];

  function instantiate(geo, material, list, { shadow = false, sway = null } = {}) {
    if (list.length === 0) return null;
    if (sway) { addSway(material, sway.amount, sway.height); swayMats.push(material); }
    const im = new THREE.InstancedMesh(geo, material, list.length);
    for (let i = 0; i < list.length; i++) {
      const it = list[i];
      _p.set(it.x, it.y, it.z);
      _q.setFromAxisAngle(_up, it.rot);
      _s.setScalar(it.s);
      _m.compose(_p, _q, _s);
      im.setMatrixAt(i, _m);
    }
    im.castShadow = shadow && shadows;
    im.instanceMatrix.needsUpdate = true;
    im.frustumCulled = false;
    group.add(im);
    meshes.push(im);
    return im;
  }

  // palm: trunk + fronds
  const { trunk: palmTrunkGeo, top } = palmGeometry();
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x8a6a44, roughness: 0.9 });
  instantiate(palmTrunkGeo, trunkMat, placements.palm, { shadow: true });
  const frondGeos = [];
  const fTex = frondTexture();
  for (let i = 0; i < 7; i++) {
    const fg = new THREE.PlaneGeometry(2.6, 1.1);
    fg.translate(1.15, 0, 0);
    fg.rotateZ(-0.55 - (i % 3) * 0.16);
    fg.rotateY((i / 7) * Math.PI * 2);
    fg.translate(top.x, top.y, top.z);
    frondGeos.push(fg);
  }
  const frondMat = new THREE.MeshStandardMaterial({
    map: fTex, alphaTest: 0.35, side: THREE.DoubleSide, roughness: 0.85, color: 0xffffff,
  });
  instantiate(mergeGeoms(frondGeos), frondMat, placements.palm, {
    shadow: true, sway: { amount: 0.22, height: top.y + 1 },
  });

  // canopy tree: trunk + 2 blobs
  const treeParts = [];
  const tTrunk = new THREE.CylinderGeometry(0.16, 0.26, 3.4, 6);
  tTrunk.translate(0, 1.7, 0);
  treeParts.push(tTrunk);
  const blob1 = new THREE.IcosahedronGeometry(1.9, 1);
  blob1.scale(1, 0.75, 1);
  blob1.translate(0, 4.1, 0);
  const blob2 = new THREE.IcosahedronGeometry(1.3, 1);
  blob2.translate(0.9, 3.3, 0.5);
  const treeGeo = mergeGeoms([tTrunk, blob1, blob2]);
  const treeMat = new THREE.MeshStandardMaterial({ roughness: 0.9, vertexColors: false, color: 0x33632e });
  instantiate(treeGeo, treeMat, placements.tree, { shadow: true, sway: { amount: 0.1, height: 5 } });

  // mangrove: root spider + low canopy
  const mangParts = [];
  for (let i = 0; i < 5; i++) {
    const root = new THREE.CylinderGeometry(0.05, 0.07, 1.6, 4);
    root.translate(0, 0.8, 0);
    root.rotateZ(0.5);
    root.rotateY((i / 5) * Math.PI * 2);
    mangParts.push(root);
  }
  const mtr = new THREE.CylinderGeometry(0.12, 0.14, 1.4, 5);
  mtr.translate(0, 1.9, 0);
  mangParts.push(mtr);
  const mblob = new THREE.IcosahedronGeometry(1.2, 1);
  mblob.scale(1.3, 0.6, 1.3);
  mblob.translate(0, 2.9, 0);
  mangParts.push(mblob);
  const mangMat = new THREE.MeshStandardMaterial({ roughness: 0.92, color: 0x415f38 });
  instantiate(mergeGeoms(mangParts), mangMat, placements.mangrove, { shadow: false, sway: { amount: 0.06, height: 3.4 } });

  // grass tufts: crossed quads
  const gTex = grassTexture();
  const gq1 = new THREE.PlaneGeometry(1.1, 0.8); gq1.translate(0, 0.4, 0);
  const gq2 = gq1.clone(); gq2.rotateY(Math.PI / 2);
  const grassGeo = mergeGeoms([gq1, gq2]);
  const grassMat = new THREE.MeshStandardMaterial({
    map: gTex, alphaTest: 0.3, side: THREE.DoubleSide, roughness: 1,
  });
  instantiate(grassGeo, grassMat, placements.grass, { sway: { amount: 0.12, height: 0.9 } });

  // rocks: deformed icosahedra
  const rockGeo = new THREE.IcosahedronGeometry(1, 1);
  {
    const rp = rockGeo.attributes.position;
    const rrng = mulberry32(555);
    for (let i = 0; i < rp.count; i++) {
      rp.setXYZ(i, rp.getX(i) * randRange(rrng, 0.8, 1.2), rp.getY(i) * randRange(rrng, 0.6, 1.1), rp.getZ(i) * randRange(rrng, 0.8, 1.2));
    }
    rockGeo.computeVertexNormals();
  }
  const rockMat = new THREE.MeshStandardMaterial({ color: 0x6b6157, roughness: 0.95 });
  instantiate(rockGeo, rockMat, placements.rock, { shadow: true });

  // dead trees for ash slopes
  const dParts = [];
  const dTrunk = new THREE.CylinderGeometry(0.08, 0.18, 4.4, 5);
  dTrunk.translate(0, 2.2, 0);
  dParts.push(dTrunk);
  for (let i = 0; i < 3; i++) {
    const br = new THREE.CylinderGeometry(0.03, 0.06, 1.6, 4);
    br.translate(0, 0.8, 0);
    br.rotateZ(0.9);
    br.rotateY(i * 2.1);
    br.translate(0, 2.4 + i * 0.7, 0);
    dParts.push(br);
  }
  const deadMat = new THREE.MeshStandardMaterial({ color: 0x3c3733, roughness: 1 });
  instantiate(mergeGeoms(dParts), deadMat, placements.deadtree, { shadow: true });

  return {
    group,
    update(dt) {
      const t = ctx.time.t;
      const windK = Math.min(2, (ctx.weather?.wind.speed ?? 5) / 8);
      for (const mat of swayMats) {
        const sh = mat.userData.shader;
        if (sh) {
          sh.uniforms.uTime.value = t;
          sh.uniforms.uWind.value = windK;
        }
      }
    },
  };
}
