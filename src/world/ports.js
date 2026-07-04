// Ports & towns — handcrafted-feeling harbours: dressed piers with cleats,
// bollards, rope rails, nets & lanterns; faction-distinct architecture (Crown
// dressed-stone colonial + lighthouse/fort, Corsair ramshackle wreck-haven with
// rope bridges, Concern warehouses + dock crane + manor, Tidebound stilt village);
// market stalls, tavern sign-glow, shipwright slipway, plaza, banners, warm
// windows at night. Everything is merged into a handful of draw calls per port,
// deterministic per island seed, with <=3 real lights each.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { clamp01, mulberry32, randRange } from '../core/utils.js';

// Per-faction look. wallTex/roofType select which shared texture & silhouette a
// faction builds from; colours tint those light, neutral textures.
const STYLES = {
  corsairs: {
    wall: 0x8a6a44, wallTex: 'plank', roof: 0x3d352b, roofType: 'gable',
    trim: 0x6e5638, cloth: 0xd9d1c1, accent: 0x5a6672, flag: 0xe8e4da,
    ramshackle: true, foundation: false, timber: true,
  },
  crown: {
    wall: 0xd0c8b7, wallTex: 'stone', roof: 0x445269, roofType: 'gable',
    trim: 0xeae5d8, cloth: 0x274f86, accent: 0xdfe3ec, flag: 0x1e3a6e,
    ramshackle: false, foundation: true, quoins: true, colonial: true,
  },
  concern: {
    wall: 0x9c4636, wallTex: 'plaster', roof: 0x392c22, roofType: 'gable',
    trim: 0xc9a24b, cloth: 0x7e2a1e, accent: 0xc9a24b, flag: 0x7e2a1e,
    ramshackle: false, foundation: true,
  },
  tidebound: {
    wall: 0xccbb8f, wallTex: 'plank', roof: 0xb39a5f, roofType: 'cone',
    trim: 0x1d6f6d, cloth: 0x1d6f6d, accent: 0xe8dcc0, flag: 0x1d6f6d,
    ramshackle: true, stilt: true, timber: true,
  },
};

const HOUSES_BY_SIZE = { village: 5, haven: 8, town: 9, capital: 12 };
const PIER_Y = 2.2;

// build-time scratch (ports are built once, at world construction)
const _v = new THREE.Vector3();
const _lu = new THREE.Vector3();
const _lv = new THREE.Vector3();
const _lq = new THREE.Quaternion();

// ---------------------------------------------------------------------------
// Procedural textures — one light, neutral set shared by every port so the
// faction colour can tint them. Built once per buildPorts() call.
// ---------------------------------------------------------------------------
function cv(size) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  return c;
}
function finish(c, { srgb = true, aniso = 4, transparent = false } = {}) {
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  tex.anisotropy = aniso;
  if (transparent) tex.premultiplyAlpha = false;
  return tex;
}

function makeTextures() {
  // planks — warm light grain that reads on posts, decks and clapboard walls
  const plank = cv(256); {
    const g = plank.getContext('2d');
    g.fillStyle = '#c6bda4'; g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 8; i++) {
      const y = i * 32;
      g.fillStyle = i % 2 ? 'rgba(0,0,0,0.10)' : 'rgba(255,255,255,0.05)';
      g.fillRect(0, y, 256, 32);
      g.fillStyle = 'rgba(40,28,16,0.55)'; g.fillRect(0, y, 256, 2); // seam
      for (let k = 0; k < 26; k++) { // grain streaks
        g.strokeStyle = `rgba(60,42,24,${0.05 + Math.random() * 0.10})`;
        g.beginPath();
        const yy = y + 4 + Math.random() * 24;
        g.moveTo(0, yy); g.bezierCurveTo(80, yy + (Math.random() - 0.5) * 6, 170, yy + (Math.random() - 0.5) * 6, 256, yy);
        g.stroke();
      }
      // board breaks
      g.fillStyle = 'rgba(30,20,12,0.4)';
      g.fillRect(((i * 97) % 256), y, 2, 32);
    }
  }
  // ashlar stone — dressed colonial blocks
  const stone = cv(256); {
    const g = stone.getContext('2d');
    g.fillStyle = '#cbc4b6'; g.fillRect(0, 0, 256, 256);
    const rows = 8, rh = 256 / rows;
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * 32;
      g.strokeStyle = 'rgba(70,66,58,0.55)'; g.lineWidth = 2;
      g.beginPath(); g.moveTo(0, r * rh); g.lineTo(256, r * rh); g.stroke();
      for (let x = -32; x < 256; x += 64) {
        g.beginPath(); g.moveTo(x + off, r * rh); g.lineTo(x + off, (r + 1) * rh); g.stroke();
        // per-block tint
        const t = 0.5 + Math.random() * 0.5;
        g.fillStyle = `rgba(${180 * t | 0},${172 * t | 0},${156 * t | 0},0.18)`;
        g.fillRect(x + off + 2, r * rh + 2, 60, rh - 4);
      }
    }
  }
  // plaster — near-white render with faint stains (Concern)
  const plaster = cv(128); {
    const g = plaster.getContext('2d');
    g.fillStyle = '#d9d3c6'; g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 60; i++) {
      g.fillStyle = `rgba(${120 + Math.random() * 60 | 0},${110 + Math.random() * 50 | 0},90,0.05)`;
      const r = 4 + Math.random() * 18;
      g.beginPath(); g.arc(Math.random() * 128, Math.random() * 128, r, 0, 6.28); g.fill();
    }
    for (let i = 0; i < 8; i++) { // hairline cracks
      g.strokeStyle = 'rgba(60,50,40,0.12)'; g.beginPath();
      let x = Math.random() * 128, y = Math.random() * 128; g.moveTo(x, y);
      for (let k = 0; k < 5; k++) { x += (Math.random() - 0.5) * 20; y += Math.random() * 12; g.lineTo(x, y); }
      g.stroke();
    }
  }
  // shingle/tile rows
  const tile = cv(256); {
    const g = tile.getContext('2d');
    g.fillStyle = '#b9b3ab'; g.fillRect(0, 0, 256, 256);
    const rows = 10, rh = 256 / rows;
    for (let r = 0; r < rows; r++) {
      const off = (r % 2) * 16;
      g.fillStyle = `rgba(0,0,0,${0.10 + (r % 2) * 0.05})`;
      g.fillRect(0, r * rh, 256, 2);
      for (let x = -16; x < 256; x += 32) {
        g.strokeStyle = 'rgba(0,0,0,0.18)';
        g.beginPath(); g.moveTo(x + off, r * rh); g.lineTo(x + off, (r + 1) * rh); g.stroke();
        g.fillStyle = `rgba(255,255,255,${0.03 + Math.random() * 0.04})`;
        g.fillRect(x + off + 1, r * rh + 1, 30, rh * 0.5);
      }
    }
  }
  // thatch — straw streaks for tidebound cones
  const thatch = cv(128); {
    const g = thatch.getContext('2d');
    g.fillStyle = '#cdba82'; g.fillRect(0, 0, 128, 128);
    for (let i = 0; i < 220; i++) {
      g.strokeStyle = `rgba(${90 + Math.random() * 60 | 0},${70 + Math.random() * 40 | 0},40,${0.15 + Math.random() * 0.2})`;
      const x = Math.random() * 128;
      g.beginPath(); g.moveTo(x, Math.random() * 20); g.lineTo(x + (Math.random() - 0.5) * 6, 128); g.stroke();
    }
  }
  // awning / banner stripes (tonal — tint gives the two-colour cloth)
  const stripe = cv(64); {
    const g = stripe.getContext('2d');
    for (let i = 0; i < 8; i++) {
      g.fillStyle = i % 2 ? '#efe9dc' : '#a89f86';
      g.fillRect(i * 8, 0, 8, 64);
    }
  }
  // fishing net — transparent grid
  const net = cv(128); {
    const g = net.getContext('2d');
    g.clearRect(0, 0, 128, 128);
    g.strokeStyle = 'rgba(70,58,40,0.92)'; g.lineWidth = 2;
    for (let i = -128; i < 128; i += 12) {
      g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 128, 128); g.stroke();
      g.beginPath(); g.moveTo(i + 128, 0); g.lineTo(i, 128); g.stroke();
    }
  }

  return {
    plank: finish(plank), stone: finish(stone), plaster: finish(plaster),
    tile: finish(tile), thatch: finish(thatch), stripe: finish(stripe),
    net: finish(net, { transparent: true }),
  };
}

