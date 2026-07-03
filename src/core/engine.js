// Frozen engine: renderer, cinematic post pipeline, main loop, quality.
// See docs/CONTRACTS.md. Public API: scene, camera, renderer, canvas,
// setQuality, setFov, start(cb), render(), fps, quality, qualityProfile.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { ShaderPass } from 'three/addons/postprocessing/ShaderPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { clamp } from './utils.js';

const QUALITY_PROFILES = {
  low: { pixelRatio: 1, shadows: false, shadowMapSize: 1024, bloom: true, samples: 0, particleScale: 0.5, oceanDetail: 0.5, vegDensity: 0.5, grade: true },
  medium: { pixelRatio: 1.5, shadows: true, shadowMapSize: 1536, bloom: true, samples: 2, particleScale: 0.75, oceanDetail: 0.75, vegDensity: 0.75, grade: true },
  high: { pixelRatio: 2, shadows: true, shadowMapSize: 2048, bloom: true, samples: 4, particleScale: 1, oceanDetail: 1, vegDensity: 1, grade: true },
};

// Cinematic finishing pass (operates on the tonemapped, sRGB display image):
// orange-and-teal grade + soft-clip contrast, unsharp mask, vignette,
// edge chromatic aberration, and a whisper of animated film grain.
const GradeShader = {
  uniforms: {
    tDiffuse: { value: null },
    uTexel: { value: new THREE.Vector2(1 / 1280, 1 / 720) },
    uTime: { value: 0 },
    uVignette: { value: 0.34 },
    uSharpen: { value: 0.35 },
    uAberration: { value: 0.0016 },
    uGrain: { value: 0.035 },
    uSaturation: { value: 1.12 },
    uContrast: { value: 1.06 },
    uLift: { value: new THREE.Color(0.015, 0.028, 0.05) },  // teal shadows
    uGain: { value: new THREE.Color(1.06, 1.02, 0.94) },     // warm highlights
    uEnabled: { value: 1 },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
  `,
  fragmentShader: /* glsl */ `
    precision highp float;
    varying vec2 vUv;
    uniform sampler2D tDiffuse;
    uniform vec2 uTexel;
    uniform float uTime, uVignette, uSharpen, uAberration, uGrain, uSaturation, uContrast, uEnabled;
    uniform vec3 uLift, uGain;

    float hash(vec2 p){ p = fract(p * vec2(443.897, 441.423)); p += dot(p, p.yx + 19.19); return fract((p.x + p.y) * p.z + p.x); }

    void main() {
      vec2 uv = vUv;
      vec2 toC = uv - 0.5;
      float r2 = dot(toC, toC);

      if (uEnabled < 0.5) { gl_FragColor = texture2D(tDiffuse, uv); return; }

      // chromatic aberration — grows toward the edges
      vec2 ca = toC * uAberration * (0.4 + r2 * 3.0);
      vec3 col;
      col.r = texture2D(tDiffuse, uv + ca).r;
      col.g = texture2D(tDiffuse, uv).g;
      col.b = texture2D(tDiffuse, uv - ca).b;

      // unsharp mask (5-tap)
      vec3 blur = texture2D(tDiffuse, uv + vec2(uTexel.x, 0.0)).rgb
                + texture2D(tDiffuse, uv - vec2(uTexel.x, 0.0)).rgb
                + texture2D(tDiffuse, uv + vec2(0.0, uTexel.y)).rgb
                + texture2D(tDiffuse, uv - vec2(0.0, uTexel.y)).rgb;
      blur *= 0.25;
      col += (col - blur) * uSharpen;

      // lift/gain color grade (teal shadows, warm highlights)
      col = col * uGain + uLift * (1.0 - col);

      // contrast around mid grey + saturation
      col = (col - 0.5) * uContrast + 0.5;
      float luma = dot(col, vec3(0.2126, 0.7152, 0.0722));
      col = mix(vec3(luma), col, uSaturation);

      // vignette
      float vig = smoothstep(0.9, 0.25, r2 * (1.0 + uVignette * 2.2));
      col *= mix(1.0, vig, uVignette);

      // film grain
      float g = hash(uv * vec2(1920.0, 1080.0) + fract(uTime) * 91.7) - 0.5;
      col += g * uGrain * (0.6 + 0.8 * (1.0 - luma));

      gl_FragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
    }
  `,
};

export class Engine {
  constructor(container, settings, events) {
    this.events = events;
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({
      antialias: false, // MSAA handled by the composer render target
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.08;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.shadowMap.autoUpdate = true;
    container.appendChild(this.renderer.domElement);
    this.canvas = this.renderer.domElement;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(settings?.fov ?? 60, 1, 0.4, 30000);
    this.camera.position.set(0, 12, 40);

    this.quality = settings?.quality ?? 'high';
    this.qualityProfile = QUALITY_PROFILES[this.quality];
    this.fps = 60;
    this._clock = new THREE.Clock();
    this._t = 0;
    this._samples = -1;

    this._buildComposer();

    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();
    this.setQuality(this.quality);
  }

  _buildComposer() {
    const p = this.qualityProfile;
    const size = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    const target = new THREE.WebGLRenderTarget(Math.max(size.x, 2), Math.max(size.y, 2), {
      type: THREE.HalfFloatType,        // HDR headroom for bloom
      samples: p.samples,               // MSAA — clean rigging/horizon edges
      colorSpace: THREE.NoColorSpace,
    });
    this.composer = new EffectComposer(this.renderer, target);
    this._renderPass = new RenderPass(this.scene, this.camera);
    this._bloomPass = new UnrealBloomPass(new THREE.Vector2(1280, 720), 0.28, 0.7, 0.85);
    this._bloomPass.enabled = p.bloom;
    this._outputPass = new OutputPass(); // tonemap + sRGB encode
    this._gradePass = new ShaderPass(GradeShader);
    this._gradePass.uniforms.uEnabled.value = p.grade ? 1 : 0;

    this.composer.addPass(this._renderPass);
    this.composer.addPass(this._bloomPass);
    this.composer.addPass(this._outputPass);
    this.composer.addPass(this._gradePass);
    this._samples = p.samples;
  }

  setQuality(q) {
    if (!QUALITY_PROFILES[q]) q = 'high';
    this.quality = q;
    const p = (this.qualityProfile = QUALITY_PROFILES[q]);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, p.pixelRatio));
    this.renderer.shadowMap.enabled = p.shadows;
    // MSAA sample count is baked into the render target — rebuild if it changed
    if (p.samples !== this._samples) {
      this.composer?.dispose?.();
      this._buildComposer();
    }
    this._bloomPass.enabled = p.bloom;
    this._gradePass.uniforms.uEnabled.value = p.grade ? 1 : 0;
    this._resize();
    this.events?.emit('quality:change', { quality: q, profile: p });
  }

  setFov(fov) {
    this.camera.fov = clamp(fov, 40, 100);
    this.camera.updateProjectionMatrix();
  }

  _resize() {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h);
    this.composer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    const db = this.renderer.getDrawingBufferSize(new THREE.Vector2());
    this._gradePass?.uniforms.uTexel.value.set(1 / Math.max(db.x, 1), 1 / Math.max(db.y, 1));
    this._bloomPass?.setSize(w, h);
  }

  /** cb(dt) is called every frame with dt clamped to [0, 1/10]. */
  start(cb) {
    this._clock.start();
    this.renderer.setAnimationLoop(() => {
      const dt = clamp(this._clock.getDelta(), 0, 1 / 10);
      this._t += dt;
      this.fps += (1 / Math.max(dt, 1e-4) - this.fps) * 0.05;
      cb(dt);
    });
  }

  render() {
    if (this._gradePass) this._gradePass.uniforms.uTime.value = this._t;
    this.composer.render();
  }
}
