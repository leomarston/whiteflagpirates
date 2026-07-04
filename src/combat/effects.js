// Pooled combat VFX — muzzle blasts, rolling smoke, meaty explosions, water
// splashes with foam rings & droplet arcs, persistent ship fires, wood splinters,
// hit sparks, and projectile trails. Everything is pooled and quality-scaled;
// hot paths allocate nothing.
//
// Public API (contract — do not remove/rename):
//   explosion(pos, scale)      splash(pos, scale)     muzzleFlash(pos, dir, scale?)
//   woodBurst(pos, n)          sparks(pos, n)         fire(attachTo, localPos) -> {stop}
//   update(dt)
// Additive helpers used by naval.js (safe to add): trail(pos), cannonBlast is folded
// into muzzleFlash(scale).
import * as THREE from 'three';

const _v = new THREE.Vector3();

// ---------------------------------------------------------------------------
// Procedural textures (built lazily inside the constructor, never at top level)
// ---------------------------------------------------------------------------
function softDotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 1, 32, 32, 31);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.35, 'rgba(255,255,255,0.72)');
  grad.addColorStop(0.7, 'rgba(255,255,255,0.22)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// A hot, bright core with a tight falloff — reads as a spark / ember / flash.
function emberTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 0.5, 32, 32, 30);
  grad.addColorStop(0.0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.22, 'rgba(255,240,200,0.95)');
  grad.addColorStop(0.55, 'rgba(255,150,60,0.35)');
  grad.addColorStop(1.0, 'rgba(255,90,20,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// A billowy, wispy puff for thick smoke — overlapping blobs punched by noise so
// edges read as turbulent cauliflower rather than a flat circle.
function smokePuffTexture() {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  g.clearRect(0, 0, S, S);
  // base soft disc
  const base = g.createRadialGradient(S / 2, S / 2, 4, S / 2, S / 2, S / 2 - 2);
  base.addColorStop(0, 'rgba(255,255,255,0.95)');
  base.addColorStop(0.55, 'rgba(255,255,255,0.55)');
  base.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = base;
  g.fillRect(0, 0, S, S);
  // stamp overlapping lobes for a cauliflower silhouette
  let seed = 1337;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  g.globalCompositeOperation = 'lighter';
  for (let i = 0; i < 22; i++) {
    const ang = rnd() * Math.PI * 2;
    const rad = (0.12 + rnd() * 0.34) * S;
    const px = S / 2 + Math.cos(ang) * rad;
    const py = S / 2 + Math.sin(ang) * rad;
    const rr = (0.1 + rnd() * 0.2) * S;
    const lobe = g.createRadialGradient(px, py, 1, px, py, rr);
    const a = 0.12 + rnd() * 0.22;
    lobe.addColorStop(0, `rgba(255,255,255,${a})`);
    lobe.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = lobe;
    g.fillRect(0, 0, S, S);
  }
  // erode the rim so it isn't a hard circle
  g.globalCompositeOperation = 'destination-out';
  for (let i = 0; i < 26; i++) {
    const ang = rnd() * Math.PI * 2;
    const rad = (0.36 + rnd() * 0.2) * S;
    const px = S / 2 + Math.cos(ang) * rad;
    const py = S / 2 + Math.sin(ang) * rad;
    const rr = (0.06 + rnd() * 0.12) * S;
    const bite = g.createRadialGradient(px, py, 1, px, py, rr);
    bite.addColorStop(0, `rgba(0,0,0,${0.25 + rnd() * 0.4})`);
    bite.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = bite;
    g.fillRect(0, 0, S, S);
  }
  g.globalCompositeOperation = 'source-over';
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Soft expanding foam-ring band (transparent core, bright mid, faded rim).
function ringTexture() {
  const S = 128;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(S / 2, S / 2, S * 0.16, S / 2, S / 2, S * 0.5);
  grad.addColorStop(0.0, 'rgba(255,255,255,0)');
  grad.addColorStop(0.5, 'rgba(238,244,242,0.05)');
  grad.addColorStop(0.72, 'rgba(255,255,255,0.9)');
  grad.addColorStop(0.86, 'rgba(230,242,240,0.5)');
  grad.addColorStop(1.0, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.beginPath();
  g.arc(S / 2, S / 2, S / 2, 0, Math.PI * 2);
  g.fill();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// ---------------------------------------------------------------------------
// GPU particle pool — one draw call, ring-buffered, zero per-frame allocation.
// Two shader variants: 'dot' (flashes/embers/spray) and 'smoke' (rotating,
// per-particle shaded billboards for thick plumes).
// ---------------------------------------------------------------------------
const dotVertex = /* glsl */ `
attribute float aLife;
attribute float aSize;
varying float vLife;
void main() {
  vLife = aLife;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (260.0 / max(-mv.z, 1.0));
  gl_Position = projectionMatrix * mv;
}
`;

const dotFragment = /* glsl */ `
precision mediump float;
uniform sampler2D uTex;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uOpacity;
varying float vLife;
void main() {
  if (vLife <= 0.0) discard;
  vec4 t = texture2D(uTex, gl_PointCoord);
  vec3 col = mix(uColorB, uColorA, vLife);
  gl_FragColor = vec4(col, t.a * uOpacity * min(vLife * 2.0, 1.0));
}
`;

const smokeVertex = /* glsl */ `
attribute float aLife;
attribute float aSize;
attribute float aRot;
attribute float aShade;
varying float vLife;
varying float vRot;
varying float vShade;
void main() {
  vLife = aLife;
  vRot = aRot;
  vShade = aShade;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (260.0 / max(-mv.z, 1.0));
  gl_Position = projectionMatrix * mv;
}
`;

const smokeFragment = /* glsl */ `
precision mediump float;
uniform sampler2D uTex;
uniform vec3 uColorA;
uniform vec3 uColorB;
uniform float uOpacity;
varying float vLife;
varying float vRot;
varying float vShade;
void main() {
  if (vLife <= 0.0) discard;
  vec2 pc = gl_PointCoord - 0.5;
  float c = cos(vRot), s = sin(vRot);
  pc = vec2(pc.x * c - pc.y * s, pc.x * s + pc.y * c) + 0.5;
  vec4 t = texture2D(uTex, pc);
  vec3 col = mix(uColorB, uColorA, vLife) * vShade;
  float age = 1.0 - vLife;
  float fade = smoothstep(0.0, 0.14, age) * min(vLife * 1.7, 1.0);
  gl_FragColor = vec4(col, t.a * uOpacity * fade);
}
`;

class ParticlePool {
  constructor(scene, tex, opts) {
    const {
      count, colorA, colorB, additive = false, opacity = 1,
      gravity = 0, drag = 0, rise = 0, grow = 0, variant = 'dot',
    } = opts;
    this.count = Math.max(4, count | 0);
    this.gravity = gravity;
    this.drag = drag;
    this.rise = rise;
    this.grow = grow;
    this.smoke = variant === 'smoke';

    const n = this.count;
    this.pos = new Float32Array(n * 3);
    this.vel = new Float32Array(n * 3);
    this.life = new Float32Array(n);
    this.maxLife = new Float32Array(n);
    this.size = new Float32Array(n);
    this.cursor = 0;

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this._aLife = new THREE.BufferAttribute(new Float32Array(n), 1);
    this._aSize = new THREE.BufferAttribute(this.size, 1);
    this.geo.setAttribute('aLife', this._aLife);
    this.geo.setAttribute('aSize', this._aSize);

    if (this.smoke) {
      this.rot = new Float32Array(n);
      this.spin = new Float32Array(n);
      this.shade = new Float32Array(n);
      this._aRot = new THREE.BufferAttribute(this.rot, 1);
      this._aShade = new THREE.BufferAttribute(this.shade, 1);
      this.geo.setAttribute('aRot', this._aRot);
      this.geo.setAttribute('aShade', this._aShade);
    }

    this.mat = new THREE.ShaderMaterial({
      vertexShader: this.smoke ? smokeVertex : dotVertex,
      fragmentShader: this.smoke ? smokeFragment : dotFragment,
      uniforms: {
        uTex: { value: tex },
        uColorA: { value: new THREE.Color(colorA) },
        uColorB: { value: new THREE.Color(colorB) },
        uOpacity: { value: opacity },
      },
      transparent: true,
      depthWrite: false,
      blending: additive ? THREE.AdditiveBlending : THREE.NormalBlending,
    });
    this.points = new THREE.Points(this.geo, this.mat);
    this.points.frustumCulled = false;
    this.points.renderOrder = additive ? 6 : 4;
    scene.add(this.points);
  }

  // shade/spin only consumed by the smoke variant; harmless otherwise.
  spawn(x, y, z, vx, vy, vz, life, size, shade = 1, spin = 0) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    const p3 = i * 3;
    this.pos[p3] = x; this.pos[p3 + 1] = y; this.pos[p3 + 2] = z;
    this.vel[p3] = vx; this.vel[p3 + 1] = vy; this.vel[p3 + 2] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
    if (this.smoke) {
      this.shade[i] = shade;
      this.rot[i] = Math.random() * 6.283;
      this.spin[i] = spin;
    }
  }

  update(dt, windX, windZ) {
    const { pos, vel, life, size } = this;
    const dragK = Math.max(0, 1 - this.drag * dt);
    const buoy = (this.rise - this.gravity) * dt;
    const wx = windX * dt;
    const wz = windZ * dt;
    const aLife = this._aLife.array;
    let any = false;
    for (let i = 0; i < this.count; i++) {
      if (life[i] <= 0) { if (aLife[i] !== 0) { aLife[i] = 0; any = true; } continue; }
      any = true;
      life[i] -= dt;
      const p3 = i * 3;
      vel[p3 + 1] += buoy;
      vel[p3] *= dragK;
      vel[p3 + 1] *= dragK;
      vel[p3 + 2] *= dragK;
      pos[p3] += vel[p3] * dt + wx;
      pos[p3 + 1] += vel[p3 + 1] * dt;
      pos[p3 + 2] += vel[p3 + 2] * dt + wz;
      aLife[i] = life[i] > 0 ? life[i] / this.maxLife[i] : 0;
      if (this.grow) size[i] += this.grow * dt;
      if (this.smoke) this.rot[i] += this.spin[i] * dt;
    }
    if (!any) return;
    this.geo.attributes.position.needsUpdate = true;
    this._aLife.needsUpdate = true;
    this._aSize.needsUpdate = true;
    if (this.smoke) {
      this._aRot.needsUpdate = true;
      this._aShade.needsUpdate = true;
    }
  }
}

export class Effects {
  constructor(ctx) {
    this.ctx = ctx;
    const scale = ctx.engine?.qualityProfile?.particleScale ?? 1;
    this.scale = scale;
    const s = ctx.scene;

    const dot = softDotTexture();
    const ember = emberTexture();
    const puff = smokePuffTexture();
    const ring = ringTexture();

    // hot, tight muzzle/explosion core flashes
    this.flash = new ParticlePool(s, ember, {
      count: Math.round(90 * scale), colorA: 0xfff6dc, colorB: 0xff7a26, additive: true, drag: 3.2,
    });
    // broad, bloom-friendly glow flares (the "point-light-free glow")
    this.glow = new ParticlePool(s, dot, {
      count: Math.round(48 * scale), colorA: 0xffe6b0, colorB: 0xff7420, additive: true, opacity: 0.85, drag: 2.4,
    });
    // flames / fireball
    this.fire = new ParticlePool(s, ember, {
      count: Math.round(340 * scale), colorA: 0xffdc8a, colorB: 0xb32c0a, additive: true, rise: 3.0, drag: 1.5,
    });
    // thick rolling smoke — one pool, per-particle shade covers pale cannon
    // smoke through oily black column smoke
    this.smoke = new ParticlePool(s, puff, {
      count: Math.round(620 * scale), colorA: 0xbfbfbf, colorB: 0x242424, opacity: 0.62,
      rise: 1.5, drag: 0.62, grow: 2.4, variant: 'smoke',
    });
    // water spray droplets
    this.spray = new ParticlePool(s, dot, {
      count: Math.round(480 * scale), colorA: 0xf6fdff, colorB: 0xa9cfda, opacity: 0.8, gravity: 12, drag: 0.5,
    });
    // hot embers / hit sparks
    this.sparkP = new ParticlePool(s, ember, {
      count: Math.round(240 * scale), colorA: 0xfff0b0, colorB: 0xff5a18, additive: true, gravity: 9, drag: 0.55,
    });
    // wood splinters / dust chips
    this.chips = new ParticlePool(s, dot, {
      count: Math.round(220 * scale), colorA: 0x9c7b4e, colorB: 0x3c2c1a, opacity: 0.9, gravity: 11, drag: 0.9,
    });
    // thin, fast-fading projectile trail wisps
    this.trailP = new ParticlePool(s, puff, {
      count: Math.round(300 * scale), colorA: 0xcfcfcf, colorB: 0x6a6a6a, opacity: 0.34,
      rise: 0.6, drag: 1.2, grow: 1.4, variant: 'smoke',
    });

    this._pools = [this.flash, this.glow, this.fire, this.smoke, this.spray, this.sparkP, this.chips, this.trailP];

    // --- wood debris chunks (instanced, pooled — no per-hit allocation) ------
    const debrisGeo = new THREE.BoxGeometry(0.26, 0.13, 0.6);
    const debrisMat = new THREE.MeshStandardMaterial({ color: 0x4a3826, roughness: 1, metalness: 0 });
    this._debrisCap = 44;
    this.debrisMesh = new THREE.InstancedMesh(debrisGeo, debrisMat, this._debrisCap);
    this.debrisMesh.count = 0;
    this.debrisMesh.frustumCulled = false;
    this.debrisMesh.castShadow = false;
    s.add(this.debrisMesh);
    this._debris = [];
    for (let i = 0; i < this._debrisCap; i++) {
      this._debris.push({
        active: false,
        p: new THREE.Vector3(), v: new THREE.Vector3(),
        rot: new THREE.Vector3(), spin: new THREE.Vector3(),
        sc: 1, life: 0,
      });
    }
    this._debrisCursor = 0;
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();
    this._scl = new THREE.Vector3();

    // --- expanding foam rings (textured, pooled) -----------------------------
    const ringGeo = new THREE.PlaneGeometry(1, 1);
    ringGeo.rotateX(-Math.PI / 2);
    this._rings = [];
    for (let i = 0; i < 16; i++) {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        map: ring, color: 0xeef4f2, transparent: true, opacity: 0,
        depthWrite: false, blending: THREE.NormalBlending,
      }));
      m.visible = false;
      m.renderOrder = 3;
      s.add(m);
      this._rings.push({ mesh: m, t: 1, dur: 1, from: 1, to: 4 });
    }
    this._ringCursor = 0;

    // --- persistent attached fires ------------------------------------------
    this._attachedFires = [];
  }

  // -- public: big cannon/pistol muzzle discharge --------------------------
  // scale ~1 = pistol; naval passes ~1.2–1.8 for cannon.
  muzzleFlash(pos, dir, scale = 1) {
    const dx = dir?.x ?? 0, dz = dir?.z ?? 0, dy = dir?.y ?? 0;
    // white-hot core + forward jet flashes
    this.flash.spawn(pos.x, pos.y, pos.z, dx * 6, dy * 6 + 0.4, dz * 6, 0.07 * scale + 0.05, 5.5 * scale);
    this.flash.spawn(pos.x + dx * 0.6, pos.y + dy * 0.6, pos.z + dz * 0.6, dx * 10, dy * 10, dz * 10, 0.09, 3.4 * scale);
    // soft glow flare (blooms; no PointLight)
    this.glow.spawn(pos.x + dx * 0.5, pos.y + 0.1, pos.z + dz * 0.5, 0, 0.2, 0, 0.11, 9 * scale);
    // muzzle ember spit along the barrel
    const embers = Math.round(5 * scale);
    for (let i = 0; i < embers; i++) {
      const sp = 6 + Math.random() * 10;
      this.sparkP.spawn(
        pos.x, pos.y, pos.z,
        dx * sp + (Math.random() - 0.5) * 4, Math.abs(dy) * sp + Math.random() * 2 + 0.5, dz * sp + (Math.random() - 0.5) * 4,
        0.18 + Math.random() * 0.22, (0.5 + Math.random() * 0.6) * scale,
      );
    }
    // thick rolling smoke plume, thrown forward then buoyant, drifts on wind
    const puffs = Math.round(6 * scale);
    for (let i = 0; i < puffs; i++) {
      const f = 2.5 + i * 1.6;
      this.smoke.spawn(
        pos.x + dx * (0.4 + i * 0.2), pos.y + 0.1, pos.z + dz * (0.4 + i * 0.2),
        dx * f + (Math.random() - 0.5) * 1.4, 0.7 + Math.random() * 0.9, dz * f + (Math.random() - 0.5) * 1.4,
        1.1 + Math.random() * 0.9, (1.6 + Math.random() * 1.4) * scale,
        0.82 + Math.random() * 0.18, (Math.random() - 0.5) * 1.4,
      );
    }
  }

  // -- public: meaty explosion (flash → fireball → smoke column → sparks → debris)
  explosion(pos, scale = 1) {
    const x = pos.x, y = pos.y, z = pos.z;
    // 1) white flash + glow flare
    for (let i = 0; i < 4; i++) {
      this.flash.spawn(x, y, z, 0, i * 0.6, 0, 0.12 + i * 0.02, (9 + i * 4) * scale);
    }
    this.glow.spawn(x, y + 0.4, z, 0, 1, 0, 0.2, 16 * scale);
    this.glow.spawn(x, y + 0.4, z, 0, 1, 0, 0.34, 26 * scale);
    // 2) fireball — bursts outward and up
    const fb = Math.round(20 * scale);
    for (let i = 0; i < fb; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 4.2 * scale;
      this.fire.spawn(
        x, y, z,
        Math.cos(a) * r, Math.random() * 5.5 * scale + 0.5, Math.sin(a) * r,
        0.45 + Math.random() * 0.5, (2.2 + Math.random() * 2.6) * scale,
      );
    }
    // 3) rising oily smoke column
    const col = Math.round(16 * scale);
    for (let i = 0; i < col; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 1.6 * scale;
      this.smoke.spawn(
        x + Math.cos(a) * r, y + 0.6 + Math.random() * 1.5, z + Math.sin(a) * r,
        Math.cos(a) * 1.3, 2.2 + Math.random() * 3.4, Math.sin(a) * 1.3,
        1.8 + Math.random() * 2.4, (2.6 + Math.random() * 3.2) * scale,
        0.28 + Math.random() * 0.24, (Math.random() - 0.5) * 1.0,
      );
    }
    // 4) sparks + 5) debris (debris splash on water splashdown)
    this.sparks(pos, Math.round(16 * scale));
    this.woodBurst(pos, Math.round(7 * scale));
  }

  // -- public: water splash — column + droplet arcs + expanding foam rings ----
  splash(pos, scale = 1) {
    const x = pos.x, y = pos.y, z = pos.z;
    const cap = Math.min(scale, 2.2);
    // central vertical burst
    const jet = Math.round(8 * scale);
    for (let i = 0; i < jet; i++) {
      this.spray.spawn(
        x + (Math.random() - 0.5) * 0.5 * scale, y, z + (Math.random() - 0.5) * 0.5 * scale,
        (Math.random() - 0.5) * 1.6, (5 + Math.random() * 4) * cap, (Math.random() - 0.5) * 1.6,
        0.55 + Math.random() * 0.5, 0.8 + Math.random() * 1.1 * scale,
      );
    }
    // outward droplet arcs (ballistic)
    const arc = Math.round(12 * scale);
    for (let i = 0; i < arc; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = (2.5 + Math.random() * 3.5) * cap;
      this.spray.spawn(
        x, y + 0.1, z,
        Math.cos(a) * r, (2.4 + Math.random() * 3.2) * cap, Math.sin(a) * r,
        0.7 + Math.random() * 0.6, 0.55 + Math.random() * 0.7 * scale,
      );
    }
    // low foam mist at the base
    this.smoke.spawn(x, y + 0.15, z, 0, 0.5, 0, 0.5 + Math.random() * 0.3, 2.0 * scale, 1.0, 0.4);
    // two staggered foam rings
    this._ring(pos, 1.1 * scale, 4.2 * scale, 0.9 + 0.5 * scale);
    this._ring(pos, 0.7 * scale, 2.6 * scale, 0.55 + 0.3 * scale);
  }

  // -- public: wood splinter burst ------------------------------------------
  woodBurst(pos, n = 8) {
    const x = pos.x, y = pos.y, z = pos.z;
    // flying chunks
    for (let i = 0; i < n; i++) {
      const d = this._debris[this._debrisCursor];
      this._debrisCursor = (this._debrisCursor + 1) % this._debrisCap;
      const a = Math.random() * Math.PI * 2;
      const sp = 2 + Math.random() * 5;
      d.active = true;
      d.p.set(x, y, z);
      d.v.set(Math.cos(a) * sp, 3 + Math.random() * 5, Math.sin(a) * sp);
      d.rot.set(Math.random() * 6, Math.random() * 6, Math.random() * 6);
      d.spin.set((Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10, (Math.random() - 0.5) * 10);
      d.sc = 0.6 + Math.random() * 0.9;
      d.life = 2.3 + Math.random() * 0.8;
    }
    // fine splinters + dust
    const chips = n * 3;
    for (let i = 0; i < chips; i++) {
      const a = Math.random() * Math.PI * 2;
      const sp = 3 + Math.random() * 7;
      this.chips.spawn(
        x, y, z,
        Math.cos(a) * sp, 2 + Math.random() * 5, Math.sin(a) * sp,
        0.4 + Math.random() * 0.5, 0.25 + Math.random() * 0.4,
      );
    }
    // puff of dust smoke
    for (let i = 0; i < 3; i++) {
      this.smoke.spawn(
        x, y, z, (Math.random() - 0.5) * 2, 0.8 + Math.random(), (Math.random() - 0.5) * 2,
        0.7 + Math.random() * 0.5, 1.4 + Math.random(), 0.7, (Math.random() - 0.5) * 1.2,
      );
    }
  }

  // -- public: hit sparks ---------------------------------------------------
  sparks(pos, n = 8) {
    const x = pos.x, y = pos.y, z = pos.z;
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = 2 + Math.random() * 4;
      this.sparkP.spawn(
        x, y, z,
        Math.cos(a) * r, 1.5 + Math.random() * 4.5, Math.sin(a) * r,
        0.28 + Math.random() * 0.32, 0.45 + Math.random() * 0.5,
      );
    }
  }

  // -- public: thin projectile trail wisp (called by naval per cannonball) --
  trail(pos) {
    this.trailP.spawn(
      pos.x, pos.y, pos.z,
      (Math.random() - 0.5) * 0.6, 0.3 + Math.random() * 0.4, (Math.random() - 0.5) * 0.6,
      0.28 + Math.random() * 0.18, 0.5 + Math.random() * 0.4,
      0.9, (Math.random() - 0.5) * 2,
    );
  }

  // -- public: persistent fire attached to a moving object ------------------
  fire(attachTo, localPos) {
    const rec = {
      obj: attachTo, local: localPos.clone(), active: true,
      acc: Math.random() * 0.05, seed: Math.random() * 100,
    };
    this._attachedFires.push(rec);
    return { stop: () => { rec.active = false; } };
  }

  _ring(pos, from, to, opacity) {
    const r = this._rings[this._ringCursor];
    this._ringCursor = (this._ringCursor + 1) % this._rings.length;
    const wy = (this.ctx.ocean?.getHeight(pos.x, pos.z) ?? pos.y) + 0.14;
    r.mesh.position.set(pos.x, wy, pos.z);
    r.t = 0;
    r.dur = 0.9 + to * 0.12;
    r.from = from;
    r.to = to;
    r.opacity = opacity;
    r.mesh.visible = true;
  }

  update(dt) {
    const wind = this.ctx.weather?.wind?.vector;
    // wind advection: light for droplets/embers, stronger for smoke handled per-pool
    const wx = (wind?.x ?? 0);
    const wz = (wind?.z ?? 0);
    this.flash.update(dt, 0, 0);
    this.glow.update(dt, 0, 0);
    this.fire.update(dt, wx * 0.15, wz * 0.15);
    this.smoke.update(dt, wx * 0.42, wz * 0.42);
    this.spray.update(dt, wx * 0.1, wz * 0.1);
    this.sparkP.update(dt, wx * 0.12, wz * 0.12);
    this.chips.update(dt, 0, 0);
    this.trailP.update(dt, wx * 0.3, wz * 0.3);

    // debris chunks (with water splashdown)
    let n = 0;
    for (let i = 0; i < this._debrisCap; i++) {
      const d = this._debris[i];
      if (!d.active) continue;
      d.life -= dt;
      d.v.y -= 9.8 * dt;
      d.v.multiplyScalar(Math.max(0, 1 - 0.35 * dt));
      d.p.addScaledVector(d.v, dt);
      d.rot.addScaledVector(d.spin, dt);
      const waterY = this.ctx.ocean?.getHeight(d.p.x, d.p.z) ?? 0;
      if (d.p.y < waterY) {
        this.splash(_v.set(d.p.x, waterY, d.p.z), 0.4);
        d.active = false;
        continue;
      }
      if (d.life <= 0) { d.active = false; continue; }
      if (n < this._debrisCap) {
        this._e.set(d.rot.x, d.rot.y, d.rot.z);
        this._q.setFromEuler(this._e);
        this._scl.set(d.sc, d.sc, d.sc);
        this._m.compose(d.p, this._q, this._scl);
        this.debrisMesh.setMatrixAt(n++, this._m);
      }
    }
    this.debrisMesh.count = n;
    if (n) this.debrisMesh.instanceMatrix.needsUpdate = true;

    // expanding foam rings
    for (const r of this._rings) {
      if (!r.mesh.visible) continue;
      r.t += dt / r.dur;
      if (r.t >= 1) { r.mesh.visible = false; continue; }
      const e = 1 - (1 - r.t) * (1 - r.t); // ease-out expansion
      const s = r.from + (r.to - r.from) * e;
      r.mesh.scale.set(s, 1, s);
      r.mesh.material.opacity = (1 - r.t) * (r.opacity ?? 0.7);
    }

    // persistent attached fires — flicker, black smoke column, heat glow
    const t = this.ctx.time?.t ?? 0;
    for (let i = this._attachedFires.length - 1; i >= 0; i--) {
      const f = this._attachedFires[i];
      if (!f.active || !f.obj || !f.obj.parent) { this._attachedFires.splice(i, 1); continue; }
      f.acc += dt;
      // flicker modulates spawn cadence + intensity
      const flick = 0.6 + 0.4 * Math.sin(t * 22 + f.seed) * Math.sin(t * 9.3 + f.seed * 1.7);
      const interval = 0.045;
      while (f.acc > interval) {
        f.acc -= interval;
        _v.copy(f.local).applyMatrix4(f.obj.matrixWorld);
        const jx = (Math.random() - 0.5) * 0.7;
        const jz = (Math.random() - 0.5) * 0.7;
        // licking flames
        this.fire.spawn(
          _v.x + jx, _v.y, _v.z + jz,
          jx * 1.5, (2.0 + Math.random() * 2.2) * (0.7 + flick * 0.5), jz * 1.5,
          0.5 + Math.random() * 0.35, (1.2 + Math.random() * 1.1) * (0.8 + flick * 0.4),
        );
        // black smoke column
        if (Math.random() < 0.55) {
          this.smoke.spawn(
            _v.x + jx * 0.6, _v.y + 1.0, _v.z + jz * 0.6,
            jx, 2.6 + Math.random() * 1.8, jz,
            2.2 + Math.random() * 1.6, 2.2 + Math.random() * 1.4,
            0.22 + Math.random() * 0.18, (Math.random() - 0.5) * 0.8,
          );
        }
        // popping embers
        if (Math.random() < 0.3) {
          const a = Math.random() * Math.PI * 2;
          this.sparkP.spawn(
            _v.x, _v.y + 0.2, _v.z,
            Math.cos(a) * 1.5, 2 + Math.random() * 3, Math.sin(a) * 1.5,
            0.4 + Math.random() * 0.4, 0.35 + Math.random() * 0.35,
          );
        }
      }
      // heat-shimmer-ish glow that throbs with the flicker (blooms)
      if (Math.random() < 0.5) {
        _v.copy(f.local).applyMatrix4(f.obj.matrixWorld);
        this.glow.spawn(_v.x, _v.y + 0.5, _v.z, 0, 0.6, 0, 0.14, (2.5 + flick * 3.5));
      }
    }
  }
}
