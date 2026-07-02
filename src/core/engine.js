// Frozen engine: renderer, post-processing, main loop, quality. See docs/CONTRACTS.md.
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';
import { clamp } from './utils.js';

const QUALITY_PROFILES = {
  low: { pixelRatio: 1, shadows: false, shadowMapSize: 1024, bloom: false, particleScale: 0.5, oceanDetail: 0.5, vegDensity: 0.5 },
  medium: { pixelRatio: 1.5, shadows: true, shadowMapSize: 1024, bloom: true, particleScale: 0.75, oceanDetail: 0.75, vegDensity: 0.75 },
  high: { pixelRatio: 2, shadows: true, shadowMapSize: 2048, bloom: true, particleScale: 1, oceanDetail: 1, vegDensity: 1 },
};

export class Engine {
  constructor(container, settings, events) {
    this.events = events;
    this.container = container;

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    container.appendChild(this.renderer.domElement);
    this.canvas = this.renderer.domElement;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(
      settings?.fov ?? 60,
      1, 0.4, 30000,
    );
    this.camera.position.set(0, 12, 40);

    this.composer = new EffectComposer(this.renderer);
    this._renderPass = new RenderPass(this.scene, this.camera);
    this._bloomPass = new UnrealBloomPass(new THREE.Vector2(1280, 720), 0.32, 0.55, 0.92);
    this._outputPass = new OutputPass();
    this.composer.addPass(this._renderPass);
    this.composer.addPass(this._bloomPass);
    this.composer.addPass(this._outputPass);

    this.quality = settings?.quality ?? 'high';
    this.qualityProfile = QUALITY_PROFILES[this.quality];
    this.fps = 60;
    this._clock = new THREE.Clock();

    this._resize = this._resize.bind(this);
    window.addEventListener('resize', this._resize);
    this._resize();
    this.setQuality(this.quality);
  }

  setQuality(q) {
    if (!QUALITY_PROFILES[q]) q = 'high';
    this.quality = q;
    const p = (this.qualityProfile = QUALITY_PROFILES[q]);
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, p.pixelRatio));
    this.renderer.shadowMap.enabled = p.shadows;
    this._bloomPass.enabled = p.bloom;
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
  }

  /** cb(dt) is called every frame with dt clamped to [0, 1/15]. */
  start(cb) {
    this._clock.start();
    this.renderer.setAnimationLoop(() => {
      const dt = clamp(this._clock.getDelta(), 0, 1 / 15);
      this.fps += (1 / Math.max(dt, 1e-4) - this.fps) * 0.05;
      cb(dt);
    });
  }

  render() {
    this.composer.render();
  }
}