// ---------------------------------------------------------------------------
// Small geometry helpers (build-time; free to allocate).
// ---------------------------------------------------------------------------
// A flat quad with normals + uv so it merges cleanly with box/cylinder geos.
function quad(p0, p1, p2, p3) {
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array([
    p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z,
    p0.x, p0.y, p0.z, p2.x, p2.y, p2.z, p3.x, p3.y, p3.z,
  ]);
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 0, 1, 1, 0, 1]), 2));
  g.computeVertexNormals();
  return g;
}
function tri(p0, p1, p2) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([
    p0.x, p0.y, p0.z, p1.x, p1.y, p1.z, p2.x, p2.y, p2.z]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0.5, 1]), 2));
  g.computeVertexNormals();
  return g;
}
// A cylinder spanning two world points (beams, ropes, struts, rigging).
function link(ax, ay, az, bx, by, bz, r, seg = 5) {
  const dx = bx - ax, dy = by - ay, dz = bz - az;
  const len = Math.hypot(dx, dy, dz) || 1e-4;
  const g = new THREE.CylinderGeometry(r, r, len, seg);
  g.translate(0, len / 2, 0);
  _lu.set(0, 1, 0); _lv.set(dx / len, dy / len, dz / len);
  _lq.setFromUnitVectors(_lu, _lv);
  g.applyQuaternion(_lq);
  g.translate(ax, ay, az);
  return g;
}
// local(oriented by yaw rot, centred at cx,cz) → fresh world Vector3.
function makeLW(cx, cz, rot) {
  const c = Math.cos(rot), s = Math.sin(rot);
  return (lx, ly, lz) => new THREE.Vector3(cx + lx * c + lz * s, ly, cz - lx * s + lz * c);
}

export function buildPorts(ctx, world) {
  const records = [];
  const tex = makeTextures();
  for (const isl of world.islands) {
    if (!isl.def.port) continue;
    records.push(buildPort(ctx, world, isl, tex));
  }
  return records;
}

