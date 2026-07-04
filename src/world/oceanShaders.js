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
uniform float uTotalAmp;            // sum of base amplitudes (meters)
uniform sampler2D uShoreTex;        // R: shore proximity 0(open sea)..1(land)
uniform float uWorldSize;           // full extent covered by uShoreTex
uniform vec3 uCamPos;

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vShore;
varying float vCrest;
varying float vFold;                // Gerstner Jacobian — crest folding for foam
varying float vFogDepth;
varying float vDist;

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
  vCrest = disp.y / max(uAmp * uTotalAmp, 1e-4); // ≈ [-1, 1]

  // Horizontal Gerstner Jacobian: where crests pinch the surface folds and
  // whitecaps break. tang.x = 1+dDx/dx, binorm.z = 1+dDz/dz, binorm.x = dDx/dz.
  float detJ = tang.x * binorm.z - binorm.x * binorm.x;
  vFold = 1.0 - detJ; // grows as the crest sharpens/overturns

  wp.xyz += disp;
  vWorldPos = wp.xyz;
  vDist = distance(uCamPos, wp.xyz);
  vec4 mv = viewMatrix * wp;
  vFogDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

export const oceanFragment = /* glsl */ `
precision highp float;

uniform vec3 uDeepColor;
uniform vec3 uShallowColor;
uniform vec3 uShoreColor;           // bright turquoise right at the coast
uniform vec3 uFoamColor;
uniform vec3 uSSSColor;             // subsurface back-scatter tint
uniform vec3 uSkyZenith;
uniform vec3 uSkyHorizon;
uniform vec3 uSunDir;
uniform vec3 uSunColor;
uniform float uNight;               // 0 day .. 1 deep night
uniform float uTime;
uniform float uAmp;
uniform float uSeaState;            // current smoothed sea state 0..1
uniform sampler2D uNoiseTex;        // decorrelated scalar noise (foam breakup)
uniform sampler2D uNormalTex;       // tileable ripple normal map (xy slope, z up)
uniform vec2 uWindDir;              // unit wind direction (xz)
uniform float uWindSpeed;           // m/s
uniform vec3 uCamPos;
uniform vec3 uFogColor;
uniform float uFogDensity;
uniform float uStormMix;            // 0 calm .. 1 storm (desaturate/darken)
uniform sampler2D uWakeTex;         // ship wake foam mask (R)
uniform vec2 uWakeOrigin;           // world XZ of wake window corner
uniform float uWakeSize;            // wake window extent (m)
uniform float uWakeStrength;        // 0 disabled

varying vec3 vWorldPos;
varying vec3 vNormal;
varying float vShore;
varying float vCrest;
varying float vFold;
varying float vFogDepth;
varying float vDist;

// Three scrolling octaves of the ripple normal, driven along/across the wind.
vec2 detailSlope(vec2 p, float choppy) {
  vec2 w = uWindDir;
  vec2 cw = vec2(-w.y, w.x);
  vec2 a = texture2D(uNormalTex, p * 0.021 + w * uTime * 0.011).xy * 2.0 - 1.0;
  vec2 b = texture2D(uNormalTex, p * 0.055 - w * uTime * 0.021 + 0.37).xy * 2.0 - 1.0;
  vec2 c = texture2D(uNormalTex, p * 0.140 + cw * uTime * 0.034 + 0.71).xy * 2.0 - 1.0;
  return (a * 0.90 + b * 0.60 + c * 0.38) * choppy;
}

void main() {
  vec3 V = normalize(uCamPos - vWorldPos);

  // --- surface normal: geometric Gerstner normal + layered detail ripple ----
  vec3 N = vNormal;
  float detailFade = 1.0 - smoothstep(220.0, 3400.0, vDist);
  detailFade *= (1.0 - vShore * 0.55);
  if (detailFade > 0.002) {
    float choppy = (0.28 + uSeaState * 0.95 + uWindSpeed * 0.018);
    vec2 slope = detailSlope(vWorldPos.xz, choppy);
    N = normalize(vNormal + vec3(slope.x, 0.0, slope.y) * detailFade * 0.85);
  }

  float NdV = max(dot(N, V), 0.0);
  float fresnel = 0.02 + 0.98 * pow(1.0 - NdV, 5.0);

  // --- sky reflection: sample the real sky gradient along the reflection ray -
  vec3 R = reflect(-V, N);
  float upness = clamp(R.y, 0.0, 1.0);
  vec3 skyRefl = mix(uSkyHorizon, uSkyZenith, pow(upness, 0.55));
  // warm the reflected horizon toward the sun for golden-hour glow
  float sunAz = max(dot(normalize(R.xz + 1e-5), normalize(uSunDir.xz + 1e-5)), 0.0);
  skyRefl = mix(skyRefl, uSunColor, pow(sunAz, 6.0) * (1.0 - upness) * (1.0 - uNight) * 0.35);

  // --- water body: depth gradient + painterly variation + sky ambient -------
  float shoreG = smoothstep(0.08, 0.62, vShore);
  vec3 body = mix(uDeepColor, uShallowColor, shoreG);
  body = mix(body, uShoreColor, smoothstep(0.6, 0.96, vShore));
  float variation = texture2D(uNoiseTex, vWorldPos.xz * 0.0016 + uTime * 0.002).r;
  body *= 0.88 + variation * 0.24;
  body += uSkyHorizon * 0.05 * (1.0 - uNight);

  // subsurface back-scatter: crests glow when a low sun sits behind them
  vec3 sflat = normalize(vec3(uSunDir.x, 0.18, uSunDir.z));
  float lowSun = 1.0 - smoothstep(0.0, 0.42, uSunDir.y);
  float sss = pow(max(dot(V, -sflat), 0.0), 3.0) * max(vCrest, 0.0) * lowSun * (1.0 - uNight);
  body += uSSSColor * sss * 0.85;

  // storm mood mutes the body toward cold slate
  body = mix(body, body * vec3(0.52, 0.60, 0.66) + vec3(0.010, 0.014, 0.018), uStormMix * 0.5);
  skyRefl = mix(skyRefl, skyRefl * vec3(0.60, 0.66, 0.72), uStormMix * 0.4);

  float reflStrength = 1.0 - uStormMix * 0.25;
  vec3 col = mix(body, skyRefl, fresnel * reflStrength);

  // --- sun specular: tight glitter lobe + broad sheen (rougher in a storm) ---
  float rough = clamp(uStormMix * 0.7 + uSeaState * 0.25, 0.0, 1.0);
  vec3 H = normalize(V + uSunDir);
  float NdH = max(dot(N, H), 0.0);
  float glint = pow(NdH, mix(900.0, 160.0, rough));
  float sheen = pow(NdH, mix(46.0, 22.0, rough));
  float sunVis = (1.0 - uNight) * (1.0 - uStormMix * 0.65) * smoothstep(-0.06, 0.12, uSunDir.y);
  col += uSunColor * (glint * 3.4 + sheen * 0.14) * sunVis;

  // --- foam: breaking crests (Jacobian + height) and shoreline surf ---------
  vec3 fn = texture2D(uNoiseTex, vWorldPos.xz * 0.028 + vec2(uTime * 0.014, -uTime * 0.011)).rgb;
  float foldFoam = smoothstep(0.34, 1.05, vFold * (0.65 + uSeaState * 1.5));
  float tipFoam = smoothstep(0.52, 1.0, vCrest * (0.5 + 0.85 * uSeaState));
  float crestFoam = max(foldFoam, tipFoam * 0.8) * smoothstep(0.24, 0.78, fn.r);
  crestFoam = clamp(crestFoam * (0.7 + uSeaState * 0.7), 0.0, 1.0);

  // rolling surf bands that march shoreward and pulse, plus a static waterline
  float band = sin(vShore * 34.0 - uTime * 2.2) * 0.5 + 0.5;
  band *= band;
  float shoreFoam = smoothstep(0.44, 0.86, vShore) * band * smoothstep(0.2, 0.72, fn.g);
  shoreFoam += smoothstep(0.84, 1.0, vShore) * smoothstep(0.32, 0.7, fn.b) * 0.9;

  // ship wake foam (world-anchored mask around the camera)
  float wake = 0.0;
  if (uWakeStrength > 0.0) {
    vec2 wuv = (vWorldPos.xz - uWakeOrigin) / uWakeSize;
    if (wuv.x > 0.0 && wuv.x < 1.0 && wuv.y > 0.0 && wuv.y < 1.0) {
      float wm = texture2D(uWakeTex, wuv).r * uWakeStrength;
      wake = smoothstep(0.05, 0.55, wm) * (0.55 + fn.b * 0.5);
    }
  }

  float foam = clamp(max(max(crestFoam, shoreFoam), wake), 0.0, 1.0);
  vec3 foamCol = uFoamColor * (1.0 - uNight * 0.7) * (1.0 - uStormMix * 0.14);
  col = mix(col, foamCol, foam * 0.9);

  // --- night dimming, atmospheric haze, exp2 fog into the horizon -----------
  col *= (1.0 - uNight * 0.8);

  float haze = smoothstep(2600.0, 11000.0, vDist) * (0.32 + uStormMix * 0.4 + uNight * 0.2);
  col = mix(col, uFogColor, clamp(haze, 0.0, 1.0));

  float fogF = 1.0 - exp(-uFogDensity * uFogDensity * vFogDepth * vFogDepth);
  col = mix(col, uFogColor, clamp(fogF, 0.0, 1.0));

  gl_FragColor = vec4(col, 1.0);
}
`;
