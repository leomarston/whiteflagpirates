// GLSL for the ocean. Wave parameters are passed as uniforms computed from the
// SAME constants as core/utils.js sampleOceanHeight — CPU/GPU must never drift.
import * as THREE from 'three';
import { GERSTNER_WAVES, WORLD } from '../core/constants.js';

export const NUM_WAVES = GERSTNER_WAVES.length;

/** Per-wave uniform data mirroring utils.WAVE_DATA. */
export function buildWaveUniforms() {
  const dirs = [];
  const ks = [];
  const cs = [];
  const as = [];
  for (const w of GERSTNER_WAVES) {
    const len = Math.hypot(w.dir[0], w.dir[1]);
    const k = (Math.PI * 2) / w.wavelength;
    dirs.push(new THREE.Vector2(w.dir[0] / len, w.dir[1] / len));
    ks.push(k);
    cs.push(Math.sqrt(WORLD.GRAVITY / k));
    as.push(w.steepness / k);
  }
  return { dirs, ks, cs, as };
}

export const oceanVertex = /* glsl */ `
uniform float uTime;
uniform float uAmp;                 // seaStateScale — matches CPU
uniform vec2 uWaveDir[${NUM_WAVES}];
uniform float uWaveK[${NUM_WAVES}];
uniform float uWaveC[${NUM_WAVES}];
uniform float uWaveA[${NUM_WAVES}];
uniform sampler2D uShoreTex;        // R: shore proximity 0(open sea)..1(land)
uniform float uWorldSize;           // full extent covered by uShoreTex

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vShore;
varying float vCrest;
varying float vFogDepth;

vec2 shoreUv(vec2 p) { return p / uWorldSize + 0.5; }

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vec2 p = wp.xz;

  float shore = texture2D(uShoreTex, shoreUv(p)).r;
  vShore = shore;
  // waves shrink over shallows so surf hugs the beach instead of clipping it
  float amp = uAmp * (1.0 - shore * 0.72);

  vec3 disp = vec3(0.0);
  vec3 tang = vec3(1.0, 0.0, 0.0);
  vec3 binorm = vec3(0.0, 0.0, 1.0);
  for (int i = 0; i < ${NUM_WAVES}; i++) {
    vec2 d = uWaveDir[i];
    float k = uWaveK[i];
    float a = uWaveA[i] * amp;
    float f = k * (dot(d, p) - uWaveC[i] * uTime);
    float sf = sin(f);
    float cf = cos(f);
    disp += vec3(d.x * a * cf, a * sf, d.y * a * cf);
    float st = k * a; // effective steepness
    tang += vec3(-d.x * d.x * st * sf, d.x * st * cf, -d.x * d.y * st * sf);
    binorm += vec3(-d.x * d.y * st * sf, d.y * st * cf, -d.y * d.y * st * sf);
  }

  vNormal = normalize(cross(binorm, tang));
  vCrest = disp.y / max(uAmp, 1e-4);

  wp.xyz += disp;
  vWorldPos = wp.xyz;
  vec4 mv = viewMatrix * wp;
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

export const oceanFragment = /* glsl */ `
precision highp float;

uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uFoamColor;
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uNight;               // 0 day .. 1 deep night
uniform float uTime;
uniform float uAmp;
uniform sampler2D uNoiseTex;
uniform vec3 uCamPos;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uStormMix;            // 0 calm .. 1 storm (desaturate/darken)

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vShore;
varying float vCrest;
varying float vFogDepth;

void main() {
  vec3 V = normalize(uCamPos - vWorldPos);
  // detail normal from two scrolling noise octaves
  vec2 uv1 = vWorldPos.xz * 0.045 + vec2(uTime * 0.023, uTime * 0.017);
  vec2 uv2 = vWorldPos.xz * 0.011 - vec2(uTime * 0.009, uTime * 0.013);
  vec3 n1 = texture2D(uNoiseTex, uv1).rgb * 2.0 - 1.0;
  vec3 n2 = texture2D(uNoiseTex, uv2).rgb * 2.0 - 1.0;
  vec3 N = normalize(vNormal + vec3(n1.x + n2.x, 0.0, n1.y + n2.y) * 0.22);

  float NdV = max(dot(N, V), 0.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);

  // sky reflection approximation
  vec3 R = reflect(-V, N);
  float upness = clamp(R.y, 0.0, 1.0);
  vec3 skyRefl = mix(uSkyHorizon, uSkyZenith, pow(upness, 0.55));

  // base water body color
  vec3 body = mix(uDeepColor, uShallowColor, smoothstep(0.15, 0.85, vShore));
  // faint subsurface glow through crests against a low sun
  float sunLow = 1.0 - clamp(uSunDir.y * 2.2, 0.0, 1.0);
  float sss = pow(max(dot(V, -normalize(vec3(uSunDir.x, 0.15, uSunDir.z))), 0.0), 3.0)
            * max(vCrest, 0.0) * sunLow * (1.0 - uNight);
  body += uShallowColor * sss * 0.55;

  vec3 col = mix(body, skyRefl, fresnel);

  // sun specular: tight glint + broad sheen
  vec3 H = normalize(V + uSunDir);
  float spec = pow(max(dot(N, H), 0.0), 720.0) * 2.4
             + pow(max(dot(N, H), 0.0), 48.0) * 0.18;
  col += uSunColor * spec * (1.0 - uNight * 0.85) * max(uSunDir.y + 0.03, 0.0) * 4.0;

  // foam: crests + shoreline surf, broken up by noise
  float foamNoise = texture2D(uNoiseTex, vWorldPos.xz * 0.09 + uTime * 0.03).r;
  float crestFoam = smoothstep(0.62, 1.0, vCrest * (0.7 + 0.6 * uStormMix)) *
                    smoothstep(0.35, 0.75, foamNoise);
  float shoreWave = sin(vShore * 26.0 - uTime * 1.7) * 0.5 + 0.5;
  float shoreFoam = smoothstep(0.42, 0.75, vShore) * smoothstep(0.3, 0.9, shoreWave * foamNoise * 1.6);
  float foam = clamp(crestFoam + shoreFoam, 0.0, 1.0);
  col = mix(col, uFoamColor * (1.0 - uNight * 0.75), foam * 0.85);

  // storm mood
  col = mix(col, col * vec3(0.55, 0.62, 0.66) + vec3(0.02), uStormMix * 0.45);
  // night
  col *= (1.0 - uNight * 0.82);

  // exp2 fog
  float fogF = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
  col = mix(col, uFogColor, clamp(fogF, 0.0, 1.0));

  gl_FragColor = vec4(col, 1.0);
}
`;