function buildPort(ctx, world, isl, tex) {
  const def = isl.def;
  const style = STYLES[def.faction] ?? STYLES.corsairs;
  const faction = def.faction;
  const rng = mulberry32(def.seed + 7);
  const group = new THREE.Group();
  group.name = `port:${def.port.name}`;
  ctx.scene.add(group);

  const field = world.field;
  const cx = isl.center.x, cz = isl.center.z;

  // ---- find the best dock bearing: shortest land→4m-depth run, flat backshore ----
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
  const heading = Math.atan2(dx, dz);                 // seaward
  const perpX = Math.cos(heading), perpZ = -Math.sin(heading); // lateral unit
  const shoreDist = best.shore - 8;                   // pier starts on dry sand
  const pierStart = new THREE.Vector3(cx + dx * shoreDist, PIER_Y, cz + dz * shoreDist);
  const pierEnd = new THREE.Vector3(cx + dx * (best.deep + 10), PIER_Y, cz + dz * (best.deep + 10));
  const pierLen = pierStart.distanceTo(pierEnd);

  // ---- material buckets: each becomes exactly one merged mesh ----
  const B = {
    wall: [], roof: [], wood: [], stone: [], trim: [], dark: [],
    cloth: [], rope: [], metal: [], net: [], window: [], lamp: [],
  };
  const wallMap = { plank: tex.plank, stone: tex.stone, plaster: tex.plaster }[style.wallTex] ?? tex.plank;
  const roofMap = style.roofType === 'cone' ? tex.thatch : tex.tile;
  const M = {
    wall: new THREE.MeshStandardMaterial({ map: wallMap, color: style.wall, roughness: 0.92 }),
    roof: new THREE.MeshStandardMaterial({ map: roofMap, color: style.roof, roughness: 0.88, side: THREE.DoubleSide }),
    wood: new THREE.MeshStandardMaterial({ map: tex.plank, color: 0x7c5c3a, roughness: 0.92 }),
    stone: new THREE.MeshStandardMaterial({ map: tex.stone, color: 0x9c968a, roughness: 0.97 }),
    trim: new THREE.MeshStandardMaterial({ color: style.trim, roughness: 0.8 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x241c12, roughness: 0.95, side: THREE.DoubleSide }),
    cloth: new THREE.MeshStandardMaterial({ map: tex.stripe, color: style.cloth, roughness: 0.85, side: THREE.DoubleSide }),
    rope: new THREE.MeshStandardMaterial({ color: 0xb9a276, roughness: 1 }),
    metal: new THREE.MeshStandardMaterial({ color: 0x2b2c30, roughness: 0.5, metalness: 0.6 }),
    net: new THREE.MeshStandardMaterial({ map: tex.net, color: 0x6a5a3e, roughness: 1, transparent: true, alphaTest: 0.4, side: THREE.DoubleSide }),
    window: new THREE.MeshStandardMaterial({ color: 0x2a2018, emissive: 0xffb45e, emissiveIntensity: 0, side: THREE.DoubleSide }),
    lamp: new THREE.MeshStandardMaterial({ color: 0xfff2d0, emissive: 0xffb45e, emissiveIntensity: 0.25 }),
  };

  // ---------------------------------------------------------------------
  // PIER — deck, posts, rope rails, bollards, cleats, coils, nets, cargo.
  // ---------------------------------------------------------------------
  const deckMidX = (pierStart.x + pierEnd.x) / 2, deckMidZ = (pierStart.z + pierEnd.z) / 2;
  const deck = new THREE.BoxGeometry(4.4, 0.3, pierLen);
  deck.rotateY(heading); deck.translate(deckMidX, PIER_Y, deckMidZ);
  B.wood.push(deck);

  // support posts down to the seabed
  for (let d = 0; d <= pierLen; d += 5) {
    _v.copy(pierStart).lerp(pierEnd, d / pierLen);
    const bottom = field.heightAt(_v.x, _v.z) - 1;
    for (const side of [-1.9, 1.9]) {
      const px = _v.x + perpX * side, pz = _v.z + perpZ * side;
      const h = PIER_Y - bottom + 0.6;
      const post = new THREE.CylinderGeometry(0.16, 0.2, h, 6);
      post.translate(px, bottom + h / 2, pz);
      B.wood.push(post);
    }
  }
  // dock-end apron
  const plat = new THREE.BoxGeometry(9, 0.32, 7);
  plat.rotateY(heading); plat.translate(pierEnd.x, PIER_Y, pierEnd.z);
  B.wood.push(plat);

  // rope hand-rails: short posts every 4m linked by a sagging rope
  for (const side of [-2.15, 2.15]) {
    let prev = null;
    for (let d = 2; d <= pierLen - 1; d += 4) {
      _v.copy(pierStart).lerp(pierEnd, d / pierLen);
      const px = _v.x + perpX * side, pz = _v.z + perpZ * side;
      const post = new THREE.CylinderGeometry(0.08, 0.1, 1.05, 5);
      post.translate(px, PIER_Y + 0.55, pz);
      B.wood.push(post);
      const topY = PIER_Y + 1.0;
      if (prev) {
        const midX = (prev.x + px) / 2, midZ = (prev.z + pz) / 2;
        B.rope.push(link(prev.x, topY, prev.z, midX, topY - 0.16, midZ, 0.03));
        B.rope.push(link(midX, topY - 0.16, midZ, px, topY, pz, 0.03));
      }
      prev = { x: px, z: pz };
    }
  }

  // bollards at the apron corners + mid-pier, with mooring ropes trailing to water
  const bollardSpots = [
    { x: pierEnd.x + perpX * 3.6, z: pierEnd.z + perpZ * 3.6 },
    { x: pierEnd.x - perpX * 3.6, z: pierEnd.z - perpZ * 3.6 },
    { x: deckMidX + perpX * 2.1, z: deckMidZ + perpZ * 2.1 },
  ];
  for (const bs of bollardSpots) {
    const b = new THREE.CylinderGeometry(0.24, 0.28, 1.15, 8);
    b.translate(bs.x, PIER_Y + 0.55, bs.z); B.wood.push(b);
    const cap = new THREE.SphereGeometry(0.26, 8, 6);
    cap.translate(bs.x, PIER_Y + 1.12, bs.z); B.wood.push(cap);
    // slack mooring rope draping toward the water
    const ex = bs.x + dx * 2.4, ez = bs.z + dz * 2.4;
    const ey = PIER_Y - 1.6;
    B.rope.push(link(bs.x, PIER_Y + 0.9, bs.z, (bs.x + ex) / 2, PIER_Y - 0.3, (bs.z + ez) / 2, 0.04));
    B.rope.push(link((bs.x + ex) / 2, PIER_Y - 0.3, (bs.z + ez) / 2, ex, ey, ez, 0.04));
  }
  // iron cleats + coiled rope on the apron deck
  for (let i = 0; i < 3; i++) {
    const t = 0.3 + i * 0.25;
    const lx = randRange(rng, -3, 3);
    const px = pierEnd.x + perpX * lx, pz = pierEnd.z + perpZ * lx;
    const cleat = new THREE.CylinderGeometry(0.06, 0.06, 0.5, 5);
    cleat.rotateZ(Math.PI / 2); cleat.rotateY(heading);
    cleat.translate(px, PIER_Y + 0.28, pz); B.metal.push(cleat);
    if (i < 2) {
      const coil = new THREE.TorusGeometry(0.32, 0.07, 5, 10);
      coil.rotateX(Math.PI / 2);
      coil.translate(px + perpX * 0.9, PIER_Y + 0.24, pz + perpZ * 0.9); B.rope.push(coil);
    }
  }

  // stacked barrels & crates at the pier root
  const rootX = pierStart.x + dx * 3, rootZ = pierStart.z + dz * 3;
  for (let i = 0; i < 9; i++) {
    const t = randRange(rng, 0.02, 0.22);
    _v.copy(pierStart).lerp(pierEnd, t);
    const lx = randRange(rng, -3.4, 3.4);
    const bx = _v.x + perpX * lx, bz = _v.z + perpZ * lx;
    if (rng() < 0.5) addBarrel(B, bx, PIER_Y + 0.45, bz, rng() * 6.28);
    else addCrate(B, bx, PIER_Y + 0.4, bz, randRange(rng, 0.7, 1.1), rng() * 6.28);
  }
  // a drying-net rack beside the cargo
  addNetRack(B, rootX + perpX * 3.2, PIER_Y, rootZ + perpZ * 3.2, heading);

  // pier-end lanterns (emissive; lit by one real light)
  for (const side of [-3.4, 3.4]) {
    const lx = pierEnd.x + perpX * side, lz = pierEnd.z + perpZ * side;
    addLantern(B, lx, PIER_Y, lz);
  }

  const walkSurfaces = [
    { x: deckMidX, z: deckMidZ, hw: 2.2, hd: pierLen / 2 + 1, y: PIER_Y + 0.15, rot: heading },
    { x: pierEnd.x, z: pierEnd.z, hw: 4.5, hd: 3.5, y: PIER_Y + 0.16, rot: heading },
  ];

  // ---------------------------------------------------------------------
  // TOWN — a plaza inland from the pier root, buildings fanned around it.
  // ---------------------------------------------------------------------
  const townCenter = new THREE.Vector3(cx + dx * (shoreDist - 46), 0, cz + dz * (shoreDist - 46));
  townCenter.y = Math.max(field.heightAt(townCenter.x, townCenter.z), 1);

  const flags = def.port;
  const kinds = [];
  if (flags.hasTavern) kinds.push('tavern');
  if (flags.hasShipwright) kinds.push('shipwright');
  kinds.push('market');
  if (flags.hasQuests) kinds.push('questboard');
  const houses = HOUSES_BY_SIZE[def.port.size] ?? 6;
  for (let i = 0; i < houses; i++) {
    let k = 'house';
    if (i === 0 && def.port.size !== 'village') k = faction === 'concern' ? 'manor' : 'warehouse';
    else if (i === 1 && faction === 'concern' && def.port.size !== 'village') k = 'warehouse';
    kinds.push(k);
  }
  if (faction === 'crown' && (def.port.size === 'capital' || def.port.size === 'town')) kinds.push('tower');

  const buildings = [];
  const placed = [];
  const minH = style.stilt ? 0.2 : 1;

  for (const kind of kinds) {
    const dims = buildingDims(kind, faction, rng);
    // find a spot on the inland fan
    let spot = null;
    for (let tries = 0; tries < 70 && !spot; tries++) {
      const a = randRange(rng, -1.3, 1.3) + heading + Math.PI;
      const r = kind === 'tower' ? randRange(rng, 44, 64) : randRange(rng, 9, 20 + placed.length * 4);
      const x = townCenter.x + Math.sin(a) * r;
      const z = townCenter.z + Math.cos(a) * r;
      const h = field.heightAt(x, z);
      if (h < minH || h > 17 || field.slopeAt(x, z) > 0.5) continue;
      const foot = Math.max(dims.w, dims.d) * 0.5 + 4;
      if (placed.some((p) => Math.hypot(p.x - x, p.z - z) < p.r + foot)) continue;
      spot = { x, z, h, r: foot };
    }
    if (!spot) continue;
    placed.push(spot);

    if (kind === 'tower') {
      addTower(B, style, spot, rng);
      buildings.push({ kind, position: new THREE.Vector3(spot.x, spot.h, spot.z) });
      continue;
    }

    // face the plaza (local +Z toward town), with ramshackle jitter
    const toX = townCenter.x - spot.x, toZ = townCenter.z - spot.z;
    // buildings face the plaza (local +Z toward town), with a little jitter
    let rot = Math.atan2(toX, toZ);
    rot += randRange(rng, -1, 1) * (style.ramshackle ? 0.35 : 0.12);

    const doorPosition = addBuilding(B, style, faction, kind, spot, dims, rot, rng, field, {
      heading, dx, dz, perpX, perpZ,
    });
    buildings.push({ kind, position: new THREE.Vector3(spot.x, spot.h, spot.z), doorPosition });
  }

  // ---------------------------------------------------------------------
  // PLAZA — cobbles, a banner-pole centrepiece, ringed by street lanterns.
  // ---------------------------------------------------------------------
  {
    const py = townCenter.y;
    const cob = new THREE.CylinderGeometry(11, 11, 0.24, 24);
    cob.translate(townCenter.x, py + 0.02, townCenter.z); B.stone.push(cob);
    const rim = new THREE.TorusGeometry(11, 0.22, 6, 28);
    rim.rotateX(Math.PI / 2); rim.translate(townCenter.x, py + 0.14, townCenter.z); B.wood.push(rim);
    // centrepiece: stone plinth + tall banner pole + hanging banner + top lantern
    const plinth = new THREE.CylinderGeometry(1.3, 1.6, 0.9, 10);
    plinth.translate(townCenter.x, py + 0.45, townCenter.z); B.stone.push(plinth);
    const pole = new THREE.CylinderGeometry(0.14, 0.18, 8.5, 8);
    pole.translate(townCenter.x, py + 0.9 + 4.25, townCenter.z); B.wood.push(pole);
    addBanner(B, style, townCenter.x + 0.3, py + 8.4, townCenter.z, 1.4, 3.4, heading);
    addLampGlass(B, townCenter.x, py + 9.5, townCenter.z, 0.3);
    // ring of street lanterns
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2 + 0.3;
      const lx = townCenter.x + Math.cos(a) * 9.5, lz = townCenter.z + Math.sin(a) * 9.5;
      const ly = field.heightAt(lx, lz);
      if (ly > 0.4) addLanternPost(B, lx, ly, lz);
    }
  }
  // lanterns lining the walk from the pier to the plaza
  {
    const from = new THREE.Vector3(pierStart.x, 0, pierStart.z);
    const steps = Math.max(2, Math.floor(pierStart.distanceTo(townCenter) / 15));
    for (let i = 1; i <= steps; i++) {
      _v.copy(from).lerp(townCenter, i / (steps + 1));
      const side = (i % 2 ? 1 : -1) * 3.2;
      const lx = _v.x + perpX * side, lz = _v.z + perpZ * side;
      const ly = field.heightAt(lx, lz);
      if (ly > 0.4) addLanternPost(B, lx, ly, lz);
    }
  }

  // ---------------------------------------------------------------------
  // FACTION LANDMARKS — the signature silhouette of each port.
  // ---------------------------------------------------------------------
  if (faction === 'crown') {
    addLighthouse(B, style, field, pierStart.x + perpX * 16 + dx * 2, pierStart.z + perpZ * 16 + dz * 2);
  } else if (faction === 'concern') {
    addCrane(B, pierEnd.x + perpX * 5.5, PIER_Y, pierEnd.z + perpZ * 5.5, heading, dx, dz);
  } else if (faction === 'corsairs') {
    addWreckHouse(B, style, field, rng, pierStart.x - perpX * 22, pierStart.z - perpZ * 22, heading, dx, dz, townCenter);
  } else if (faction === 'tidebound') {
    addStarTower(B, style, field, townCenter.x + perpX * 20, townCenter.z + perpZ * 20);
  }

  // ---------------------------------------------------------------------
  // MERGE — each non-empty bucket → one mesh.
  // ---------------------------------------------------------------------
  const shadowKind = { wall: 1, roof: 1, wood: 1, stone: 1, trim: 1, metal: 1 };
  const shadowsOn = ctx.engine?.qualityProfile?.shadows ?? true;
  for (const key of Object.keys(B)) {
    const geos = B[key];
    if (!geos.length) continue;
    const merged = mergeGeometries(geos.map((g) => (g.index ? g.toNonIndexed() : g)));
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, M[key]);
    mesh.castShadow = !!shadowKind[key] && shadowsOn;
    mesh.receiveShadow = key !== 'window' && key !== 'lamp';
    mesh.matrixAutoUpdate = false; mesh.updateMatrix();
    group.add(mesh);
  }

  // ---------------------------------------------------------------------
  // LIGHTS — exactly three warm pools, faded in at night.
  // ---------------------------------------------------------------------
  const pierLight = new THREE.PointLight(0xffb45e, 0, 62, 1.6);
  pierLight.position.set(pierEnd.x, PIER_Y + 3.6, pierEnd.z); group.add(pierLight);
  const rootLight = new THREE.PointLight(0xffb45e, 0, 48, 1.6);
  rootLight.position.set(pierStart.x, PIER_Y + 3.4, pierStart.z); group.add(rootLight);
  const plazaLight = new THREE.PointLight(0xffb45e, 0, 74, 1.6);
  plazaLight.position.set(townCenter.x, townCenter.y + 4.2, townCenter.z); group.add(plazaLight);

  const dockPosition = new THREE.Vector3(pierEnd.x + dx * 10, 0, pierEnd.z + dz * 10);
  const seedPhase = def.seed * 0.017;

  return {
    islandId: def.id,
    name: def.port.name,
    size: def.port.size,
    faction,
    flags,
    position: townCenter.clone(),
    dockPosition,
    dockWalk: new THREE.Vector3(pierEnd.x, PIER_Y + 0.2, pierEnd.z),
    dockHeading: heading,
    group,
    buildings,
    walkSurfaces,
    update(dt) {
      const t = ctx.time.t;
      const sunY = ctx.sky?.sunDir?.y ?? Math.sin((ctx.time.dayFrac - 0.25) * Math.PI * 2);
      const night = 1 - clamp01((sunY + 0.12) / 0.22);
      const flick = 1 + Math.sin(t * 7.3 + seedPhase) * 0.07 + Math.sin(t * 2.1 + seedPhase * 3) * 0.04;
      M.window.emissiveIntensity = night * (1.5 + Math.sin(t * 3.1 + seedPhase) * 0.12);
      M.lamp.emissiveIntensity = 0.22 + night * 2.4 * flick;
      pierLight.intensity = night * 22 * flick;
      rootLight.intensity = night * 15 * flick;
      plazaLight.intensity = night * 26 * flick;
    },
  };
}

