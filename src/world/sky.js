// Sky dome, sun/moon, stars, lighting rig, and fog — the day/night engine.
// Physically-inspired scattering: Rayleigh-ish blue zenith, Mie-ish warm sun
// halo, directional golden-hour horizon, deep night with stars + milky way band
// + soft-glow moon, and a bloomable HDR sun disc.
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
uniform vec3 uMoonColor;
uniform vec3 uSunDir;
uniform vec3 uMoonDir;
uniform float uNight;   // 0 day .. 1 night
uniform float uGloom;   // weather overcast/storm 0..1
uniform float uFlash;   // lightning 0..1
uniform float uSunI;    // 0..1 daytime sun strength (for halos/rays)
uniform float uTime;    // seconds, for twinkle + ray drift
varying vec3 vDir;

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float hash13(vec3 p) {
  p = fract(p * 0.1031);
  p += dot(p, p.yzx + 31.32);
  return fract((p.x + p.y) * p.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  float a = hash12(i), b = hash12(i + vec2(1.0, 0.0));
  float c = hash12(i + vec2(0.0, 1.0)), d = hash12(i + vec2(1.0, 1.0));
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}

// round twinkling stars, one candidate per cubic cell
float starField(vec3 dir, float scale, float thr) {
  vec3 p = dir * scale;
  vec3 id = floor(p);
  vec3 f = fract(p);
  float r = hash13(id + 0.5);
  if (r < thr) return 0.0;
  vec3 sp = vec3(hash13(id + 11.3), hash13(id + 27.1), hash13(id + 41.7));
  float dd = length(f - sp);
  float bright = (r - thr) / (1.0 - thr);
  float tw = 0.55 + 0.45 * sin(uTime * (1.4 + bright * 3.0) + r * 43.0);
  return (1.0 - smoothstep(0.0, 0.12, dd)) * bright * tw;
}

void main() {
  vec3 dir = normalize(vDir);
  float h = dir.y;
  float hz = clamp(h, 0.0, 1.0);

  // --- base atmosphere gradient (Rayleigh-ish falloff toward the horizon) ---
  float grad = pow(1.0 - hz, 2.4);
  vec3 col = mix(uZenith, uHorizon, grad);

  // pale aerial-perspective haze hugging the horizon
  float haze = 1.0 - smoothstep(-0.03, 0.16, h);
  col = mix(col, uHorizon * 1.05 + 0.015, haze * 0.5);

  // below the horizon: settle into a darker sea haze
  if (h < 0.0) col = mix(col, uHorizon * 0.5, clamp(-h * 3.5, 0.0, 1.0));

  // horizontal bearing toward the sun (for directional golden hour)
  vec2 dh = dir.xz; float dhl = length(dh);
  vec2 sh = uSunDir.xz; float shl = length(sh);
  float az = (dhl > 1e-4 && shl > 1e-4) ? dot(dh / dhl, sh / shl) : 0.0;

  // --- directional dawn/dusk warmth: apricot->rose toward the low sun ---
  float lowSun = 1.0 - smoothstep(-0.06, 0.30, uSunDir.y);
  float hband = (1.0 - smoothstep(-0.06, 0.58, h)) * smoothstep(-0.35, 1.0, az);
  col += uSunColor * hband * lowSun * 0.55 * (1.0 - uGloom * 0.8) * (1.0 - uNight * 0.6);

  // --- Mie forward-scatter sun halo (broad warm bloom around the disc) ---
  float sd = dot(dir, uSunDir);
  float halo = pow(max(sd, 0.0), 5.0) * 0.20 + pow(max(sd, 0.0), 55.0) * 0.5;
  col += uSunColor * halo * uSunI * (1.0 - uGloom * 0.85);

  // cheap crepuscular-ray hint: soft radial streaks fanning from the sun
  float rays = pow(max(sd, 0.0), 4.0);
  float rn = 0.5 + 0.5 * sin(atan(dir.x, dir.z) * 34.0 + uTime * 0.22);
  col += uSunColor * rays * rn * 0.045 * uSunI * (1.0 - uNight);

  // --- sun disc (HDR, feeds bloom) ---
  float disc = smoothstep(0.99963, 0.99987, sd);
  col += uSunColor * disc * 7.0 * (1.0 - uNight) * (1.0 - uGloom * 0.92);

  // --- night: stars, milky-way band, glowing moon ---
  if (uNight > 0.01) {
    float up = smoothstep(-0.02, 0.18, h);
    float clarity = uNight * (1.0 - uGloom) * up;

    // milky way: a soft mottled band along a fixed great circle
    vec3 mwAxis = normalize(vec3(0.66, 0.30, -0.70));
    float band = abs(dot(dir, mwAxis));
    float mw = 1.0 - smoothstep(0.0, 0.30, band);
    float mwTex = vnoise(dir.xz * 8.0 + dir.y * 5.0) * 0.6 + vnoise(dir.xz * 21.0) * 0.4;
    col += vec3(0.32, 0.38, 0.60) * mw * mwTex * clarity * 0.55;

    // two star densities for depth
    float s = starField(dir, 250.0, 0.855) + starField(dir, 125.0, 0.925) * 1.5;
    col += vec3(0.9, 0.94, 1.0) * s * clarity * 1.25;

    // moon: soft outer glow, tight core disc, faint mare mottling
    float md = dot(dir, uMoonDir);
    float moonGlow = pow(max(md, 0.0), 240.0) * 0.6 + pow(max(md, 0.0), 7.0) * 0.045;
    float moonDisc = smoothstep(0.99953, 0.99975, md);
    float mare = 0.82 + 0.18 * vnoise(dir.xz * 320.0 + dir.y * 120.0);
    col += uMoonColor * (moonDisc * 2.6 * mare + moonGlow) * uNight * (1.0 - uGloom * 0.9);
  }

  // --- storm gloom: flatten everything toward a bruised slate ---
  vec3 slate = mix(vec3(0.30, 0.33, 0.39), vec3(0.09, 0.10, 0.14), pow(hz, 0.5));
  col = mix(col, slate * (1.0 - uNight * 0.82), uGloom * 0.8);

  // lightning flash
  col += vec3(0.85, 0.9, 1.0) * uFlash;

  // ordered-ish dither to kill 8-bit gradient banding
  col += (hash12(gl_FragCoord.xy) - 0.5) / 255.0;

  gl_FragColor = vec4(max(col, 0.0), 1.0);
}
`;

// color keyframes by sun elevation (e = sunDir.y)
//   e,       zenith,   horizon,  sun,      sunLight, hemiSky,  hemiGround
const STOPS = [
  [-0.35, 0x05070e, 0x0a0e1a, 0x000000, 0x000000, 0x1b2740, 0x0d0f16],
  [-0.16, 0x0c1226, 0x2a2338, 0x1a1018, 0x000000, 0x2a3350, 0x14141c],
  [-0.04, 0x1c2b50, 0xb15a3e, 0xff7038, 0x241612, 0x3a4767, 0x241a18],
  [0.03, 0x28477a, 0xe3814a, 0xffa25a, 0xffab63, 0x51618a, 0x322820],
  [0.10, 0x2f65a0, 0xf3b479, 0xffd39a, 0xffca8e, 0x6a83ab, 0x40382a],
  [0.28, 0x2f74b6, 0xcadfe6, 0xfff0d2, 0xfff2da, 0x86a6c8, 0x4c4a3e],
  [0.70, 0x2f7ac6, 0xc4dcec, 0xfff6e6, 0xffffff, 0x9ab8d6, 0x585444],
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
      zenith: new THREE.Color(0x2f74b6),
      horizon: new THREE.Color(0xcadfe6),
      sun: new THREE.Color(0xfff0d2),
    };
    this.moonColor = new THREE.Color(0xbcc8de);
    this.flash = 0; // set by weather lightning

    this.uniforms = {
      uZenith: { value: this.colors.zenith },
      uHorizon: { value: this.colors.horizon },
      uSunColor: { value: this.colors.sun },
      uMoonColor: { value: this.moonColor },
      uSunDir: { value: this.sunDir },
      uMoonDir: { value: this.moonDir },
      uNight: { value: 0 },
      uGloom: { value: 0 },
      uFlash: { value: 0 },
      uSunI: { value: 1 },
      uTime: { value: 0 },
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
    // moon rides roughly opposite the sun, nudged off-axis so it isn't a mirror
    this.moonDir.copy(this.sunDir).multiplyScalar(-1);
    this.moonDir.x += 0.18; this.moonDir.y += 0.05; this.moonDir.normalize();

    const e = this.sunDir.y;
    const gloom = clamp01(weather?.gloom ?? 0);
    const night = 1 - clamp01((e + 0.12) / 0.22);
    const sunI = clamp01((e + 0.03) / 0.22);

    sampleStops(e, 1, this.colors.zenith);
    sampleStops(e, 2, this.colors.horizon);
    sampleStops(e, 3, this.colors.sun);

    const u = this.uniforms;
    u.uNight.value = night;
    u.uGloom.value = gloom;
    u.uSunI.value = sunI;
    u.uTime.value = time.t;
    this.flash = Math.max(0, this.flash - dt * 6);
    u.uFlash.value = this.flash;

    // dome follows camera
    this.dome.position.copy(camera.position);

    // sun light — warm color ramp, intensity by elevation, dimmed by gloom
    sampleStops(e, 4, this.sunLight.color);
    const sunLI = clamp01((e + 0.04) / 0.2) * 2.6 * (1 - gloom * 0.85);
    this.sunLight.intensity = sunLI;
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

    // fog tracks horizon color; weather sets density via this.fogDensity target
    const fog = this.ctx.scene.fog;
    fog.color.copy(this.colors.horizon).lerp(_tmpColor.setHex(0x39424b), gloom * 0.6);
    const targetDensity = weather?.fogDensity ?? this.baseFogDensity;
    fog.density = lerp(fog.density, targetDensity, Math.min(1, dt * 0.5));

    this.clouds.update(dt);
  }
}
