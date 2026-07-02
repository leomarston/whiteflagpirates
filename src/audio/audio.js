// AudioEngine: WebAudio context, buses, ambience beds (all synthesized).
import { clamp, clamp01 } from '../core/utils.js';

export class AudioEngine {
  constructor(ctx) {
    this.ctx = ctx;
    this.ac = null;
    this.ready = false;
    this._buffers = {};

    const unlock = () => {
      if (this.ready) return;
      try {
        this._init();
      } catch (err) {
        console.warn('[audio] init failed', err);
      }
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
  }

  _init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ac = new AC();
    const ac = this.ac;

    this.master = ac.createGain();
    this.master.connect(ac.destination);
    this.sfxBus = ac.createGain();
    this.musicBus = ac.createGain();
    this.ambBus = ac.createGain();
    // gentle lowpass on ambience for warmth; tavern scenes pull it down
    this.ambFilter = ac.createBiquadFilter();
    this.ambFilter.type = 'lowpass';
    this.ambFilter.frequency.value = 20000;
    this.sfxBus.connect(this.master);
    this.musicBus.connect(this.master);
    this.ambBus.connect(this.ambFilter).connect(this.master);

    // simple echo send for booms
    this.echo = ac.createDelay(0.6);
    this.echo.delayTime.value = 0.23;
    this.echoGain = ac.createGain();
    this.echoGain.gain.value = 0.22;
    this.echoFb = ac.createGain();
    this.echoFb.gain.value = 0.3;
    this.echo.connect(this.echoFb).connect(this.echo);
    this.echo.connect(this.echoGain).connect(this.master);

    this.setVolumes(this.ctx.state?.settings ?? {});

    this._buildAmbience();
    this.ready = true;
    if (ac.state === 'suspended') ac.resume();
  }

  setVolumes(s) {
    if (!this.ac) return;
    this.master.gain.value = s.volumeMaster ?? 0.8;
    this.sfxBus.gain.value = s.volumeSfx ?? 0.9;
    this.musicBus.gain.value = s.volumeMusic ?? 0.6;
    this.ambBus.gain.value = (s.volumeSfx ?? 0.9) * 0.8;
  }

  noiseBuffer(kind = 'white') {
    if (this._buffers[kind]) return this._buffers[kind];
    const ac = this.ac;
    const len = ac.sampleRate * 2;
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    if (kind === 'brown') {
      let last = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        last = (last + 0.02 * w) / 1.02;
        data[i] = last * 3.5;
      }
    } else if (kind === 'pink') {
      let b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < len; i++) {
        const w = Math.random() * 2 - 1;
        b0 = 0.997 * b0 + 0.029 * w;
        b1 = 0.985 * b1 + 0.032 * w;
        b2 = 0.95 * b2 + 0.048 * w;
        data[i] = (b0 + b1 + b2 + w * 0.05) * 2;
      }
    } else {
      for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
    }
    this._buffers[kind] = buf;
    return buf;
  }

  _loop(kind, filterType, freq, gain) {
    const ac = this.ac;
    const src = ac.createBufferSource();
    src.buffer = this.noiseBuffer(kind);
    src.loop = true;
    const filter = ac.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = freq;
    const g = ac.createGain();
    g.gain.value = gain;
    src.connect(filter).connect(g).connect(this.ambBus);
    src.start();
    return { src, filter, gain: g };
  }

  _buildAmbience() {
    this.ocean = this._loop('brown', 'lowpass', 420, 0.25);
    this.wind = this._loop('pink', 'bandpass', 600, 0.05);
    this.wind.filter.Q.value = 0.8;
    this.rain = this._loop('white', 'highpass', 1800, 0.0);
  }

  /** Distance/pan for positional one-shots. Returns {gain, pan}. */
  spatial(pos, refDist = 60) {
    if (!pos) return { gain: 1, pan: 0 };
    const cam = this.ctx.camera;
    const dx = pos.x - cam.position.x;
    const dz = pos.z - cam.position.z;
    const dist = Math.hypot(dx, dz, (pos.y ?? 0) - cam.position.y);
    const gain = clamp(refDist / Math.max(dist, refDist * 0.3), 0.02, 1);
    // pan by camera-relative bearing
    const camDir = Math.atan2(
      2 * (cam.quaternion.w * cam.quaternion.y + cam.quaternion.x * cam.quaternion.z),
      1 - 2 * (cam.quaternion.y ** 2 + cam.quaternion.x ** 2),
    );
    const bearing = Math.atan2(dx, dz);
    let rel = bearing - camDir;
    while (rel > Math.PI) rel -= Math.PI * 2;
    while (rel < -Math.PI) rel += Math.PI * 2;
    return { gain, pan: clamp(Math.sin(rel) * -1, -1, 1), dist };
  }

  update(dt) {
    if (!this.ready) return;
    const ac = this.ac;
    const t = ac.currentTime;
    const ctxg = this.ctx;

    // ocean bed follows sea state & where you are
    const sea = ctxg.ocean?.seaState ?? 0.3;
    const inMenu = ctxg.mode === 'menu';
    this.ocean.gain.gain.setTargetAtTime(inMenu ? 0.12 : 0.16 + sea * 0.3, t, 0.5);
    this.ocean.filter.frequency.setTargetAtTime(320 + sea * 480, t, 0.5);

    // wind
    const windSpeed = ctxg.weather?.wind.speed ?? 5;
    this.wind.gain.gain.setTargetAtTime(inMenu ? 0.02 : clamp01((windSpeed - 3) / 14) * 0.22, t, 0.8);
    this.wind.filter.frequency.setTargetAtTime(400 + windSpeed * 55, t, 0.8);

    // rain
    const rainAmt = ctxg.weather?.condition === 'storm' ? 1
      : ctxg.weather?.condition === 'rain' ? 0.65 : 0;
    this.rain.gain.gain.setTargetAtTime(inMenu ? 0 : rainAmt * 0.14, t, 1.2);

    // muffle the world inside screens (tavern/trade)
    const muffled = !!ctxg.ui?.activeScreen && ctxg.ui.activeScreen !== 'map';
    this.ambFilter.frequency.setTargetAtTime(muffled ? 900 : 20000, t, 0.25);
  }
}
