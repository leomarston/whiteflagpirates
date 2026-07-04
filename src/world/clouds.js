// Cloud deck — a projected cloud-dome that reads as a volumetric layer from
// below. View rays are cast onto two cloud-height planes (so clouds converge
// to the horizon in true perspective), shaped by multi-octave fbm with domain
// warp, lit with sunward silver-lined edges over shadowed bases, drifting on
// the wind and boiling in storms. One draw call, no per-frame allocation.
import * as THREE from 'three';
import { clamp01, damp, fbm2, SimplexNoise } from '../core/utils.js';

const DOME_RADIUS = 12000;

const cloudVertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
}
`;

const cloudFragment = /* glsl */ `
precision highp float;
uniform sampler2D uNoise;
uniform vec3 uCamPos;
uniform vec3 uSunDir;
uniform vec3 uSunTint;   // warm sunlit / silver-lining color
uniform vec3 uBaseTint;  // shadowed base color (sky-tinted grey)
uniform float uCoverage; // 0..1
uniform float uGloom;    // 0..1 storm darkness
uniform float uNight;    // 0..1
uniform vec2 uWind;      // accumulated wind drift, world meters
uniform float uTime;     // seconds
varying vec3 vDir;

float ntex(vec2 p) { return texture2D(uNoise, p).r; }

// 3-octave fbm in normalized (tiling) space, ~0..1
float fbm3(vec2 p) {
  float f = ntex(p) * 0.5;
  f += ntex(p * 2.03 + 1.7) * 0.3;
  f += ntex(p * 4.11 + 4.3) * 0.2;
  return f;
}

// One cloud layer: project the ray onto a plane at the given height, sample fbm.
vec4 cloudLayer(vec3 dir, float height, float scale, float wDrift,
                float th, float rich) {
  float t = height / max(dir.y, 1e-4);
  vec2 world = uCamPos.xz + dir.xz * t + uWind * wDrift;
  vec2 wp = world * scale;

  // domain warp -> billowy, evolving shapes (churns harder in storms)
  float ev = uTime * (0.003 + uGloom * 0.012);
  vec2 warp = vec2(ntex(wp * 0.55 + ev), ntex(wp * 0.55 + 5.2 - ev)) - 0.5;
  wp += warp * (0.22 + uGloom * 0.14);

  float n = fbm3(wp);
  float a = smoothstep(th, th + 0.20, n);
  if (a <= 0.002) return vec4(0.0);

  // silver lining: peek toward the sun; a thinner neighbour => this edge is lit
  vec2 sdir = normalize(uSunDir.xz + vec2(1e-4, 0.0));
  float nS = rich > 0.5 ? fbm3(wp + sdir * 0.85) : ntex(wp + sdir * 0.85);
  float lit = clamp((n - nS) * 2.6 + 0.28, 0.0, 1.0);

  // dense cores read darker (thick, self-shadowed); edges catch the light
  vec3 shade = mix(uBaseTint, uBaseTint * 0.42, smoothstep(0.5, 0.95, n));
  vec3 col = mix(shade, uSunTint, lit * (1.0 - uGloom * 0.6));

  // night: dark silhouettes with a faint cool moon-lit rim
  col = mix(col, col * 0.16 + vec3(0.05, 0.06, 0.09) * lit, uNight * 0.85);

  // horizon + distance fade so the deck melts into atmospheric haze
  a *= smoothstep(0.015, 0.11, dir.y);
  a *= exp(-t * 0.000024);
  return vec4(col, a);
}

