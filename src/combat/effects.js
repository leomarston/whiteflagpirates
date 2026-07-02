// Pooled VFX: flashes, fire, smoke, spray, sparks, debris, foam rings.
import * as THREE from 'three';

const _v = new THREE.Vector3();

function softDotTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 2, 32, 32, 30);
  grad.addColorStop(0, 'rgba(255,255,255,1)');
  grad.addColorStop(0.5, 'rgba(255,255,255,0.5)');
  grad.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  return new THREE.CanvasTexture(c);
}

const poolVertex = /* glsl */ `
attribute float aLife;   // 1 fresh → 0 dead
attribute float aSize;
varying float vLife;
void main() {
  vLife = aLife;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_PointSize = aSize * (240.0 / max(-mv.z, 1.0));
  gl_Position = projectionMatrix * mv;
}
`;

const poolFragment = /* glsl */ `
precision mediump float;
uniform sampler2D uTex;
uniform vec3 uColorA;   // fresh
uniform vec3 uColorB;   // dying
uniform float uOpacity;
varying float vLife;
void main() {
  if (vLife <= 0.0) discard;
  vec4 t = texture2D(uTex, gl_PointCoord);
  vec3 col = mix(uColorB, uColorA, vLife);
  gl_FragColor = vec4(col, t.a * uOpacity * min(vLife * 2.0, 1.0));
}
`;