// ---------------------------------------------------------------------------
// Building sizing per kind.
// ---------------------------------------------------------------------------
function buildingDims(kind, faction, rng) {
  switch (kind) {
    case 'warehouse': return { w: randRange(rng, 8.5, 11), d: randRange(rng, 6.5, 9), h: randRange(rng, 5, 6.5) };
    case 'manor': return { w: randRange(rng, 8.5, 10.5), d: randRange(rng, 7, 9), h: randRange(rng, 6.8, 7.8) };
    case 'tavern': return { w: randRange(rng, 6.5, 8), d: randRange(rng, 6, 7.5), h: randRange(rng, 4.6, 5.6) };
    case 'shipwright': return { w: randRange(rng, 6.5, 8), d: randRange(rng, 5.5, 7), h: randRange(rng, 4.6, 5.4) };
    case 'market': return { w: randRange(rng, 5, 6.5), d: randRange(rng, 4.5, 6), h: randRange(rng, 3.6, 4.4) };
    case 'questboard': return { w: randRange(rng, 4.5, 5.5), d: randRange(rng, 4.2, 5), h: randRange(rng, 3.4, 4.2) };
    default: return { w: randRange(rng, 4.5, 6.5), d: randRange(rng, 4.2, 6), h: randRange(rng, 3.2, 4.6) };
  }
}

