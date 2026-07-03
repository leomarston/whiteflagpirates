// Ports & towns — piers, faction-styled buildings, lanterns, and dockside life.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp01, mulberry32, randRange } from '../core/utils.js';

const STYLES = {
  corsairs: { walls: 0x6e5638, roof: 0x4a4038, trim: 0x8a7a5c, ramshackle: true },
  crown: { walls: 0xd9d2c4, roof: 0x3f5065, trim: 0x8a8578, ramshackle: false },
  concern: { walls: 0x7e3a2a, roof: 0x5c4028, trim: 0xc9a24b, ramshackle: false },
  tidebound: { walls: 0xc9b285, roof: 0xa08c5a, trim: 0x1d6f6d, ramshackle: true },
};

const HOUSES_BY_SIZE = { village: 5, haven: 8, town: 9, capital: 12 };
const PIER_Y = 2.2;

const _v = new THREE.Vector3();

function woodTexture(base = '#6e5638') {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  g.fillStyle = base;
  g.fillRect(0, 0, 128, 128);
  for (let i = 0; i < 10; i++) {
    g.fillStyle = i % 2 ? 'rgba(0,0,0,0.14)' : 'rgba(255,255,255,0.05)';
    g.fillRect(0, i * 13, 128, 2);
    g.fillStyle = 'rgba(0,0,0,0.18)';
    g.fillRect((i * 37) % 128, i * 13, 2, 13);
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

export function buildPorts(ctx, world) {
  const records = [];
  const woodTex = woodTexture();

  for (const isl of world.islands) {
    const def = isl.def;
    if (!def.port) continue;
    records.push(buildPort(ctx, world, isl, woodTex));
  }
  return records;
}

function buildPort(ctx, world, isl, woodTex) {
  const def = isl.def;
  const style = STYLES[def.faction] ?? STYLES.corsairs;
  const rng = mulberry32(def.seed + 7);
  const group = new THREE.Group();
  group.name = `port:${def.port.name}`;
  ctx.scene.add(group);

  const field = world.field;
  const cx = isl.center.x, cz = isl.center.z;

  // ---- find the best dock bearing: shortest land→4m-depth run ----
  let best = null;
  for (let i = 0; i < 24; i++) {
    const ang = (i / 24) * Math.PI * 2;
    const dx = Math.sin(ang), dz = Math.cos(ang);
    let shore = null, deep = null;
    for (let d = isl.radius * 0.2; d < isl.radius * 2.2; d += 6) {
      const h = field.heightAt(cx + dx * d, cz + dz * d);
      if (shore == null && h < 0.6) shore = d;
      if (shore != null && h < -4.5) { deep = d; break; }
    }
    if (shore == null || deep == null) continue;
    const run = deep - shore;
    const flat = field.slopeAt(cx + dx * (shore - 20), cz + dz * (shore - 20));
    const score = run + flat * 120;
    if (!best || score < best.score) best = { ang, dx, dz, shore, deep, score };
  }
  if (!best) best = { ang: 0, dx: 0, dz: 1, shore: isl.radius, deep: isl.radius * 1.3 };

  const { dx, dz } = best;
  const shoreDist = best.shore - 8;                    // pier starts on dry sand
  const pierStart = new THREE.Vector3(cx + dx * shoreDist, PIER_Y, cz + dz * shoreDist);
  const pierEnd = new THREE.Vector3(cx + dx * (best.deep + 10), PIER_Y, cz + dz * (best.deep + 10));
  const pierLen = pierStart.distanceTo(pierEnd);
  const heading = Math.atan2(dx, dz);                  // seaward

  // ---- pier: deck + posts + bollards ----
  const woodMat = new THREE.MeshStandardMaterial({ map: woodTex, roughness: 0.9 });
  const deck = new THREE.Mesh(new THREE.BoxGeometry(4.4, 0.3, pierLen), woodMat);
  deck.position.copy(pierStart).lerp(pierEnd, 0.5);
  deck.rotation.y = heading;
  deck.castShadow = deck.receiveShadow = true;
  group.add(deck);

  const postGeos = [];
  for (let d = 0; d <= pierLen; d += 5) {
    _v.copy(pierStart).lerp(pierEnd, d / pierLen);
    const bottom = field.heightAt(_v.x, _v.z) - 1;
    for (const side of [-1.9, 1.9]) {
      const px = _v.x + Math.cos(heading) * side;
      const pz = _v.z - Math.sin(heading) * side;
      const h = PIER_Y - bottom + 0.6;
      const post = new THREE.CylinderGeometry(0.16, 0.2, h, 6);
      post.translate(px, bottom + h / 2, pz);
      postGeos.push(post);
    }
  }
  // dock-end platform
  const plat = new THREE.BoxGeometry(9, 0.3, 7);
  plat.rotateY(heading);
  plat.translate(pierEnd.x, PIER_Y, pierEnd.z);
  postGeos.push(plat);
  const pierMesh = new THREE.Mesh(mergeGeometries(postGeos), woodMat);
  pierMesh.castShadow = true;
  group.add(pierMesh);

  const walkSurfaces = [
    {
      x: (pierStart.x + pierEnd.x) / 2, z: (pierStart.z + pierEnd.z) / 2,
      hw: 2.2, hd: pierLen / 2 + 1, y: PIER_Y + 0.15, rot: heading,
    },
    { x: pierEnd.x, z: pierEnd.z, hw: 4.5, hd: 3.5, y: PIER_Y + 0.15, rot: heading },
  ];

  // ---- town layout: fan of buildings inland from the pier root ----
  const townCenter = new THREE.Vector3(cx + dx * (shoreDist - 46), 0, cz + dz * (shoreDist - 46));
  townCenter.y = Math.max(field.heightAt(townCenter.x, townCenter.z), 1);

  const kinds = [];
  if (def.port.hasTavern) kinds.push('tavern');
  if (def.port.hasShipwright) kinds.push('shipwright');
  kinds.push('market');
  if (def.port.hasQuests) kinds.push('questboard');
  const houses = HOUSES_BY_SIZE[def.port.size] ?? 6;
  for (let i = 0; i < houses; i++) kinds.push(i === 0 && def.port.size !== 'village' ? 'warehouse' : 'house');
  if (def.faction === 'crown' && def.port.size === 'capital') kinds.push('tower');

  const wallGeos = [], roofGeos = [], trimGeos = [], windowGeos = [], darkGeos = [];
  const buildings = [];
  const placed = [];

  for (const kind of kinds) {
    // find a spot: ring fan around town center, biased inland
    let spot = null;
    for (let tries = 0; tries < 60 && !spot; tries++) {
      const a = randRange(rng, -1.25, 1.25) + heading + Math.PI; // inland side
      const r = kind === 'tower' ? randRange(rng, 40, 60) : randRange(rng, 8, 18 + placed.length * 5);
      const x = townCenter.x + Math.sin(a) * r;
      const z = townCenter.z + Math.cos(a) * r;
      const h = field.heightAt(x, z);
      if (h < 1 || h > 16 || field.slopeAt(x, z) > 0.45) continue;
      if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < 10)) continue;
      spot = { x, z, h };
    }
    if (!spot) continue;
    placed.push(spot);

    const w = kind === 'warehouse' ? randRange(rng, 7, 9) : kind === 'tavern' ? randRange(rng, 6.5, 8) : randRange(rng, 4.5, 6.5);
    const d = w * randRange(rng, 0.8, 1.25);
    const hgt = kind === 'tower' ? 14 : (kind === 'tavern' ? randRange(rng, 4.5, 5.5) : randRange(rng, 3.2, 4.6));
    const rot = style.ramshackle ? randRange(rng, -0.35, 0.35) + heading + Math.PI : heading + Math.PI + Math.round(randRange(rng, -1, 1)) * (Math.PI / 2);
    const y = spot.h;

    if (kind === 'tower') {
      const shaft = new THREE.CylinderGeometry(4.2, 5.2, hgt, 10);
      shaft.translate(spot.x, y + hgt / 2, spot.z);
      wallGeos.push(shaft);
      const ring = new THREE.CylinderGeometry(5.0, 5.0, 1.2, 10);
      ring.translate(spot.x, y + hgt + 0.6, spot.z);
      trimGeos.push(ring);
      for (let i = 0; i < 4; i++) {
        const cannon = new THREE.CylinderGeometry(0.22, 0.28, 2.4, 6);
        cannon.rotateX(Math.PI / 2);
        cannon.rotateY((i / 4) * Math.PI * 2);
        cannon.translate(spot.x + Math.sin((i / 4) * Math.PI * 2) * 4.6, y + hgt + 0.4, spot.z + Math.cos((i / 4) * Math.PI * 2) * 4.6);
        darkGeos.push(cannon);
      }
      buildings.push({ kind, position: new THREE.Vector3(spot.x, y, spot.z) });
      continue;
    }

    // body
    const body = new THREE.BoxGeometry(w, hgt, d);
    body.rotateY(rot);
    body.translate(spot.x, y + hgt / 2, spot.z);
    wallGeos.push(body);

    // roof: gable (rotated slab) or pyramid for variety / thatch cone for tidebound
    if (def.faction === 'tidebound') {
      const roof = new THREE.ConeGeometry(Math.max(w, d) * 0.78, hgt * 0.7, 7);
      roof.rotateY(rot);
      roof.translate(spot.x, y + hgt + hgt * 0.33, spot.z);
      roofGeos.push(roof);
    } else {
      const roof = new THREE.CylinderGeometry(0.01, w * 0.78, hgt * 0.6, 4, 1);
      roof.rotateY(rot + Math.PI / 4);
      roof.scale(1, 1, d / w);
      // CylinderGeometry scale-z after rotate is fine for a stylized pyramid roof
      roof.translate(spot.x, y + hgt + hgt * 0.3, spot.z);
      roofGeos.push(roof);
    }

    // door on the town-facing side
    const doorDir = rot + Math.PI;
    const doorX = spot.x + Math.sin(doorDir) * (d / 2 + 0.02);
    const doorZ = spot.z + Math.cos(doorDir) * (d / 2 + 0.02);
    const door = new THREE.PlaneGeometry(1.1, 2.1);
    door.rotateY(doorDir);
    door.translate(doorX, y + 1.05, doorZ);
    darkGeos.push(door);

    // windows (emissive at night)
    const winCount = 2 + Math.floor(rng() * 3);
    for (let i = 0; i < winCount; i++) {
      const side = rng() < 0.5 ? rot + Math.PI / 2 : rot - Math.PI / 2;
      const off = randRange(rng, -w * 0.3, w * 0.3);
      const wx = spot.x + Math.sin(side) * (w / 2 + 0.02) + Math.sin(rot) * off;
      const wz = spot.z + Math.cos(side) * (w / 2 + 0.02) + Math.cos(rot) * off;
      const win = new THREE.PlaneGeometry(0.7, 0.9);
      win.rotateY(side);
      win.translate(wx, y + hgt * 0.55, wz);
      windowGeos.push(win);
    }

    const doorPosition = new THREE.Vector3(
      doorX + Math.sin(doorDir) * 1.6, y, doorZ + Math.cos(doorDir) * 1.6,
    );
    doorPosition.y = field.heightAt(doorPosition.x, doorPosition.z);
    buildings.push({ kind, position: new THREE.Vector3(spot.x, y, spot.z), doorPosition });

    // extras per kind
    if (kind === 'tavern' || kind === 'shipwright') {
      const sign = new THREE.BoxGeometry(0.9, 0.7, 0.08);
      sign.rotateY(doorDir);
      sign.translate(doorX + Math.sin(doorDir) * 0.4, y + 2.6, doorZ + Math.cos(doorDir) * 0.4);
      trimGeos.push(sign);
    }
    if (kind === 'market') {
      // stall with striped awning next to the market house
      const sx = doorPosition.x + Math.sin(doorDir) * 4;
      const sz = doorPosition.z + Math.cos(doorDir) * 4;
      const sy = field.heightAt(sx, sz);
      const table = new THREE.BoxGeometry(2.6, 0.1, 1.4);
      table.rotateY(rot);
      table.translate(sx, sy + 0.9, sz);
      trimGeos.push(table);
      const awning = new THREE.PlaneGeometry(3, 2);
      awning.rotateX(-0.5);
      awning.rotateY(rot);
      awning.translate(sx, sy + 2.4, sz);
      roofGeos.push(awning);
    }
    if (kind === 'questboard') {
      const post = new THREE.BoxGeometry(0.16, 2.4, 0.16);
      post.translate(doorPosition.x + 1.5, y + 1.2, doorPosition.z);
      trimGeos.push(post);
      const panel = new THREE.BoxGeometry(1.8, 1.2, 0.08);
      panel.rotateY(doorDir);
      panel.translate(doorPosition.x + 1.5, y + 1.7, doorPosition.z);
      darkGeos.push(panel);
    }
  }

  // crates & barrels near the pier root
  for (let i = 0; i < 7; i++) {
    const t = randRange(rng, 0.02, 0.2);
    _v.copy(pierStart).lerp(pierEnd, t);
    const ox = randRange(rng, -3.5, 3.5);
    const crate = rng() < 0.5
      ? new THREE.BoxGeometry(randRange(rng, 0.7, 1.1), 0.8, 0.8)
      : new THREE.CylinderGeometry(0.4, 0.4, 0.85, 8);
    crate.rotateY(rng() * 6.28);
    crate.translate(_v.x + Math.cos(heading) * ox, PIER_Y + 0.55, _v.z - Math.sin(heading) * ox);
    trimGeos.push(crate);
  }

  // lantern posts: pier end + town center
  const lanternSpots = [
    new THREE.Vector3(pierEnd.x, PIER_Y, pierEnd.z),
    new THREE.Vector3(townCenter.x, townCenter.y, townCenter.z),
  ];
  const lampGeos = [];
  for (const sp of lanternSpots) {
    const pole = new THREE.CylinderGeometry(0.07, 0.09, 3.2, 6);
    pole.translate(sp.x, sp.y + 1.6, sp.z);
    trimGeos.push(pole);
    const lamp = new THREE.SphereGeometry(0.22, 8, 8);
    lamp.translate(sp.x, sp.y + 3.1, sp.z);
    lampGeos.push(lamp);
  }

  // ---- merge buckets into few meshes ----
  const mats = {
    walls: new THREE.MeshStandardMaterial({ color: style.walls, roughness: 0.9 }),
    roof: new THREE.MeshStandardMaterial({ color: style.roof, roughness: 0.85, side: THREE.DoubleSide }),
    trim: new THREE.MeshStandardMaterial({ color: style.trim, roughness: 0.85 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x241c12, roughness: 0.95, side: THREE.DoubleSide }),
    window: new THREE.MeshStandardMaterial({
      color: 0x2a2018, emissive: 0xffb45e, emissiveIntensity: 0, side: THREE.DoubleSide,
    }),
    lamp: new THREE.MeshStandardMaterial({
      color: 0xfff2d0, emissive: 0xffb45e, emissiveIntensity: 0.25,
    }),
  };
  const buckets = [
    [wallGeos, mats.walls, true],
    [roofGeos, mats.roof, true],
    [trimGeos, mats.trim, true],
    [darkGeos, mats.dark, false],
    [windowGeos, mats.window, false],
    [lampGeos, mats.lamp, false],
  ];
  for (const [geos, mat, shadow] of buckets) {
    if (!geos.length) continue;
    const mesh = new THREE.Mesh(mergeGeometries(geos.map((g) => (g.index ? g.toNonIndexed() : g))), mat);
    mesh.castShadow = shadow && (ctx.engine?.qualityProfile?.shadows ?? true);
    mesh.receiveShadow = true;
    group.add(mesh);
  }

  // two real lights, faded in at night — warm pools over dock and town
  const pierLight = new THREE.PointLight(0xffb45e, 0, 60, 1.6);
  pierLight.position.set(pierEnd.x, PIER_Y + 3.4, pierEnd.z);
  group.add(pierLight);
  // a mid-pier lantern so the whole walk is lit
  const midPier = pierStart.clone().lerp(pierEnd, 0.5);
  const midLight = new THREE.PointLight(0xffb45e, 0, 44, 1.6);
  midLight.position.set(midPier.x, PIER_Y + 3.4, midPier.z);
  group.add(midLight);
  const townLight = new THREE.PointLight(0xffb45e, 0, 70, 1.6);
  townLight.position.set(townCenter.x, townCenter.y + 3.6, townCenter.z);
  group.add(townLight);

  const dockPosition = new THREE.Vector3(pierEnd.x + dx * 10, 0, pierEnd.z + dz * 10);

  return {
    islandId: def.id,
    name: def.port.name,
    size: def.port.size,
    faction: def.faction,
    flags: def.port,
    position: townCenter.clone(),
    dockPosition,
    dockWalk: new THREE.Vector3(pierEnd.x, PIER_Y + 0.2, pierEnd.z),
    dockHeading: heading,
    group,
    buildings,
    walkSurfaces,
    update(dt) {
      const sunY = ctx.sky?.sunDir.y ?? 1;
      const night = 1 - clamp01((sunY + 0.12) / 0.22);
      mats.window.emissiveIntensity = night * 1.6;
      const flicker = 1 + Math.sin(ctx.time.t * 7.3 + def.seed) * 0.08;
      mats.lamp.emissiveIntensity = 0.25 + night * 2.2 * flicker;
      pierLight.intensity = night * 22 * flicker;
      midLight.intensity = night * 16 * flicker;
      townLight.intensity = night * 26 * flicker;
    },
  };
}
