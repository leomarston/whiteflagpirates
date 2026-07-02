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

export class Ocean {
  constructor(ctx) {
    this.ctx = ctx;
    this.seaState = 0.3;
    this._targetSeaState = 0.3;
    this._scratchN = new THREE.Vector3();
    this._sunDirFallback = new THREE.Vector3(0.35, 0.75, 0.45).normalize();

    const waves = buildWaveUniforms();
    const detail = ctx.engine?.qualityProfile?.oceanDetail ?? 1;
    const segs = Math.max(96, Math.round(232 * detail));

    this.uniforms = {
      uTime: { value: 0 },
      uAmp: { value: seaStateScale(this.seaState) },
      uWaveDir: { value: waves.dirs },
      uWaveK: { value: waves.ks },
      uWaveC: { value: waves.cs },
      uWaveA: { value: waves.as },
      uShoreTex: { value: this._buildShoreTexture() },
      uWorldSize: { value: WORLD.SEA_SIZE },
      uDeepColor: { value: new THREE.Color(COLORS.deepWater) },
      uShallowColor: { value: new THREE.Color(COLORS.shallowWater) },
      uFoamColor: { value: new THREE.Color(COLORS.foam) },
      uSkyZenith: { value: new THREE.Color(0x2b5d8a) },
      uSkyHorizon: { value: new THREE.Color(0xbdd3dd) },
      uSunDir: { value: this._sunDirFallback.clone() },
      uSunColor: { value: new THREE.Color(0xfff2d8) },
      uNight: { value: 0 },
      uNoiseTex: { value: this._buildNoiseTexture() },
      uCamPos: { value: new THREE.Vector3() },
      uFogColor: { value: new THREE.Color(0xbdd3dd) },
      uFogDensity: { value: 0.00006 },
      uStormMix: { value: 0 },
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

    const farGeo = new THREE.RingGeometry(NEAR_SIZE / 2 - 24, FAR_RADIUS, 96, 6);
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

  update(dt) {
    const { camera, time, sky } = this.ctx;
    this.seaState = damp(this.seaState, this._targetSeaState, 0.35, dt);

    const u = this.uniforms;
    u.uTime.value = time.t;
    u.uAmp.value = seaStateScale(this.seaState);
    u.uCamPos.value.copy(camera.position);
    u.uStormMix.value = clamp01((this.seaState - 0.45) / 0.55);

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
  }
}