class ParticlePool {
  constructor(scene, tex, { count, colorA, colorB, additive, opacity = 1, gravity = 0, drag = 0, rise = 0, grow = 0 }) {
    this.count = count;
    this.gravity = gravity;
    this.drag = drag;
    this.rise = rise;
    this.grow = grow;
    this.pos = new Float32Array(count * 3);
    this.vel = new Float32Array(count * 3);
    this.life = new Float32Array(count);     // seconds remaining
    this.maxLife = new Float32Array(count);
    this.size = new Float32Array(count);
    this.cursor = 0;

    this.geo = new THREE.BufferGeometry();
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    this._aLife = new THREE.BufferAttribute(new Float32Array(count), 1);
    this.geo.setAttribute('aLife', this._aLife);
    this.geo.setAttribute('aSize', new THREE.BufferAttribute(this.size, 1));

    this.mat = new THREE.ShaderMaterial({
      vertexShader: poolVertex,
      fragmentShader: poolFragment,
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
    scene.add(this.points);
  }

  spawn(x, y, z, vx, vy, vz, life, size) {
    const i = this.cursor;
    this.cursor = (this.cursor + 1) % this.count;
    this.pos[i * 3] = x; this.pos[i * 3 + 1] = y; this.pos[i * 3 + 2] = z;
    this.vel[i * 3] = vx; this.vel[i * 3 + 1] = vy; this.vel[i * 3 + 2] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size[i] = size;
  }

  update(dt, wind) {
    const { pos, vel, life } = this;
    const dragK = Math.max(0, 1 - this.drag * dt);
    const wx = (wind?.x ?? 0) * 0.25 * dt;
    const wz = (wind?.z ?? 0) * 0.25 * dt;
    for (let i = 0; i < this.count; i++) {
      if (life[i] <= 0) { this._aLife.array[i] = 0; continue; }
      life[i] -= dt;
      vel[i * 3 + 1] += (this.rise - this.gravity) * dt;
      vel[i * 3] *= dragK;
      vel[i * 3 + 1] *= dragK;
      vel[i * 3 + 2] *= dragK;
      pos[i * 3] += vel[i * 3] * dt + wx;
      pos[i * 3 + 1] += vel[i * 3 + 1] * dt;
      pos[i * 3 + 2] += vel[i * 3 + 2] * dt + wz;
      const k = Math.max(life[i] / this.maxLife[i], 0);
      this._aLife.array[i] = k;
      if (this.grow) this.size[i] += this.grow * dt;
    }
    this.geo.attributes.position.needsUpdate = true;
    this._aLife.needsUpdate = true;
    this.geo.attributes.aSize.needsUpdate = true;
  }
}

export class Effects {
  constructor(ctx) {
    this.ctx = ctx;
    const scale = ctx.engine?.qualityProfile?.particleScale ?? 1;
    const tex = softDotTexture();
    const s = ctx.scene;

    this.flash = new ParticlePool(s, tex, { count: Math.round(60 * scale), colorA: 0xfff4d0, colorB: 0xff8a30, additive: true, drag: 2 });
    this.fire = new ParticlePool(s, tex, { count: Math.round(280 * scale), colorA: 0xffcf70, colorB: 0xc23a10, additive: true, rise: 2.4, drag: 1.4 });
    this.smoke = new ParticlePool(s, tex, { count: Math.round(420 * scale), colorA: 0x8a8a8a, colorB: 0x2e2e2e, opacity: 0.36, rise: 1.4, drag: 0.7, grow: 2.2 });
    this.spray = new ParticlePool(s, tex, { count: Math.round(420 * scale), colorA: 0xf4fbff, colorB: 0xbcd8e2, opacity: 0.75, gravity: 9.8, drag: 0.4 });
    this.sparkP = new ParticlePool(s, tex, { count: Math.round(160 * scale), colorA: 0xffe9a0, colorB: 0xff6a20, additive: true, gravity: 7, drag: 0.5 });

    // debris chunks
    this._debris = [];
    const debrisGeo = new THREE.BoxGeometry(0.28, 0.12, 0.55);
    const debrisMat = new THREE.MeshStandardMaterial({ color: 0x4a3826, roughness: 1 });
    this.debrisMesh = new THREE.InstancedMesh(debrisGeo, debrisMat, 32);
    this.debrisMesh.count = 0;
    this.debrisMesh.frustumCulled = false;
    s.add(this.debrisMesh);
    this._m = new THREE.Matrix4();
    this._q = new THREE.Quaternion();
    this._e = new THREE.Euler();

    // expanding foam rings
    this._rings = [];
    const ringGeo = new THREE.RingGeometry(0.8, 1.0, 24);
    ringGeo.rotateX(-Math.PI / 2);
    for (let i = 0; i < 10; i++) {
      const m = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({
        color: 0xeef4f2, transparent: true, opacity: 0, depthWrite: false,
      }));
      m.visible = false;
      s.add(m);
      this._rings.push({ mesh: m, t: 1, dur: 1, scale: 1 });
    }
    this._ringCursor = 0;

    // continuous fires attached to objects
    this._attachedFires = [];
  }

  explosion(pos, scale = 1) {
    for (let i = 0; i < 4; i++) {
      this.flash.spawn(pos.x, pos.y, pos.z, 0, 0, 0, 0.14 + i * 0.02, (7 + i * 3) * scale);
    }
    for (let i = 0; i < 16; i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 3.4 * scale;
      this.fire.spawn(
        pos.x, pos.y, pos.z,
        Math.cos(a) * r, Math.random() * 4 * scale, Math.sin(a) * r,
        0.4 + Math.random() * 0.4, (1.8 + Math.random() * 2.2) * scale,
      );
    }
    for (let i = 0; i < 12; i++) {
      const a = Math.random() * Math.PI * 2;
      this.smoke.spawn(
        pos.x, pos.y + 0.5, pos.z,
        Math.cos(a) * 1.2, 1 + Math.random() * 2, Math.sin(a) * 1.2,
        1.6 + Math.random() * 2.2, (2.5 + Math.random() * 3) * scale,
      );
    }
    this.sparks(pos, 12);
    this.woodBurst(pos, 5);
  }

  splash(pos, scale = 1) {
    for (let i = 0; i < Math.round(14 * scale); i++) {
      const a = Math.random() * Math.PI * 2;
      const r = Math.random() * 1.6 * scale;
      this.spray.spawn(
        pos.x, pos.y, pos.z,
        Math.cos(a) * r, (2.6 + Math.random() * 3.4) * Math.min(scale, 1.6), Math.sin(a) * r,
        0.7 + Math.random() * 0.5, 0.9 + Math.random() * 1.2 * scale,
      );
    }
    this._ring(pos, 1.2 * scale, 1.4);
  }

  muzzleFlash(pos, dir) {
    this.flash.spawn(pos.x, pos.y, pos.z, 0, 0, 0, 0.1, 4.5);
    for (let i = 0; i < 5; i++) {
      this.smoke.spawn(
        pos.x, pos.y, pos.z,
        dir.x * (3 + i) + (Math.random() - 0.5), 0.6 + Math.random() * 0.8, dir.z * (3 + i) + (Math.random() - 0.5),
        1.1 + Math.random() * 0.9, 1.2 + Math.random(),
      );
    }
  }

  woodBurst(pos, n = 8) {
    for (let i = 0; i < n; i++) {
      if (this._debris.length >= 30) break;
      const a = Math.random() * Math.PI * 2;
      this._debris.push({
        p: new THREE.Vector3(pos.x, pos.y, pos.z),
        v: new THREE.Vector3(Math.cos(a) * (2 + Math.random() * 4), 3 + Math.random() * 4, Math.sin(a) * (2 + Math.random() * 4)),
        rot: new THREE.Vector3(Math.random() * 6, Math.random() * 6, Math.random() * 6),
        spin: new THREE.Vector3((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8, (Math.random() - 0.5) * 8),
        life: 2.5,
      });
    }
    for (let i = 0; i < 4; i++) {
      this.smoke.spawn(pos.x, pos.y, pos.z, (Math.random() - 0.5) * 2, 1, (Math.random() - 0.5) * 2, 0.9, 1.6);
    }
  }

  sparks(pos, n = 8) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * Math.PI * 2;
      this.sparkP.spawn(
        pos.x, pos.y, pos.z,
        Math.cos(a) * (2 + Math.random() * 3), 1 + Math.random() * 3.5, Math.sin(a) * (2 + Math.random() * 3),
        0.3 + Math.random() * 0.3, 0.5 + Math.random() * 0.5,
      );
    }
  }