// ---------------------------------------------------------------------------
// A full building: body, roof, door, windows, faction detailing, plus per-kind
// dressing (tavern sign, shipwright slipway, market stalls, ...). Returns the
// door approach position (where NPCs stand / players spawn).
// ---------------------------------------------------------------------------
function addBuilding(B, style, faction, kind, spot, dims, rot, rng, field, geo) {
  const { w, d, h } = dims;
  const yBase = spot.h;
  const lift = style.stilt ? 1.45 : 0;
  const floorY = yBase + lift;
  const LW = makeLW(spot.x, spot.z, rot);

  // ---- stilts: posts + underfloor + entry ramp ----
  if (lift > 0) {
    for (const sx of [-w / 2 + 0.5, w / 2 - 0.5]) {
      for (const sz of [-d / 2 + 0.5, d / 2 - 0.5]) {
        const p = LW(sx, 0, sz);
        const under = field.heightAt(p.x, p.z);
        const post = new THREE.CylinderGeometry(0.18, 0.22, floorY - under + 0.6, 6);
        post.translate(p.x, (floorY + under) / 2, p.z); B.wood.push(post);
      }
    }
    const floor = new THREE.BoxGeometry(w, 0.3, d);
    floor.rotateY(rot); floor.translate(spot.x, floorY - 0.15, spot.z); B.wood.push(floor);
    // ramp from ground up to the door side (+Z)
    const rTop = LW(0, floorY, d / 2 + 0.2), rBot = LW(0, yBase, d / 2 + 2.6);
    B.wood.push(link(rBot.x, rBot.y, rBot.z, rTop.x, rTop.y, rTop.z, 0.5, 4));
  } else if (style.foundation) {
    const f = new THREE.BoxGeometry(w + 0.6, 0.7, d + 0.6);
    f.rotateY(rot); f.translate(spot.x, yBase + 0.35, spot.z); B.stone.push(f);
  }

  // ---- body ----
  const body = new THREE.BoxGeometry(w, h, d);
  body.rotateY(rot); body.translate(spot.x, floorY + h / 2, spot.z); B.wall.push(body);
  const wallTop = floorY + h;

  // ---- roof ----
  addRoof(B, style, spot, w, d, wallTop, rot);

  // ---- half-timber frame (corsair / tidebound) ----
  if (style.timber) {
    for (const lx of [-w / 2 + 0.12, w / 2 - 0.12]) {
      const a = LW(lx, floorY, d / 2), b = LW(lx, wallTop, d / 2);
      B.dark.push(link(a.x, a.y, a.z, b.x, b.y, b.z, 0.09, 4));
    }
    const mA = LW(-w / 2, floorY + h * 0.55, d / 2 + 0.02), mB = LW(w / 2, floorY + h * 0.55, d / 2 + 0.02);
    B.dark.push(link(mA.x, mA.y, mA.z, mB.x, mB.y, mB.z, 0.08, 4));
    if (style.ramshackle) { // a leaning outrigger strut
      const s0 = LW(w / 2, floorY, d / 2 + 0.1), s1 = LW(w / 2 + 1.1, floorY + h * 0.4, d / 2 + 0.1);
      B.wood.push(link(s0.x, s0.y, s0.z, s1.x, s1.y, s1.z, 0.11, 5));
    }
  }

  // ---- quoins (crown corner stones) ----
  if (style.quoins) {
    for (const cxl of [-w / 2, w / 2]) {
      for (const czl of [-d / 2, d / 2]) {
        for (let q = 0; q < 4; q++) {
          const p = LW(cxl, floorY + 0.5 + q * 0.9, czl);
          const qg = new THREE.BoxGeometry(0.7, 0.55, 0.7);
          qg.rotateY(rot); qg.translate(p.x, p.y, p.z); B.trim.push(qg);
        }
      }
    }
  }

  // ---- chimney (crown / concern) ----
  if (style.foundation && kind !== 'market') {
    const cp = LW(w * 0.28, 0, -d * 0.2);
    const ch = new THREE.BoxGeometry(0.9, h * 0.9 + 1.4, 0.9);
    ch.rotateY(rot); ch.translate(cp.x, wallTop + (h * 0.9 + 1.4) / 2 - 0.6, cp.z); B.stone.push(ch);
  }

  // ---- door (town-facing +Z) + warm interior glow ----
  const doorP = LW(0, floorY, d / 2 + 0.02);
  const door = new THREE.PlaneGeometry(1.15, 2.15);
  door.rotateY(rot); door.translate(doorP.x, floorY + 1.07, doorP.z); B.dark.push(door);
  const frame = new THREE.BoxGeometry(1.5, 2.5, 0.14);
  frame.rotateY(rot); frame.translate(doorP.x, floorY + 1.25, doorP.z); B.trim.push(frame);
  const glow = new THREE.PlaneGeometry(0.95, 1.8);
  glow.rotateY(rot); glow.translate(doorP.x + Math.sin(rot) * 0.05, floorY + 1.0, doorP.z + Math.cos(rot) * 0.05); B.window.push(glow);

  // ---- windows (both long sides, framed if colonial) ----
  const stories = h > 6 ? 2 : 1;
  for (const sSign of [1, -1]) {
    const winN = Math.max(2, Math.round(w / 2.6));
    for (let i = 0; i < winN; i++) {
      for (let s = 0; s < stories; s++) {
        const off = (i / (winN - 1 || 1) - 0.5) * (w - 1.6);
        const wy = floorY + (stories === 2 ? (s === 0 ? h * 0.32 : h * 0.72) : h * 0.55);
        const p = LW(off, wy, sSign * (d / 2 + 0.03));
        const win = new THREE.PlaneGeometry(0.72, 0.95);
        win.rotateY(rot + (sSign > 0 ? 0 : Math.PI));
        win.translate(p.x, p.y, p.z); B.window.push(win);
        if (style.foundation || style.colonial) {
          const wf = new THREE.BoxGeometry(0.95, 1.2, 0.1);
          wf.rotateY(rot); wf.translate(p.x, p.y, p.z); B.trim.push(wf);
        }
      }
    }
  }

  // door approach point on the ground in front
  const approach = LW(0, yBase, d / 2 + 1.7);
  const doorPosition = new THREE.Vector3(approach.x, field.heightAt(approach.x, approach.z), approach.z);

  // ---- per-kind dressing ----
  if (kind === 'tavern') addTavernSign(B, style, LW, floorY, w, d, h, rot);
  else if (kind === 'shipwright') addSlipway(B, field, spot, geo, rng);
  else if (kind === 'market') addMarketStalls(B, style, LW, spot, d, rot, rng, field);
  else if (kind === 'questboard') addQuestBoard(B, LW, floorY, d, rot);
  else if (kind === 'warehouse') addWarehouseDoors(B, style, LW, floorY, w, d, rot);
  else if (kind === 'manor') addPortico(B, style, LW, floorY, w, d, rot);

  // a hanging banner on the plaza-facing wall of prominent buildings
  if (kind === 'tavern' || kind === 'manor' || kind === 'warehouse') {
    const bp = LW(w * 0.32, wallTop - 0.2, d / 2 + 0.06);
    addBanner(B, style, bp.x, bp.y, bp.z, 0.9, 2.4, rot);
  }

  return doorPosition;
}

function addRoof(B, style, spot, w, d, wallTop, rot) {
  const LW = makeLW(spot.x, spot.z, rot);
  if (style.roofType === 'cone') {
    const r = Math.max(w, d) * 0.72;
    const rise = Math.max(w, d) * 0.55;
    const cone = new THREE.ConeGeometry(r, rise, 8);
    cone.translate(spot.x, wallTop + rise / 2 - 0.1, spot.z); B.roof.push(cone);
    // ridge cap ring + finial
    const ring = new THREE.TorusGeometry(0.5, 0.12, 5, 8);
    ring.rotateX(Math.PI / 2); ring.translate(spot.x, wallTop + rise - 0.2, spot.z); B.wood.push(ring);
    return;
  }
  // gable
  const ov = 0.45, goX = 0.3, rise = Math.min(w, d) * 0.5 + 0.4;
  const eaveY = wallTop, apexY = wallTop + rise;
  // +Z slab
  B.roof.push(quad(
    LW(-(w / 2 + goX), eaveY, d / 2 + ov), LW(w / 2 + goX, eaveY, d / 2 + ov),
    LW(w / 2 + goX, apexY, 0), LW(-(w / 2 + goX), apexY, 0)));
  // -Z slab
  B.roof.push(quad(
    LW(w / 2 + goX, eaveY, -(d / 2 + ov)), LW(-(w / 2 + goX), eaveY, -(d / 2 + ov)),
    LW(-(w / 2 + goX), apexY, 0), LW(w / 2 + goX, apexY, 0)));
  // gable-end infill (wall colour)
  B.wall.push(tri(LW(w / 2, eaveY, d / 2), LW(w / 2, eaveY, -d / 2), LW(w / 2, apexY, 0)));
  B.wall.push(tri(LW(-w / 2, eaveY, -d / 2), LW(-w / 2, eaveY, d / 2), LW(-w / 2, apexY, 0)));
  // ridge beam
  const ra = LW(-(w / 2 + goX), apexY, 0), rb = LW(w / 2 + goX, apexY, 0);
  B.wood.push(link(ra.x, ra.y, ra.z, rb.x, rb.y, rb.z, 0.1, 5));
}

