// Sky dome, sun/moon, stars, lighting rig, and fog — the day/night engine.
import * as THREE from 'three';
import { clamp01, lerp } from '../core/utils.js';
import { Clouds } from './clouds.js';

const DOME_RADIUS = 14500;

const skyVertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w * 0.99999; // pin to far plane
}
`;

const skyFragment = /* glsl */ `
precision highp float;
uniform vec3 uZenith;
uniform vec3 uHorizon;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uNight;   // 0 day .. 1 night
uniform float uGloom;   // weather overcast/storm 0..1
uniform float uFlash;   // lightning 0..1
varying vec3 vDir;

float hash(vec3 p) {
  p = fract(p * vec3(443.897, 441.423, 437.195));
  p += dot(p, p.yzx + 19.19);
  return fract((p.x + p.y) * p.z);
}

void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;

  // vertical gradient with haze compression at the horizon
  float t = pow(clamp(h, 0.0, 1.0), 0.42);
  vec3 col = mix(uHorizon, uZenith, t);
  if (h < 0.0) col = mix(uHorizon, uHorizon * 0.55, clamp(-h * 4.0, 0.0, 1.0));

  // sun disc + glow
  float d = dot(dir, uSunDir);
  float disc = smoothstep(0.99955, 0.99985, d);
  float glow = pow(max(d, 0.0), 160.0) * 0.9 + pow(max(d, 0.0), 9.0) * 0.16;
  col += uSunColor * (disc * 2.6 + glow) * (1.0 - uNight) * (1.0 - uGloom * 0.85);

  // moon (cool, small) + halo
  float md = dot(dir, uMoonDir);
  float moonDisc = smoothstep(0.99975, 0.99991, md);
  float moonGlow = pow(max(md, 0.0), 300.0) * 0.5;
  col += vec3(0.82, 0.88, 0.98) * (moonDisc * 1.4 + moonGlow) * uNight * (1.0 - uGloom * 0.9);

  // stars
  if (uNight > 0.02 && h > 0.0) {
    vec3 sp = floor(dir * 420.0);
    float star = step(0.9988, hash(sp));
    float tw = 0.6 + 0.4 * hash(sp + 7.0);
    col += vec3(0.9, 0.94, 1.0) * star * tw * uNight * smoothstep(0.02, 0.2, h) * (1.0 - uGloom);
  }

  // storm gloom flattens everything toward a bruised slate; darker overhead
  vec3 slate = mix(vec3(0.30, 0.33, 0.38), vec3(0.10, 0.12, 0.16), pow(clamp(h, 0.0, 1.0), 0.5));
  col = mix(col, slate * (1.0 - uNight * 0.85), uGloom * 0.82);
  // lightning flash
  col += vec3(0.85, 0.9, 1.0) * uFlash;

  gl_FragColor = vec4(col, 1.0);
}
`;

// color keyframes by sun elevation
const STOPS = [
  // e,      zenith,    horizon,   sun,       sunLight,  hemiSky,   hemiGround
  [-0.30, 0x04070f, 0x0a1120, 0x000000, 0x000000, 0x2a3a58, 0x14161e],
  [-0.12, 0x0a1226, 0x1c2338, 0x201008, 0x000000, 0x38445e, 0x181a22],
  [0.00, 0x1c2f55, 0xd96a3a, 0xff9a55, 0xff9a55, 0x2c3a5c, 0x1a1410],
  [0.10, 0x2c5586, 0xf5b06a, 0xffd9a0, 0xffc98a, 0x4a628c, 0x2c2820],
  [0.35, 0x336fae, 0xc8dfe8, 0xfff0cd, 0xfff0d8, 0x7d9cc0, 0x4a4a40],
  [0.75, 0x3877b8, 0xcfe3ea, 0xfff4d8, 0xffffff, 0x8fb0d0, 0x555548],
];

function sampleStops(e, idx, out) {
  let a = STOPS[0], b = STOPS[STOPS.length - 1];
  for (let i = 0; i < STOPS.length - 1; i++) {
    if (e >= STOPS[i][0] && e <= STOPS[i + 1][0]) { a = STOPS[i]; b = STOPS[i + 1]; break; }
  }
  if (e < STOPS[0][0]) { out.setHex(STOPS[0][idx]); return out; }
  if (e > STOPS[STOPS.length - 1][0]) { out.setHex(STOPS[STOPS.length - 1][idx]); return out; }
  const t = (e - a[0]) / Math.max(b[0] - a[0], 1e-5);
  return out.setHex(a[idx]).lerp(_tmpColor.setHex(b[idx]), t);
}

const _tmpColor = new THREE.Color();

export class Sky {
  constructor(ctx) {
    this.ctx = ctx;
    this.sunDir = new THREE.Vector3(0, 1, 0);
    this.moonDir = new THREE.Vector3(0, -1, 0);
    this.colors = {
      zenith: new THREE.Color(0x3877b8),
      horizon: new THREE.Color(0xcfe3ea),
      sun: new THREE.Color(0xfff4d8),
    };
    this.flash = 0; // set by weather lightning

    this.uniforms = {
      uZenith: { value: this.colors.zenith },
      uHorizon: { value: this.colors.horizon },
      uSunColor: { value: this.colors.sun },
      uSunDir: { value: this.sunDir },
      uMoonDir: { value: this.moonDir },
      uNight: { value: 0 },
      uGloom: { value: 0 },
      uFlash: { value: 0 },
    };

    const geo = new THREE.SphereGeometry(DOME_RADIUS, 48, 24);
    const mat = new THREE.ShaderMaterial({
      vertexShader: skyVertex,
      fragmentShader: skyFragment,
      uniforms: this.uniforms,
      side: THREE.BackSide,
      depthWrite: false,
      fog: false,
    });
    this.dome = new THREE.Mesh(geo, mat);
    this.dome.frustumCulled = false;
    this.dome.renderOrder = -10;
    ctx.scene.add(this.dome);

    // lighting rig
    this.sunLight = new THREE.DirectionalLight(0xffffff, 2.2);
    this.sunLight.castShadow = ctx.engine?.qualityProfile?.shadows ?? true;
    const sh = this.sunLight.shadow;
    sh.mapSize.setScalar(ctx.engine?.qualityProfile?.shadowMapSize ?? 2048);
    sh.camera.near = 10;
    sh.camera.far = 900;
    sh.camera.left = sh.camera.bottom = -240;
    sh.camera.right = sh.camera.top = 240;
    sh.bias = -0.0004;
    sh.normalBias = 0.6;
    ctx.scene.add(this.sunLight);
    ctx.scene.add(this.sunLight.target);

    this.moonLight = new THREE.DirectionalLight(0x9db4d8, 0);
    ctx.scene.add(this.moonLight);
    ctx.scene.add(this.moonLight.target); // else moonlight direction resolves to origin
    this.hemi = new THREE.HemisphereLight(0x8fb0d0, 0x555548, 0.5);
    ctx.scene.add(this.hemi);

    ctx.scene.fog = new THREE.FogExp2(0xcfe3ea, 0.00006);
    this.baseFogDensity = 0.00006;

    this.clouds = new Clouds(ctx);

    ctx.events?.on('quality:change', ({ profile }) => {
      this.sunLight.castShadow = profile.shadows;
      this.sunLight.shadow.mapSize.setScalar(profile.shadowMapSize);
      if (this.sunLight.shadow.map) {
        this.sunLight.shadow.map.dispose();
        this.sunLight.shadow.map = null;
      }
    });
  }

  setCoverage(c) {
    this.clouds?.setCoverage(c);
  }

  update(dt) {
    const { camera, time, weather } = this.ctx;
    const angle = (time.dayFrac - 0.25) * Math.PI * 2;
    const elevAngle = Math.sin(angle) * (Math.PI / 2) * 0.72;
    const azim = angle * 0.5 + Math.PI * 0.35; // slow crawl across the sky
    const ce = Math.cos(elevAngle);
    this.sunDir.set(ce * Math.sin(azim), Math.sin(elevAngle), ce * Math.cos(azim)).normalize();
    this.moonDir.copy(this.sunDir).multiplyScalar(-1);
    this.moonDir.x += 0.18; this.moonDir.normalize();

    const e = this.sunDir.y;
    const gloom = clamp01(weather?.gloom ?? 0);
    const night = 1 - clamp01((e + 0.12) / 0.22);

    sampleStops(e, 1, this.colors.zenith);
    sampleStops(e, 2, this.colors.horizon);
    sampleStops(e, 3, this.colors.sun);

    // gloom desaturation for lighting colors
    const u = this.uniforms;
    u.uNight.value = night;
    u.uGloom.value = gloom;
    this.flash = Math.max(0, this.flash - dt * 6);
    u.uFlash.value = this.flash;

    // dome follows camera
    this.dome.position.copy(camera.position);

    // sun light
    sampleStops(e, 4, this.sunLight.color);
    const sunI = clamp01((e + 0.04) / 0.2) * 2.6 * (1 - gloom * 0.85);
    this.sunLight.intensity = sunI;
    const target = camera.position;
    this.sunLight.position.copy(target).addScaledVector(this.sunDir, 420);
    this.sunLight.target.position.copy(target);
    this.sunLight.target.updateMatrixWorld();

    // moon light at night — enough to read the world by
    this.moonLight.intensity = night * 0.7 * (1 - gloom * 0.7);
    this.moonLight.position.copy(target).addScaledVector(this.moonDir, 420);
    this.moonLight.target.position.copy(target);
    this.moonLight.target.updateMatrixWorld();

    // hemisphere ambient — keep a cool floor at night so foot travel is legible
    sampleStops(e, 5, this.hemi.color);
    sampleStops(e, 6, this.hemi.groundColor);
    this.hemi.intensity = lerp(0.28, 0.62, clamp01((e + 0.15) / 0.5)) * (1 - gloom * 0.35);

    // fog tracks horizon color; weather sets density via this.fogDensityTarget
    const fog = this.ctx.scene.fog;
    fog.color.copy(this.colors.horizon).lerp(_tmpColor.setHex(0x39424b), gloom * 0.6);
    const targetDensity = weather?.fogDensity ?? this.baseFogDensity;
    fog.density = lerp(fog.density, targetDensity, Math.min(1, dt * 0.5));

    this.clouds.update(dt);
  }
}