  fire(attachTo, localPos) {
    const rec = { obj: attachTo, local: localPos.clone(), active: true, acc: 0 };
    this._attachedFires.push(rec);
    return {
      stop: () => { rec.active = false; },
    };
  }

  _ring(pos, scale, dur) {
    const r = this._rings[this._ringCursor];
    this._ringCursor = (this._ringCursor + 1) % this._rings.length;
    r.mesh.position.set(pos.x, (this.ctx.ocean?.getHeight(pos.x, pos.z) ?? pos.y) + 0.12, pos.z);
    r.t = 0;
    r.dur = dur;
    r.scale = scale;
    r.mesh.visible = true;
  }

  update(dt) {
    const wind = this.ctx.weather?.wind.vector;
    this.flash.update(dt, wind);
    this.fire.update(dt, wind);
    this.smoke.update(dt, wind);
    this.spray.update(dt, wind);
    this.sparkP.update(dt, wind);

    // debris
    let n = 0;
    for (let i = this._debris.length - 1; i >= 0; i--) {
      const d = this._debris[i];
      d.life -= dt;
      d.v.y -= 9.8 * dt;
      d.p.addScaledVector(d.v, dt);
      d.rot.addScaledVector(d.spin, dt);
      const waterY = this.ctx.ocean?.getHeight(d.p.x, d.p.z) ?? 0;
      if (d.p.y < waterY) {
        this.splash(_v.set(d.p.x, waterY, d.p.z), 0.4);
        this._debris.splice(i, 1);
        continue;
      }
      if (d.life <= 0) { this._debris.splice(i, 1); continue; }
      this._e.set(d.rot.x, d.rot.y, d.rot.z);
      this._q.setFromEuler(this._e);
      this._m.compose(d.p, this._q, _v.set(1, 1, 1));
      this.debrisMesh.setMatrixAt(n++, this._m);
    }
    this.debrisMesh.count = n;
    if (n) this.debrisMesh.instanceMatrix.needsUpdate = true;

    // rings
    for (const r of this._rings) {
      if (!r.mesh.visible) continue;
      r.t += dt / r.dur;
      if (r.t >= 1) { r.mesh.visible = false; continue; }
      const s = (0.5 + r.t * 3.2) * r.scale;
      r.mesh.scale.set(s, 1, s);
      r.mesh.material.opacity = (1 - r.t) * 0.55;
    }

    // attached fires
    for (let i = this._attachedFires.length - 1; i >= 0; i--) {
      const f = this._attachedFires[i];
      if (!f.active || !f.obj.parent) { this._attachedFires.splice(i, 1); continue; }
      f.acc += dt;
      const interval = 0.05;
      while (f.acc > interval) {
        f.acc -= interval;
        _v.copy(f.local).applyMatrix4(f.obj.matrixWorld);
        this.fire.spawn(
          _v.x + (Math.random() - 0.5) * 0.6, _v.y, _v.z + (Math.random() - 0.5) * 0.6,
          (Math.random() - 0.5), 1.5 + Math.random(), (Math.random() - 0.5),
          0.5 + Math.random() * 0.3, 1.4 + Math.random(),
        );
        if (Math.random() < 0.4) {
          this.smoke.spawn(_v.x, _v.y + 1, _v.z, (Math.random() - 0.5), 2.2, (Math.random() - 0.5), 2.4, 2.2);
        }
      }
    }
  }
}