// ---------------------------------------------------------------------------
// Reusable set-dressing pieces.
// ---------------------------------------------------------------------------
function addBarrel(B, x, y, z, rot) {
  const body = new THREE.CylinderGeometry(0.42, 0.42, 0.9, 10);
  body.translate(x, y, z); B.wood.push(body);
  for (const oy of [-0.28, 0.28]) {
    const hoop = new THREE.TorusGeometry(0.43, 0.05, 5, 10);
    hoop.rotateX(Math.PI / 2); hoop.translate(x, y + oy, z); B.metal.push(hoop);
  }
}
function addCrate(B, x, y, z, s, rot) {
  const box = new THREE.BoxGeometry(s, s, s);
  box.rotateY(rot); box.translate(x, y + s / 2, z); B.wood.push(box);
  const rim = new THREE.BoxGeometry(s * 1.02, s * 0.12, s * 1.02);
  rim.rotateY(rot); rim.translate(x, y + s * 0.5, z); B.trim.push(rim);
}
function addNetRack(B, x, y, z, heading) {
  const s = Math.sin(heading), c = Math.cos(heading);
  for (const side of [-1.3, 1.3]) {
    const px = x + c * side, pz = z - s * side;
    const pole = new THREE.CylinderGeometry(0.08, 0.1, 2.4, 5);
    pole.rotateZ(side > 0 ? 0.25 : -0.25);
    pole.translate(px, y + 1.1, pz); B.wood.push(pole);
  }
  const bar = new THREE.CylinderGeometry(0.07, 0.07, 2.8, 5);
  bar.rotateZ(Math.PI / 2); bar.rotateY(heading); bar.translate(x, y + 2.1, z); B.wood.push(bar);
  // draped net
  const LW = makeLW(x, z, heading);
  B.net.push(quad(LW(-1.3, y + 2.1, 0.1), LW(1.3, y + 2.1, 0.1), LW(1.3, y + 0.3, 0.9), LW(-1.3, y + 0.3, 0.9)));
}
function addLantern(B, x, y, z) {
  const pole = new THREE.CylinderGeometry(0.08, 0.1, 3.2, 6);
  pole.translate(x, y + 1.6, z); B.wood.push(pole);
  const arm = new THREE.CylinderGeometry(0.05, 0.05, 0.6, 5);
  arm.rotateZ(Math.PI / 2); arm.translate(x + 0.25, y + 3.1, z); B.metal.push(arm);
  addLampGlass(B, x + 0.5, y + 3.0, z, 0.22);
}
function addLanternPost(B, x, y, z) {
  const pole = new THREE.CylinderGeometry(0.08, 0.11, 3.0, 6);
  pole.translate(x, y + 1.5, z); B.wood.push(pole);
  const cap = new THREE.ConeGeometry(0.3, 0.35, 6);
  cap.translate(x, y + 3.35, z); B.metal.push(cap);
  addLampGlass(B, x, y + 3.0, z, 0.2);
}
function addLampGlass(B, x, y, z, r) {
  const glass = new THREE.SphereGeometry(r, 8, 8);
  glass.translate(x, y, z); B.lamp.push(glass);
}
function addBanner(B, style, x, y, z, w, h, rot) {
  const LW = makeLW(x, z, rot);
  // hang the cloth slightly billowed by staggering the lower edge
  B.cloth.push(quad(
    LW(-w / 2, y, 0), LW(w / 2, y, 0),
    LW(w / 2, y - h, 0.12), LW(-w / 2, y - h, -0.12)));
  // triangular pennant tail
  B.cloth.push(tri(LW(-w / 2, y - h, -0.12), LW(w / 2, y - h, 0.12), LW(0, y - h - 0.7, 0)));
}

function addTavernSign(B, style, LW, floorY, w, d, h, rot) {
  // bracket off the wall beside the door + hanging board on chains + door lantern
  const y = floorY + h - 0.6;
  const armMid = LW(w * 0.42, y, d / 2 + 0.5);
  const arm = new THREE.BoxGeometry(0.12, 0.12, 1.0);
  arm.rotateY(rot); arm.translate(armMid.x, y, armMid.z); B.wood.push(arm);
  const hang = LW(w * 0.42, y - 0.8, d / 2 + 0.95);
  const board = new THREE.BoxGeometry(0.95, 0.75, 0.08);
  board.rotateY(rot); board.translate(hang.x, hang.y, hang.z); B.trim.push(board);
  for (const o of [-0.35, 0.35]) {
    const a = LW(w * 0.42 + o, y, d / 2 + 0.95);
    const b = LW(w * 0.42 + o, y - 0.45, d / 2 + 0.95);
    B.metal.push(link(a.x, a.y, a.z, b.x, b.y, b.z, 0.02, 4));
  }
  // door lantern (emissive) + warm entrance glow
  const lp = LW(-w * 0.42, floorY, d / 2 + 0.3);
  addLampGlass(B, lp.x, floorY + 2.2, lp.z, 0.22);
  const bracket = new THREE.CylinderGeometry(0.04, 0.04, 0.5, 5);
  bracket.rotateZ(Math.PI / 2); bracket.rotateY(rot); bracket.translate(lp.x, floorY + 2.3, lp.z); B.metal.push(bracket);
}

function addSlipway(B, field, spot, geo, rng) {
  // a timber ramp running to the water on the seaward side, with a hull in frame
  const { dx, dz, perpX, perpZ } = geo;
  const sx = spot.x + dx * 6 + perpX * 4, sz = spot.z + dz * 6 + perpZ * 4;
  const heading = Math.atan2(dx, dz);
  // sleepers stepping down into the sea
  for (let i = 0; i < 8; i++) {
    const t = i / 7;
    const px = sx + dx * (i * 2.2), pz = sz + dz * (i * 2.2);
    const gy = field.heightAt(px, pz);
    const y = Math.max(gy, -1.2) + 0.25;
    const sleeper = new THREE.BoxGeometry(3.2, 0.3, 0.5);
    sleeper.rotateY(heading); sleeper.translate(px, y, pz); B.wood.push(sleeper);
  }
  // keel + ribs of a ship under construction over the ramp
  const kx = sx + dx * 5, kz = sz + dz * 5;
  const ky = Math.max(field.heightAt(kx, kz), -0.5) + 1.4;
  const keel = new THREE.BoxGeometry(0.5, 0.5, 9);
  keel.rotateY(heading); keel.translate(kx, ky, kz); B.wood.push(keel);
  const LW = makeLW(kx, kz, heading);
  for (let i = -3; i <= 3; i++) {
    const cz = i * 1.3;
    const base = LW(0, ky, cz);
    for (const s of [-1, 1]) {
      const top = LW(s * 1.5, ky + 1.7, cz);
      B.wood.push(link(base.x, base.y, base.z, top.x, top.y, top.z, 0.09, 5));
    }
  }
  // scaffolding poles
  for (const s of [-1, 1]) {
    const p = LW(s * 2.2, 0, 0);
    const pole = new THREE.CylinderGeometry(0.1, 0.1, 3.2, 5);
    pole.translate(p.x, ky + 0.6, p.z); B.wood.push(pole);
  }
}

function addMarketStalls(B, style, LW, spot, d, rot, rng, field) {
  // 3 stalls clustered on the plaza-facing side
  for (let i = 0; i < 3; i++) {
    const off = (i - 1) * 3.4;
    const base = LW(off, spot.h, d / 2 + 3.2);
    const y = field.heightAt(base.x, base.z);
    const sr = rot + randRange(rng, -0.2, 0.2);
    const SLW = makeLW(base.x, base.z, sr);
    // table
    const table = new THREE.BoxGeometry(2.4, 0.12, 1.3);
    table.rotateY(sr); table.translate(base.x, y + 0.85, base.z); B.wood.push(table);
    for (const cxl of [-1.0, 1.0]) for (const czl of [-0.5, 0.5]) {
      const p = SLW(cxl, 0, czl);
      const leg = new THREE.CylinderGeometry(0.06, 0.06, 0.85, 5);
      leg.translate(p.x, y + 0.42, p.z); B.wood.push(leg);
    }
    // awning posts + striped canopy
    for (const cxl of [-1.1, 1.1]) {
      const p = SLW(cxl, 0, -0.6);
      const post = new THREE.CylinderGeometry(0.06, 0.06, 2.3, 5);
      post.translate(p.x, y + 1.15, p.z); B.wood.push(post);
    }
    B.cloth.push(quad(
      SLW(-1.4, y + 2.3, -0.9), SLW(1.4, y + 2.3, -0.9),
      SLW(1.4, y + 1.7, 0.9), SLW(-1.4, y + 1.7, 0.9)));
    // goods: sacks (barrels) + crates
    if (rng() < 0.7) addBarrel(B, SLW(-0.7, 0, 0.9).x, y + 0.42, SLW(-0.7, 0, 0.9).z, 0);
    addCrate(B, SLW(0.8, 0, 0.95).x, y, SLW(0.8, 0, 0.95).z, 0.6, sr);
    // little produce piles on the table
    for (let k = 0; k < 4; k++) {
      const p = SLW(randRange(rng, -0.9, 0.9), 0, randRange(rng, -0.4, 0.4));
      const fruit = new THREE.SphereGeometry(0.12, 6, 5);
      fruit.translate(p.x, y + 1.0, p.z); B.trim.push(fruit);
    }
  }
}

