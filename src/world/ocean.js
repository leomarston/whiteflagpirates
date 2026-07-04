// The sea — GPU Gerstner surface physically mirrored by core/utils sampling.
import * as THREE from 'three';
import { COLORS, WORLD } from '../core/constants.js';
import {
  clamp, clamp01, damp, lerp, sampleOceanHeight, sampleOceanNormal,
  seaStateScale, SimplexNoise, smoothstep,
} from '../core/utils.js';
import { buildWaveUniforms, oceanFragment, oceanVertex } from './oceanShaders.js';

const NEAR_SIZE = 2600;   // high-detail grid extent (m)
const FAR_RADIUS = 15500; // horizon skirt

// Wake foam: a world-anchored foam mask painted around the camera each frame.
const WAKE_RES = 256;     // texels
const WAKE_SIZE = 900;    // world extent of the wake window (m)
const WAKE_CAP = 176;     // ring-buffer of trail stamps
const WAKE_LIFE = 7.0;    // s a stamp survives
const WAKE_DROP = 7.0;    // m between stamps along a ship's path

export class Ocean {
  constructor(ctx) {
    this.ctx = ctx;
    this.seaState = 0.3;
    this._targetSeaState = 0.3;
    this._scratchN = new THREE.Vector3();
    this._sunDirFallback = new THREE.Vector3(0.35, 0.75, 0.45).normalize();
    this._windDir = new THREE.Vector2(0.6, 0.8).normalize();

    const waves = buildWaveUniforms();
    const detail = ctx.engine?.qualityProfile?.oceanDetail ?? 1;
    const segs = Math.max(96, Math.round(232 * detail));

    this._buildWake();

    this.uniforms = {
      uTime: { value: 0 },
      uAmp: { value: seaStateScale(this.seaState) },
      uWaveDir: { value: waves.dirs },
      uWaveK: { value: waves.ks },
      uWaveC: { value: waves.cs },
      uWaveA: { value: waves.as },
      uTotalAmp: { value: waves.as.reduce((s, a) => s + a, 0) },
      uShoreTex: { value: this._buildShoreTexture() },
      uWorldSize: { value: WORLD.SEA_SIZE },
      uDeepColor: { value: new THREE.Color(COLORS.deepWater) },
      uShallowColor: { value: new THREE.Color(COLORS.shallowWater) },
      uShoreColor: { value: new THREE.Color(0x3ec9b6) },
      uFoamColor: { value: new THREE.Color(COLORS.foam) },
      uSSSColor: { value: new THREE.Color(0x2fb488) },
      uSkyZenith: { value: new THREE.Color(0x2b5d8a) },
      uSkyHorizon: { value: new THREE.Color(0xbdd3dd) },
      uSunDir: { value: this._sunDirFallback.clone() },
      uSunColor: { value: new THREE.Color(0xfff2d8) },
      uNight: { value: 0 },
      uSeaState: { value: this.seaState },
      uNoiseTex: { value: this._buildNoiseTexture() },
      uNormalTex: { value: this._buildNormalTexture() },
      uWindDir: { value: this._windDir.clone() },
      uWindSpeed: { value: 8 },
      uCamPos: { value: new THREE.Vector3() },
      uFogColor: { value: new THREE.Color(0xbdd3dd) },
      uFogDensity: { value: 0.00006 },
      uStormMix: { value: 0 },
      uWakeTex: { value: this._wakeTex },
      uWakeOrigin: { value: new THREE.Vector2() },
      uWakeSize: { value: WAKE_SIZE },
      uWakeStrength: { value: 0 },
    };

    const material = new THREE.ShaderMaterial({
      vertexShader: oceanVertex,
      fragmentShader: oceanFragment,
      uniforms: this.uniforms,
      fog: false,
    });
    this.material = material;

    const nearGeo = new THREE.PlaneGeometry(NEAR_SIZE, NEAR_SIZE, segs, segs);
    nearGeo.rotateX(-Math.PI / 2);
    this.nearMesh = new THREE.Mesh(nearGeo, material);
    this.nearMesh.frustumCulled = false;
    this.nearMesh.renderOrder = -2;
    ctx.scene.add(this.nearMesh);

    // Far ring: coarse rings toward the horizon (LOD). Denser near the seam so
    // the swell reads far out, sparse toward the sky where fog takes over.
    const farGeo = new THREE.RingGeometry(NEAR_SIZE / 2 - 24, FAR_RADIUS, 128, 10);
    farGeo.rotateX(-Math.PI / 2);
    this.farMesh = new THREE.Mesh(farGeo, material);
    this.farMesh.frustumCulled = false;
    this.farMesh.renderOrder = -3;
    this.farMesh.position.y = -0.06;
    ctx.scene.add(this.farMesh);

    this._cellSize = NEAR_SIZE / segs;
    this._wakeSources = [];
  }

