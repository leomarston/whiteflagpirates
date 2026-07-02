// Weather state machine: wind, rain, storms, lightning — drives sea & sky.
import * as THREE from 'three';
import { clamp01, damp, lerp, mulberry32, randRange, TAU, wrapAngle } from '../core/utils.js';

const CONDITIONS = ['clear', 'fair', 'overcast', 'rain', 'storm'];

const PRESETS = {
  clear: { sea: 0.18, cloud: 0.14, wind: [3, 6], fog: 0.00006, rain: 0, gloom: 0 },
  fair: { sea: 0.3, cloud: 0.36, wind: [5, 8], fog: 0.00008, rain: 0, gloom: 0.08 },
  overcast: { sea: 0.45, cloud: 0.74, wind: [7, 10], fog: 0.00013, rain: 0, gloom: 0.42 },
  rain: { sea: 0.65, cloud: 0.9, wind: [9, 13], fog: 0.0002, rain: 0.7, gloom: 0.62 },
  storm: { sea: 1.0, cloud: 1.0, wind: [13, 17], fog: 0.00034, rain: 1, gloom: 1 },
};

export class Weather {
  constructor(ctx) {
    this.ctx = ctx;
    this._rng = mulberry32(20260702);
    this.condition = 'fair';
    this.intensity = 0.2;
    this.gloom = 0.08;
    this.fogDensity = 0.00008;

    this.wind = {
      angle: randRange(this._rng, 0, TAU),
      speed: 6,
      vector: new THREE.Vector3(),
    };
    this._windTargetAngle = this.wind.angle;
    this._windTargetSpeed = 6;

    this._nextTransition = randRange(this._rng, 120, 240);
    this._blend = 1; // 0..1 into current condition
    this._rainStrength = 0;

    this._lightningTimer = randRange(this._rng, 4, 12);

    this._buildRain();
  }

  _buildRain() {
    const quality = this.ctx.engine?.qualityProfile?.particleScale ?? 1;
    this._rainCount = Math.round(1300 * quality);
    const positions = new Float32Array(this._rainCount * 3);
    const rng = this._rng;
    for (let i = 0; i < this._rainCount; i++) {
      positions[i * 3] = randRange(rng, -60, 60);
      positions[i * 3 + 1] = randRange(rng, 0, 60);
      positions[i * 3 + 2] = randRange(rng, -60, 60);
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    this._rainMat = new THREE.PointsMaterial({
      color: 0xaebfd0,
      size: 1.6,
      sizeAttenuation: false,
      transparent: true,
      opacity: 0,
      depthWrite: false,
    });
    this.rain = new THREE.Points(geo, this._rainMat);
    this.rain.frustumCulled = false;
    this.rain.visible = false;
    this.ctx.scene.add(this.rain);
  }

  forceCondition(cond) {
    if (!CONDITIONS.includes(cond)) return;
    this.condition = cond;
    this._blend = 0;
    this._nextTransition = randRange(this._rng, 120, 260);
    this.ctx.events?.emit('weather:change', { condition: cond });
  }

  _pickNext() {
    const i = CONDITIONS.indexOf(this.condition);
    const rng = this._rng;
    // never jump more than one step; bias back toward fair weather
    const options = [];
    if (i > 0) options.push(CONDITIONS[i - 1], CONDITIONS[i - 1]);
    options.push(this.condition);
    if (i < CONDITIONS.length - 1) options.push(CONDITIONS[i + 1]);
    if (i <= 1) options.push(this.condition); // linger in good weather
    const next = options[Math.floor(rng() * options.length)];
    if (next !== this.condition) {
      this.condition = next;
      this._blend = 0;
      this.ctx.events?.emit('weather:change', { condition: next });
      if (next === 'storm') this.ctx.events?.emit('toast', { text: 'Storm rising — shorten sail!', kind: 'warn' });
    }
  }

  update(dt) {
    const { events, ocean, sky, camera, mode } = this.ctx;
    const preset = PRESETS[this.condition];

    this._nextTransition -= dt;
    if (this._nextTransition <= 0) {
      this._nextTransition = randRange(this._rng, 120, 280);
      this._pickNext();
    }
    this._blend = Math.min(1, this._blend + dt / 24);

    // targets blend smoothly toward the active preset
    this.gloom = damp(this.gloom, preset.gloom, 0.22, dt);
    this.fogDensity = lerp(this.fogDensity, preset.fog, Math.min(1, dt * 0.2));
    this.intensity = damp(this.intensity, CONDITIONS.indexOf(this.condition) / (CONDITIONS.length - 1), 0.15, dt);

    ocean?.setSeaState(preset.sea);
    sky?.setCoverage?.(preset.cloud);

    // wind: slow drift of angle, gusty speed
    if (this._rng() < dt * 0.02) {
      this._windTargetAngle += randRange(this._rng, -0.9, 0.9);
      this._windTargetSpeed = randRange(this._rng, preset.wind[0], preset.wind[1]);
    }
    this.wind.angle += wrapAngle(this._windTargetAngle - this.wind.angle) * Math.min(1, dt * 0.06);
    const gust = 1 + Math.sin(this.ctx.time.t * 0.7) * 0.08;
    this.wind.speed = damp(this.wind.speed, this._windTargetSpeed * gust, 0.3, dt);
    this.wind.vector.set(Math.sin(this.wind.angle), 0, Math.cos(this.wind.angle)).multiplyScalar(this.wind.speed);

    // rain
    this._rainStrength = damp(this._rainStrength, preset.rain, 0.4, dt);
    const raining = this._rainStrength > 0.03 && mode !== 'menu';
    this.rain.visible = raining;
    if (raining) {
      this._rainMat.opacity = this._rainStrength * 0.55;
      this.rain.position.copy(camera.position);
      const pos = this.rain.geometry.attributes.position;
      const fall = (22 + this.wind.speed) * dt;
      const wx = this.wind.vector.x * dt * 0.8;
      const wz = this.wind.vector.z * dt * 0.8;
      for (let i = 0; i < this._rainCount; i++) {
        let y = pos.getY(i) - fall;
        if (y < -4) {
          y = randRange(this._rng, 40, 60);
          pos.setX(i, randRange(this._rng, -60, 60));
          pos.setZ(i, randRange(this._rng, -60, 60));
        }
        pos.setY(i, y);
        pos.setX(i, pos.getX(i) + wx);
        pos.setZ(i, pos.getZ(i) + wz);
      }
      pos.needsUpdate = true;
    }

    // lightning during storms
    if (this.condition === 'storm') {
      this._lightningTimer -= dt;
      if (this._lightningTimer <= 0) {
        this._lightningTimer = randRange(this._rng, 4, 14);
        if (sky) sky.flash = randRange(this._rng, 0.5, 1.0);
        events?.emit('thunder', { delay: randRange(this._rng, 0.4, 3.4) });
      }
    }
  }
}