function addQuestBoard(B, LW, floorY, d, rot) {
  const p = LW(1.6, floorY, d / 2 + 0.8);
  for (const o of [-0.7, 0.7]) {
    const pp = LW(1.6 + o, floorY, d / 2 + 0.8);
    const post = new THREE.BoxGeometry(0.14, 2.4, 0.14);
    post.rotateY(rot); post.translate(pp.x, floorY + 1.2, pp.z); B.wood.push(post);
  }
  const panel = new THREE.BoxGeometry(1.7, 1.2, 0.1);
  panel.rotateY(rot); panel.translate(p.x, floorY + 1.6, p.z); B.dark.push(panel);
  const roof = new THREE.BoxGeometry(2.0, 0.12, 0.6);
  roof.rotateY(rot); roof.translate(p.x, floorY + 2.35, p.z); B.wood.push(roof);
  // a couple of pinned papers (light trim quads)
  for (let i = 0; i < 3; i++) {
    const pp = LW(1.6 + (i - 1) * 0.5, floorY + 1.6, d / 2 + 0.86);
    const paper = new THREE.PlaneGeometry(0.36, 0.44);
    paper.rotateY(rot); paper.translate(pp.x, pp.y, pp.z); B.trim.push(paper);
  }
}

function addWarehouseDoors(B, style, LW, floorY, w, d, rot) {
  // wide loading doors + a hoist beam & pulley rope jutting over them
  const bigDoor = new THREE.PlaneGeometry(w * 0.5, 3.0);
  const p = LW(0, floorY + 1.5, d / 2 + 0.03);
  bigDoor.rotateY(rot); bigDoor.translate(p.x, p.y, p.z); B.dark.push(bigDoor);
  const beam = LW(0, floorY + 4.4, d / 2 + 1.1);
  const hoist = new THREE.BoxGeometry(0.25, 0.25, 2.2);
  hoist.rotateY(rot); hoist.translate(beam.x, beam.y, beam.z); B.wood.push(hoist);
  const tip = LW(0, floorY + 4.3, d / 2 + 1.9);
  B.rope.push(link(tip.x, tip.y, tip.z, tip.x, floorY + 2.2, tip.z, 0.03, 4));
}

function addPortico(B, style, LW, floorY, w, d, rot) {
  // colonnade of stone columns + entablature over the manor entrance
  for (const cxl of [-w * 0.32, -w * 0.11, w * 0.11, w * 0.32]) {
    const p = LW(cxl, floorY, d / 2 + 1.6);
    const col = new THREE.CylinderGeometry(0.28, 0.32, 4.0, 10);
    col.translate(p.x, floorY + 2.0, p.z); B.stone.push(col);
    const capg = new THREE.BoxGeometry(0.8, 0.35, 0.8);
    capg.translate(p.x, floorY + 4.05, p.z); B.trim.push(capg);
  }
  const arch = LW(0, floorY + 4.4, d / 2 + 1.6);
  const ent = new THREE.BoxGeometry(w * 0.75, 0.6, 1.4);
  ent.rotateY(rot); ent.translate(arch.x, arch.y, arch.z); B.trim.push(ent);
  const roof = new THREE.BoxGeometry(w * 0.8, 0.3, 1.8);
  roof.rotateY(rot); roof.translate(arch.x, floorY + 4.85, arch.z); B.stone.push(roof);
}

function addTower(B, style, spot, rng) {
  // crown bastion: round stone shaft, crenellations, cannons, brazier + banner
  const hgt = 15;
  const y = spot.h;
  const shaft = new THREE.CylinderGeometry(4.2, 5.4, hgt, 12);
  shaft.translate(spot.x, y + hgt / 2, spot.z); B.stone.push(shaft);
  const band = new THREE.TorusGeometry(4.3, 0.3, 6, 14);
  band.rotateX(Math.PI / 2); band.translate(spot.x, y + hgt - 1.2, spot.z); B.trim.push(band);
  // crenellations
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const merlon = new THREE.BoxGeometry(0.9, 1.1, 0.7);
    merlon.rotateY(a);
    merlon.translate(spot.x + Math.cos(a) * 4.3, y + hgt + 0.55, spot.z + Math.sin(a) * 4.3);
    B.stone.push(merlon);
  }
  // cannons poking between merlons
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    const cannon = new THREE.CylinderGeometry(0.22, 0.28, 2.4, 8);
    cannon.rotateX(Math.PI / 2); cannon.rotateY(a);
    cannon.translate(spot.x + Math.sin(a) * 4.6, y + hgt + 0.2, spot.z + Math.cos(a) * 4.6);
    B.metal.push(cannon);
  }
  // signal brazier (emissive) + banner pole
  addLampGlass(B, spot.x, y + hgt + 1.4, spot.z, 0.5);
  const pole = new THREE.CylinderGeometry(0.1, 0.12, 4.5, 6);
  pole.translate(spot.x + 3.0, y + hgt + 2.0, spot.z); B.wood.push(pole);
  addBanner(B, style, spot.x + 3.0, y + hgt + 4.0, spot.z, 1.1, 2.4, 0);
}

function addLighthouse(B, style, field, x, z) {
  let base = field.heightAt(x, z);
  if (base < 0.3) base = 0.3;
  const hgt = 20;
  const shaft = new THREE.CylinderGeometry(2.1, 3.4, hgt, 14);
  shaft.translate(x, base + hgt / 2, z); B.stone.push(shaft);
  // painted bands (trim) — two rings
  for (const fy of [0.35, 0.7]) {
    const ring = new THREE.CylinderGeometry(2.85, 2.95, 2.2, 14);
    ring.translate(x, base + hgt * fy, z); B.trim.push(ring);
  }
  // gallery deck + rail
  const gallery = new THREE.CylinderGeometry(2.7, 2.7, 0.4, 14);
  gallery.translate(x, base + hgt, z); B.wood.push(gallery);
  for (let i = 0; i < 10; i++) {
    const a = (i / 10) * Math.PI * 2;
    const rp = new THREE.CylinderGeometry(0.06, 0.06, 1.0, 5);
    rp.translate(x + Math.cos(a) * 2.55, base + hgt + 0.5, z + Math.sin(a) * 2.55); B.metal.push(rp);
  }
  // lantern room (emissive glass) + conical cap
  const room = new THREE.CylinderGeometry(1.5, 1.5, 2.4, 12);
  room.translate(x, base + hgt + 1.6, z); B.lamp.push(room);
  const frameRing = new THREE.TorusGeometry(1.5, 0.12, 5, 12);
  frameRing.rotateX(Math.PI / 2); frameRing.translate(x, base + hgt + 0.5, z); B.metal.push(frameRing);
  const cap = new THREE.ConeGeometry(1.9, 2.4, 12);
  cap.translate(x, base + hgt + 4.0, z); B.roof.push(cap);
}