  _buildNoiseTexture() {
    const size = 256;
    const noise = new SimplexNoise(9182);
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = (y * size + x) * 4;
        // tileable-ish: sample on a torus
        const a = (x / size) * Math.PI * 2;
        const b = (y / size) * Math.PI * 2;
        const nx = Math.cos(a) * 1.4, ny = Math.sin(a) * 1.4;
        const nz = Math.cos(b) * 1.4, nw = Math.sin(b) * 1.4;
        const v1 = noise.noise2D(nx + nz, ny + nw);
        const v2 = noise.noise2D(nx * 2.3 - nw, ny * 2.3 + nz);
        const v3 = noise.noise2D(nx * 4.1 + 7.7, nw * 4.1 - 3.3);
        data[i] = (v1 * 0.5 + 0.5) * 255;
        data[i + 1] = (v2 * 0.5 + 0.5) * 255;
        data[i + 2] = (v3 * 0.5 + 0.5) * 255;
        data[i + 3] = 255;
      }
    }
    const tex = new THREE.DataTexture(data, size, size);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  }

  /** Tileable ripple normal map: RG = horizontal slope, B = up. Fine fbm relief. */
  _buildNormalTexture() {
    const size = 256;
    const noise = new SimplexNoise(4471);
    const h = new Float32Array(size * size);
    // seamless height field sampled on a torus, layered for crisp small ripples
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const a = (x / size) * Math.PI * 2;
        const b = (y / size) * Math.PI * 2;
        const cx = Math.cos(a), sx = Math.sin(a);
        const cz = Math.cos(b), sz = Math.sin(b);
        let v = 0;
        v += noise.noise2D((cx + cz) * 1.6, (sx + sz) * 1.6) * 0.6;
        v += noise.noise2D((cx - sz) * 3.3, (sx + cz) * 3.3) * 0.3;
        v += noise.noise2D((cx + sz) * 6.1 + 5.0, (sx - cz) * 6.1 - 2.0) * 0.16;
        h[y * size + x] = v;
      }
    }
    const data = new Uint8Array(size * size * 4);
    const strength = 1.9;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const xl = (x - 1 + size) % size, xr = (x + 1) % size;
        const yd = (y - 1 + size) % size, yu = (y + 1) % size;
        const nx = (h[y * size + xl] - h[y * size + xr]) * strength;
        const nz = (h[yd * size + x] - h[yu * size + x]) * strength;
        const inv = 1 / Math.hypot(nx, nz, 1);
        const i = (y * size + x) * 4;
        data[i] = (nx * inv * 0.5 + 0.5) * 255;
        data[i + 1] = (nz * inv * 0.5 + 0.5) * 255;
        data[i + 2] = (1 * inv * 0.5 + 0.5) * 255;
        data[i + 3] = 255;
      }
    }
    const tex = new THREE.DataTexture(data, size, size);
    tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearMipmapLinearFilter;
    tex.generateMipmaps = true;
    tex.needsUpdate = true;
    return tex;
  }

  _buildWake() {
    this._wakeData = new Uint8Array(WAKE_RES * WAKE_RES);
    const tex = new THREE.DataTexture(
      this._wakeData, WAKE_RES, WAKE_RES, THREE.RedFormat, THREE.UnsignedByteType,
    );
    tex.wrapS = tex.wrapT = THREE.ClampToEdgeWrapping;
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    this._wakeTex = tex;
    this._wakeX = new Float32Array(WAKE_CAP);
    this._wakeZ = new Float32Array(WAKE_CAP);
    this._wakeAge = new Float32Array(WAKE_CAP).fill(WAKE_LIFE + 1);
    this._wakeHead = 0;
    this._wakeLast = new Map(); // source obj -> last-dropped {x, z}
  }

  /** R channel = shore proximity: 0 open sea → 1 at/inside the coastline. */
  _buildShoreTexture() {
    const size = 512;
    const islands = this.ctx.data?.islands ?? [];
    const data = new Uint8Array(size * size * 4);
    const half = WORLD.SEA_SIZE / 2;
    for (let y = 0; y < size; y++) {
      const wz = (y / (size - 1)) * WORLD.SEA_SIZE - half;
      for (let x = 0; x < size; x++) {
        const wx = (x / (size - 1)) * WORLD.SEA_SIZE - half;
        let s = 0;
        for (const isl of islands) {
          const dx = wx - isl.position[0];
          const dz = wz - isl.position[1];
          const d = Math.sqrt(dx * dx + dz * dz);
          // 1 inside 0.72r, fading to 0 at 1.55r
          const t = 1 - smoothstep(isl.radius * 0.72, isl.radius * 1.55, d);
          if (t > s) s = t;
        }
        const i = (y * size + x) * 4;
        data[i] = clamp(Math.round(s * 255), 0, 255);
        data[i + 3] = 255;
      }
    }
    const tex = new THREE.DataTexture(data, size, size);
    tex.magFilter = THREE.LinearFilter;
    tex.minFilter = THREE.LinearFilter;
    tex.needsUpdate = true;
    return tex;
  }

  getHeight(x, z) {
    return sampleOceanHeight(x, z, this.ctx.time.t, this.seaState);
  }

  getNormal(x, z) {
    return sampleOceanNormal(x, z, this.ctx.time.t, this.seaState, this._scratchN);
  }

  setSeaState(s) {
    this._targetSeaState = clamp(s, 0.1, 1);
  }

  addWakeSource(obj) {
    if (obj && !this._wakeSources.includes(obj)) this._wakeSources.push(obj);
  }

  _emitWake(x, z) {
    const h = this._wakeHead;
    this._wakeX[h] = x;
    this._wakeZ[h] = z;
    this._wakeAge[h] = 0;
    this._wakeHead = (h + 1) % WAKE_CAP;
  }

  _updateWake(dt) {
    const sources = this._wakeSources;
    if (!sources.length) {
      if (this.uniforms.uWakeStrength.value !== 0) this.uniforms.uWakeStrength.value = 0;
      return;
    }

    for (let i = 0; i < WAKE_CAP; i++) this._wakeAge[i] += dt;

    // prune sources whose group has left the scene (sunk/despawned ships) so
    // they don't leak in _wakeSources/_wakeLast forever
    for (let i = sources.length - 1; i >= 0; i--) {
      const s = sources[i];
      if (!s || s.parent === null) {
        this._wakeLast.delete(s);
        sources.splice(i, 1);
      }
    }

    // drop stamps along each source's path since its last drop
    for (const obj of sources) {
      const pos = obj?.position;
      if (!pos) continue;
      const px = pos.x, pz = pos.z;
      const last = this._wakeLast.get(obj);
      if (!last) {
        this._wakeLast.set(obj, { x: px, z: pz });
        continue;
      }
      const dx = px - last.x, dz = pz - last.z;
      const moved = Math.hypot(dx, dz);
      if (moved >= WAKE_DROP) {
        const steps = Math.min(4, Math.floor(moved / WAKE_DROP));
        for (let s = 1; s <= steps; s++) {
          const f = s / steps;
          this._emitWake(last.x + dx * f, last.z + dz * f);
        }
        last.x = px; last.z = pz;
      }
    }

    // repaint the foam mask from world-space stamps (no smear as the camera moves)
    const cam = this.ctx.camera.position;
    const ox = cam.x - WAKE_SIZE * 0.5;
    const oz = cam.z - WAKE_SIZE * 0.5;
    this.uniforms.uWakeOrigin.value.set(ox, oz);
    this._paintWake(ox, oz);
    this.uniforms.uWakeStrength.value = 1.0;
  }

  _paintWake(ox, oz) {
    const data = this._wakeData;
    data.fill(0);
    const res = WAKE_RES;
    const invSize = res / WAKE_SIZE;
    for (let i = 0; i < WAKE_CAP; i++) {
      const age = this._wakeAge[i];
      if (age >= WAKE_LIFE) continue;
      const lifeT = 1 - age / WAKE_LIFE;      // 1 fresh → 0 gone
      const tx = (this._wakeX[i] - ox) * invSize;
      const tz = (this._wakeZ[i] - oz) * invSize;
      const rad = 2.2 + (1 - lifeT) * 4.8;    // wake spreads as it dissipates
      if (tx < -rad || tx > res + rad || tz < -rad || tz > res + rad) continue;
      const rad2 = rad * rad;
      const peak = Math.pow(lifeT, 0.7) * 236;
      const r0 = Math.max(0, Math.floor(tx - rad));
      const r1 = Math.min(res - 1, Math.ceil(tx + rad));
      const c0 = Math.max(0, Math.floor(tz - rad));
      const c1 = Math.min(res - 1, Math.ceil(tz + rad));
      for (let yy = c0; yy <= c1; yy++) {
        const dzz = yy - tz;
        const row = yy * res;
        for (let xx = r0; xx <= r1; xx++) {
          const dxx = xx - tx;
          const d2 = dxx * dxx + dzz * dzz;
          if (d2 > rad2) continue;
          const fall = 1 - d2 / rad2;
          const v = peak * fall * fall;
          const idx = row + xx;
          const nv = data[idx] + v;
          data[idx] = nv > 255 ? 255 : nv;
        }
      }
    }
    this._wakeTex.needsUpdate = true;
  }

  update(dt) {
    const { camera, time, sky, weather } = this.ctx;
    this.seaState = damp(this.seaState, this._targetSeaState, 0.35, dt);

    const u = this.uniforms;
    u.uTime.value = time.t;
    u.uAmp.value = seaStateScale(this.seaState);
    u.uSeaState.value = this.seaState;
    u.uCamPos.value.copy(camera.position);
    u.uStormMix.value = clamp01((this.seaState - 0.45) / 0.55);

    // wind drives the ripple scroll direction & choppiness
    const wind = weather?.wind;
    if (wind) {
      const wx = Math.sin(wind.angle), wz = Math.cos(wind.angle);
      this._windDir.set(wx, wz);
      u.uWindDir.value.set(wx, wz);
      u.uWindSpeed.value = wind.speed ?? 8;
    }

    // follow the camera in whole grid cells so vertices don't swim
    const cs = this._cellSize;
    this.nearMesh.position.x = Math.round(camera.position.x / cs) * cs;
    this.nearMesh.position.z = Math.round(camera.position.z / cs) * cs;
    this.farMesh.position.x = camera.position.x;
    this.farMesh.position.z = camera.position.z;

    // track sky for lighting/reflection colors
    const sunDir = sky?.sunDir ?? this._sunDirFallback;
    u.uSunDir.value.copy(sunDir);
    const elev = clamp01((sunDir.y + 0.08) / 0.5);
    u.uNight.value = 1 - clamp01((sunDir.y + 0.12) / 0.22);
    if (sky?.colors) {
      u.uSkyZenith.value.copy(sky.colors.zenith);
      u.uSkyHorizon.value.copy(sky.colors.horizon);
      u.uSunColor.value.copy(sky.colors.sun);
    } else {
      u.uSkyZenith.value.setHSL(0.58, 0.55, lerp(0.08, 0.32, elev));
      u.uSkyHorizon.value.setHSL(0.09, lerp(0.1, 0.45, 1 - elev), lerp(0.1, 0.72, elev));
      u.uSunColor.value.setHSL(0.09, lerp(0.7, 0.25, elev), lerp(0.55, 0.92, elev));
    }
    const fog = this.ctx.scene.fog;
    if (fog) {
      u.uFogColor.value.copy(fog.color);
      u.uFogDensity.value = fog.density ?? 0.00006;
    }

    if (this.ctx.mode !== 'menu') this._updateWake(dt);
  }
}