void main() {
  vec3 dir = normalize(vDir);
  if (dir.y < 0.012) discard;

  float thLo = mix(0.60, 0.28, uCoverage);
  float thHi = mix(0.66, 0.36, uCoverage);

  vec4 lo = cloudLayer(dir, 1150.0, 0.00017, 3.0, thLo, 1.0);
  vec4 hi = cloudLayer(dir, 2100.0, 0.00009, 2.0, thHi, 0.0);

  // composite the lower deck over the higher, thinner deck
  vec3 col = mix(hi.rgb, lo.rgb, lo.a);
  float a = lo.a + hi.a * (1.0 - lo.a);
  a *= mix(0.9, 1.0, uGloom);
  if (a <= 0.003) discard;

  gl_FragColor = vec4(col, a);
}
`;

const _grey = new THREE.Color(0x9aa2ad);

export class Clouds {
  constructor(ctx) {
    this.ctx = ctx;
    this.coverage = 0.3;
    this._target = 0.3;
    this._wind = new THREE.Vector2();

    // scratch (no per-frame allocation)
    this._sunTint = new THREE.Color(0xfff2dc);
    this._baseTint = new THREE.Color(0x9aa2ad);

    const noise = this._buildNoiseTexture();
    this.uniforms = {
      uNoise: { value: noise },
      uCamPos: { value: new THREE.Vector3() },
      uSunDir: { value: new THREE.Vector3(0.4, 0.7, 0.5) },
      uSunTint: { value: this._sunTint },
      uBaseTint: { value: this._baseTint },
      uCoverage: { value: this.coverage },
      uGloom: { value: 0 },
      uNight: { value: 0 },
      uWind: { value: this._wind },
      uTime: { value: 0 },
    };

    const mat = new THREE.ShaderMaterial({
      vertexShader: cloudVertex,
      fragmentShader: cloudFragment,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      transparent: true,
      depthWrite: false,
      fog: false,
    });
    const geo = new THREE.SphereGeometry(DOME_RADIUS, 32, 16);
    this.mesh = new THREE.Mesh(geo, mat);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = -5;
    ctx.scene.add(this.mesh);
  }

  _buildNoiseTexture() {
    const size = 256;
    const n = new SimplexNoise(7311);
    const data = new Uint8Array(size * size * 4);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        // torus sampling for seamless tiling
        const a = (x / size) * Math.PI * 2;
        const b = (y / size) * Math.PI * 2;
        const v = fbm2(n, Math.cos(a) * 1.1 + Math.cos(b) * 0.63, Math.sin(a) * 1.1 + Math.sin(b) * 0.63, 4);
        const i = (y * size + x) * 4;
        const g = (v * 0.5 + 0.5) * 255;
        data[i] = data[i + 1] = data[i + 2] = g;
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

  setCoverage(c) {
    this._target = clamp01(c);
  }

  update(dt) {
    const { camera, weather, sky } = this.ctx;
    this.coverage = damp(this.coverage, this._target, 0.4, dt);

    // wind drift accumulates in world meters (gained so it reads at cloud scale)
    const wind = weather?.wind;
    this._wind.x += (wind?.vector.x ?? 3) * dt * 3.0;
    this._wind.y += (wind?.vector.z ?? 1) * dt * 3.0;

    const gloom = clamp01(weather?.gloom ?? 0);
    const sunDir = sky?.sunDir;
    const sunY = sunDir?.y ?? 0.6;
    const night = 1 - clamp01((sunY + 0.12) / 0.22);

    const u = this.uniforms;
    u.uCamPos.value.copy(camera.position);
    u.uCoverage.value = this.coverage;
    u.uGloom.value = gloom;
    u.uNight.value = night;
    u.uTime.value = this.ctx.time?.t ?? 0;
    if (sunDir) u.uSunDir.value.copy(sunDir);

    // keep the cloud dome centred on the camera; projection re-anchors to world
    this.mesh.position.copy(camera.position);

    // shade from the current sky palette
    if (sky?.colors) {
      // warm sunlit tops / silver lining
      this._sunTint.copy(sky.colors.sun).lerp(sky.colors.horizon, 0.28);
      // cool grey shadowed base, darkened as the storm rolls in
      this._baseTint.copy(sky.colors.horizon).lerp(_grey, 0.55).multiplyScalar(1 - gloom * 0.55);
    }
  }
}