function addCrane(B, x, y, z, heading, dx, dz) {
  // dockside timber A-frame with a jib reaching over the water + hanging crate
  const LW = makeLW(x, z, heading);
  const topY = y + 6.5;
  for (const s of [-1, 1]) {
    const foot = LW(s * 1.4, y, -0.8), apex = LW(0, topY, -0.4);
    B.wood.push(link(foot.x, foot.y, foot.z, apex.x, apex.y, apex.z, 0.18, 6));
  }
  // back stay
  const back = LW(0, y, -3.0), apex = LW(0, topY, -0.4);
  B.wood.push(link(back.x, back.y, back.z, apex.x, apex.y, apex.z, 0.15, 6));
  B.rope.push(link(back.x, back.y + 0.2, back.z, apex.x, apex.y, apex.z, 0.04, 4));
  // jib arm out over the sea (+ along seaward dx,dz)
  const jibTip = LW(0, topY + 0.4, 4.6);
  B.wood.push(link(apex.x, apex.y, apex.z, jibTip.x, jibTip.y, jibTip.z, 0.16, 6));
  B.rope.push(link(apex.x, apex.y + 0.2, apex.z, jibTip.x, jibTip.y - 0.2, jibTip.z, 0.04, 4));
  // hook rope + hanging crate
  B.rope.push(link(jibTip.x, jibTip.y, jibTip.z, jibTip.x, y + 1.6, jibTip.z, 0.035, 4));
  const hook = new THREE.TorusGeometry(0.14, 0.05, 5, 8);
  hook.translate(jibTip.x, y + 1.5, jibTip.z); B.metal.push(hook);
  addCrate(B, jibTip.x, y + 0.6, jibTip.z, 1.0, heading);
  // winch drum at the base
  const drum = new THREE.CylinderGeometry(0.4, 0.4, 1.2, 8);
  drum.rotateZ(Math.PI / 2); drum.rotateY(heading);
  const dp = LW(0, y + 0.5, -1.6); drum.translate(dp.x, dp.y, dp.z); B.wood.push(drum);
}

function addWreckHouse(B, style, field, rng, x, z, heading, dx, dz, townCenter) {
  let gy = field.heightAt(x, z);
  if (gy < 0.2) gy = 0.2;
  // a beached hull half-buried in the sand, a shack riding its spine, a leaning
  // mast bell-tower, and a rope bridge slung toward the town.
  const hullRot = heading + randRange(rng, -0.4, 0.4);
  const hull = new THREE.CylinderGeometry(2.6, 3.4, 15, 10, 1, false, 0, Math.PI);
  hull.rotateZ(Math.PI / 2); hull.rotateY(hullRot);
  hull.translate(x, gy + 1.4, z); B.wood.push(hull);
  // ribs jutting from the broken end
  const LW = makeLW(x, z, hullRot);
  for (let i = -2; i <= 2; i++) {
    const rib = new THREE.CylinderGeometry(0.12, 0.12, 2.4, 5);
    const p = LW(i * 0.9, gy + 2.6, 6.8);
    rib.rotateZ(i * 0.2); rib.translate(p.x, p.y, p.z); B.wood.push(rib);
  }
  // shack on the hull spine
  const shackY = gy + 2.9;
  const shack = new THREE.BoxGeometry(4, 3, 4.5);
  shack.rotateY(hullRot); shack.translate(x, shackY + 1.5, z); B.wall.push(shack);
  addRoof(B, style, { x, z, h: shackY }, 4, 4.5, shackY + 3, hullRot);
  const glow = new THREE.PlaneGeometry(0.7, 0.9);
  const gp = LW(0, shackY + 1.5, 2.3);
  glow.rotateY(hullRot); glow.translate(gp.x, gp.y, gp.z); B.window.push(glow);
  // leaning mast bell-tower
  const mA = LW(-2.6, gy, -1), mB = LW(-3.8, gy + 11, -1);
  B.wood.push(link(mA.x, mA.y, mA.z, mB.x, mB.y, mB.z, 0.22, 6));
  // yard + bell
  const yard = new THREE.CylinderGeometry(0.1, 0.1, 3.2, 5);
  yard.rotateZ(Math.PI / 2); yard.rotateY(hullRot);
  const yp = LW(-3.4, gy + 8, -1); yard.translate(yp.x, yp.y, yp.z); B.wood.push(yard);
  const bell = new THREE.CylinderGeometry(0.35, 0.5, 0.7, 8);
  const bp = LW(-3.5, gy + 7.4, -1); bell.translate(bp.x, bp.y, bp.z); B.metal.push(bell);
  addLampGlass(B, mB.x, mB.y + 0.2, mB.z, 0.24);
  addBanner(B, style, mB.x, mB.y - 0.3, mB.z, 1.0, 2.2, hullRot);
  // rope bridge from the mast toward the town: two ropes + plank treads
  const bridgeEndX = x + (townCenter.x - x) * 0.32, bridgeEndZ = z + (townCenter.z - z) * 0.32;
  const bey = Math.max(field.heightAt(bridgeEndX, bridgeEndZ), 0.2) + 2.4;
  const postTop = { x: bridgeEndX, y: bey, z: bridgeEndZ };
  // support post at the far end
  const fpBottom = field.heightAt(bridgeEndX, bridgeEndZ);
  const fpost = new THREE.CylinderGeometry(0.18, 0.22, bey - fpBottom + 0.4, 6);
  fpost.translate(bridgeEndX, (bey + fpBottom) / 2, bridgeEndZ); B.wood.push(fpost);
  const ax = mB.x, ay = gy + 7, az = mB.z;
  for (const o of [-0.7, 0.7]) {
    // side ropes with a sag
    const midx = (ax + postTop.x) / 2, midz = (az + postTop.z) / 2;
    const px = -(postTop.z - az), pz = (postTop.x - ax);
    const pl = Math.hypot(px, pz) || 1;
    const ox = (px / pl) * o, oz = (pz / pl) * o;
    B.rope.push(link(ax + ox, ay, az + oz, midx + ox, (ay + postTop.y) / 2 - 0.8, midz + oz, 0.04));
    B.rope.push(link(midx + ox, (ay + postTop.y) / 2 - 0.8, midz + oz, postTop.x + ox, postTop.y, postTop.z + oz, 0.04));
  }
  // plank treads
  for (let i = 1; i < 8; i++) {
    const t = i / 8;
    const tx = ax + (postTop.x - ax) * t, tz = az + (postTop.z - az) * t;
    const ty = ay + (postTop.y - ay) * t - Math.sin(t * Math.PI) * 1.6;
    const tread = new THREE.BoxGeometry(1.5, 0.1, 0.4);
    tread.rotateY(Math.atan2(postTop.x - ax, postTop.z - az));
    tread.translate(tx, ty, tz); B.wood.push(tread);
  }
}

function addStarTower(B, style, field, x, z) {
  let base = field.heightAt(x, z);
  if (base < 0.2) base = 0.2;
  const hgt = 16;
  // slender tapered timber tower with a lit crown (tidebound star-tower motif)
  const shaft = new THREE.CylinderGeometry(1.2, 2.4, hgt, 9);
  shaft.translate(x, base + hgt / 2, z); B.wall.push(shaft);
  for (let i = 0; i < 3; i++) {
    const ring = new THREE.TorusGeometry(1.5 - i * 0.2, 0.14, 5, 10);
    ring.rotateX(Math.PI / 2); ring.translate(x, base + hgt * (0.4 + i * 0.22), z); B.trim.push(ring);
  }
  // openwork crown of struts + emissive core
  const crownY = base + hgt + 0.4;
  for (let i = 0; i < 6; i++) {
    const a = (i / 6) * Math.PI * 2;
    const strut = new THREE.CylinderGeometry(0.09, 0.09, 3.0, 5);
    strut.rotateZ(0.35); strut.rotateY(a);
    strut.translate(x + Math.cos(a) * 0.8, crownY + 1.2, z + Math.sin(a) * 0.8); B.wood.push(strut);
  }
  addLampGlass(B, x, crownY + 1.6, z, 0.7);
  const finial = new THREE.ConeGeometry(0.5, 1.6, 7);
  finial.translate(x, crownY + 3.2, z); B.trim.push(finial);
}
