// Cloud deck — two drifting fbm-noise layers that read as volume from below.
import * as THREE from 'three';
import { clamp01, damp, fbm2, SimplexNoise } from '../core/utils.js';

const cloudVertex = /* glsl */ `
varying vec2 vUv;
varying float vFogDepth;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const cloudFragment = /* glsl */ `
precision highp float;
uniform sampler2D uNoise;
uniform float uCoverage;   // 0..1
uniform float uGloom;      // 0..1 storm darkness
uniform vec3 uSunTint;
uniform vec2 uScroll;
uniform float uFade;       // radial fade to horizon
varying vec2 vUv;
varying float vFogDepth;

void main() {
  vec2 uv = vUv * 6.0 + uScroll;
  float n = texture2D(uNoise, uv).r * 0.62
          + texture2D(uNoise, uv * 2.7 + 13.1).r * 0.26
          + texture2D(uNoise, uv * 7.3 + 41.7).r * 0.12;

  float th = mix(0.78, 0.18, uCoverage);
  float a = smoothstep(th, th + 0.3, n);

  // darker, flatter bases as gloom rises
  vec3 bright = uSunTint;
  vec3 dark = mix(vec3(0.55, 0.58, 0.63), vec3(0.16, 0.18, 0.22), uGloom);
  vec3 col = mix(dark, bright, pow(n, 1.6) * (1.0 - uGloom * 0.85));

  // fade at the disc rim so the deck melts into haze
  float rim = 1.0 - smoothstep(0.55, 1.0, length(vUv - 0.5) * 2.0);
  a *= rim * uFade;

  gl_FragColor = vec4(col, a * mix(0.85, 0.98, uGloom));
}
`;

export class Clouds {
  constructor(ctx) {
    this.ctx = ctx;
    this.coverage = 0.3;
    this._target = 0.3;
    this._scroll = new THREE.Vector2();

    const noise = this._buildNoiseTexture();
    this.layers = [];
    const heights = [980, 1350];
    for (let i = 0; i < heights.length; i++) {
      const uniforms = {
        uNoise: { value: noise },
        uCoverage: { value: this.coverage },
        uGloom: { value: 0 },
        uSunTint: { value: new THREE.Color(0xfff4e0) },
        uScroll: { value: new THREE.Vector2(i * 0.37, i * 0.61) },
        uFade: { value: 1 - i * 0.25 },
      };
      const mat = new THREE.ShaderMaterial({
        vertexShader: cloudVertex,
        fragmentShader: cloudFragment,
        uniforms,
        transparent: true,
        depthWrite: false,
        fog: false,
      });
      const geo = new THREE.PlaneGeometry(24000, 24000);
      geo.rotateX(Math.PI / 2); // face downward toward the camera
      const mesh = new THREE.Mesh(geo, mat);
      mesh.position.y = heights[i];
      mesh.renderOrder = -5;
      mesh.frustumCulled = false;
      ctx.scene.add(mesh);
      this.layers.push({ mesh, uniforms, speed: 1 - i * 0.4 });
    }
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
    this.coverage = damp(this.coverage, this._target, 0.25, dt);

    const wind = weather?.wind;
    const wx = (wind?.vector.x ?? 2) * 0.00002;
    const wz = (wind?.vector.z ?? 1) * 0.00002;
    this._scroll.x += wx * dt * 60;
    this._scroll.y += wz * dt * 60;

    const gloom = clamp01(weather?.gloom ?? 0);
    for (const layer of this.layers) {
      layer.mesh.position.x = camera.position.x;
      layer.mesh.position.z = camera.position.z;
      const u = layer.uniforms;
      u.uCoverage.value = this.coverage;
      u.uGloom.value = gloom;
      u.uScroll.value.set(
        layer.uniforms.uScroll.value.x + wx * dt * 60 * layer.speed,
        layer.uniforms.uScroll.value.y + wz * dt * 60 * layer.speed,
      );
      if (sky?.colors) {
        u.uSunTint.value.copy(sky.colors.sun).lerp(sky.colors.horizon, 0.35);
      }
    }
  }
}
