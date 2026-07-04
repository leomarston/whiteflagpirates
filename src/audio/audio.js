// AudioEngine: WebAudio context, buses, and a living layered ambience bed —
// all 100% synthesized (no sample files). Everything crossfades smoothly by
// context: ocean swell + surf hiss follow seaState, wind (with a storm howl)
// follows wind speed, rain layers in, the rigging creaks as she heels, and a
// port murmur / tavern room-tone breathes in as you make landfall.
//
// Public API (do not break): ac, ready, master/sfxBus/musicBus/ambBus/ambFilter,
// echo, setVolumes(s), noiseBuffer(kind), spatial(pos, refDist), update(dt),
// plus sendReverb(node, amt) for the sfx layer.
import { clamp, clamp01, lerp, randRange } from '../core/utils.js';

// smoothing time-constants (seconds) for setTargetAtTime — gentle, no clicks
const TAU_GAIN = 0.6;
const TAU_FILT = 0.7;

export class AudioEngine {
  constructor(ctx) {
    this.ctx = ctx;
    this.ac = null;
    this.ready = false;
    this._buffers = {};
    this.beds = {};

    // ambience scheduling accumulators (drift-free counters, no allocation)
    this._creakT = 3;
    this._clinkT = 4;
    this._sea = 0.3;
    this._portFactor = 0;
    this._portTarget = 0;
    this._portCheckT = 0;
    this._tavernFactor = 0;

    const unlock = () => {
      if (this.ready) return;
      try {
        this._init();
      } catch (err) {
        console.warn('[audio] init failed', err);
      }
      window.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      window.removeEventListener('touchstart', unlock);
    };
    window.addEventListener('pointerdown', unlock);
    window.addEventListener('keydown', unlock);
    window.addEventListener('touchstart', unlock);
  }

  _init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    this.ac = new AC();
    const ac = this.ac;

    // master → a gentle glue limiter → speakers, so stacked cannon booms never
    // clip and the whole mix has a touch of cohesion.
    this.master = ac.createGain();
    this.limiter = ac.createDynamicsCompressor();
    this.limiter.threshold.value = -6;
    this.limiter.knee.value = 6;
    this.limiter.ratio.value = 4;
    this.limiter.attack.value = 0.003;
    this.limiter.release.value = 0.25;
    this.master.connect(this.limiter).connect(ac.destination);

    this.sfxBus = ac.createGain();
    this.musicBus = ac.createGain();
    this.ambBus = ac.createGain();
    // gentle lowpass on ambience for warmth; tavern/screen scenes pull it down,
    // and going underwater slams it shut for a muffled, submerged hush.
    this.ambFilter = ac.createBiquadFilter();
    this.ambFilter.type = 'lowpass';
    this.ambFilter.frequency.value = 20000;
    this.sfxBus.connect(this.master);
    this.musicBus.connect(this.master);
    this.ambBus.connect(this.ambFilter).connect(this.master);

    // --- spatial send: a synthesized convolution reverb (an ocean-air space)
    // gives cannon reports, thunder and bells room to roll out over the water.
    this.reverb = ac.createConvolver();
    this.reverb.buffer = this._buildImpulse(2.0, 2.4);
    this.reverbGain = ac.createGain();
    this.reverbGain.gain.value = 0.55;
    this.reverb.connect(this.reverbGain).connect(this.master);

    // --- classic slap-echo send (kept for API compat; feeds the reverb space)
    this.echo = ac.createDelay(0.6);
    this.echo.delayTime.value = 0.23;
    this.echoGain = ac.createGain();
    this.echoGain.gain.value = 0.22;
    this.echoFb = ac.createGain();
    this.echoFb.gain.value = 0.3;
    this.echo.connect(this.echoFb).connect(this.echo);
    this.echo.connect(this.echoGain).connect(this.master);
    this.echoGain.connect(this.reverb);

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
    // ambience rides with the sfx bus (no dedicated slider), a touch below it
    this.ambBus.gain.value = (s.volumeSfx ?? 0.9) * 0.75;
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

  // Exponentially-decaying stereo noise → a cheap, warm reverb impulse response.
  _buildImpulse(seconds = 2.0, decay = 2.5) {
    const ac = this.ac;
    const len = Math.max(1, Math.floor(ac.sampleRate * seconds));
    const buf = ac.createBuffer(2, len, ac.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // a short pre-delay gap then a smooth diffuse tail
        const env = Math.pow(1 - t, decay) * (i < len * 0.01 ? t * 100 : 1);
        d[i] = (Math.random() * 2 - 1) * env;
      }
    }
    return buf;
  }

  /**
   * A persistent, looping noise bed. Signal chain:
   *   noise → colouring filter → gust (LFO-modulated ×gain) → level → ambBus
   * `level` is what update() rides to crossfade the layer in and out; the gust
   * LFO makes it breathe (swell rising, wind gusting) even while held steady.
   */
  _bed(kind, filterType, freq, q, level, opts = {}) {
    const ac = this.ac;
    const src = ac.createBufferSource();
    src.buffer = this.noiseBuffer(kind);
    src.loop = true;
    src.playbackRate.value = randRange(Math.random, 0.97, 1.03);

    const filter = ac.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.value = freq;
    filter.Q.value = q;

    const gust = ac.createGain();
    gust.gain.value = 1;
    const levelGain = ac.createGain();
    levelGain.gain.value = level;

    src.connect(filter).connect(gust).connect(levelGain).connect(this.ambBus);

    // amplitude "gust" LFO — modulates around 1.0 so a silenced bed stays silent
    if (opts.gustRate > 0) {
      const lfo = ac.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = opts.gustRate;
      const depth = ac.createGain();
      depth.gain.value = opts.gustDepth ?? 0.3;
      lfo.connect(depth).connect(gust.gain);
      lfo.start();
    }
    // slow wander of the filter centre — a moaning, living wind howl
    if (opts.freqLfoRate > 0) {
      const lfo = ac.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = opts.freqLfoRate;
      const depth = ac.createGain();
      depth.gain.value = opts.freqLfoDepth ?? 100;
      lfo.connect(depth).connect(filter.frequency);
      lfo.start();
    }

    src.start();
    return { src, filter, gust, level: levelGain };
  }

  _buildAmbience() {
    // deep swell rumble — slow, breathing
    this.oceanLow = this._bed('brown', 'lowpass', 420, 0.7, 0.16,
      { gustRate: 0.09, gustDepth: 0.35 });
    // whitecap hiss / spray — rides higher, breathes out of phase with the swell
    this.oceanSurf = this._bed('pink', 'bandpass', 1300, 0.5, 0.0,
      { gustRate: 0.13, gustDepth: 0.5 });
    // steady wind
    this.wind = this._bed('pink', 'bandpass', 600, 0.8, 0.05,
      { gustRate: 0.22, gustDepth: 0.4 });
    // storm howl — resonant, wandering pitch
    this.windHowl = this._bed('pink', 'bandpass', 520, 6.0, 0.0,
      { gustRate: 0.17, gustDepth: 0.5, freqLfoRate: 0.07, freqLfoDepth: 190 });
    // rain: bright hiss + a mid-body patter
    this.rain = this._bed('white', 'highpass', 1900, 0.6, 0.0);
    this.rainBody = this._bed('pink', 'bandpass', 1500, 0.7, 0.0,
      { gustRate: 0.6, gustDepth: 0.25 });
    // port crowd murmur — low babble that swells and eases
    this.crowd = this._bed('brown', 'lowpass', 520, 1.1, 0.0,
      { gustRate: 0.25, gustDepth: 0.5 });
    // tavern room tone — warm, close, muffled
    this.tavern = this._bed('brown', 'lowpass', 320, 0.9, 0.0,
      { gustRate: 0.4, gustDepth: 0.3 });
    // submerged hush
    this.underwater = this._bed('brown', 'lowpass', 200, 0.9, 0.0,
      { gustRate: 0.5, gustDepth: 0.3 });

    // keep the legacy `ocean` alias pointing at the main swell bed
    this.ocean = this.oceanLow;
  }

  /** Route a one-shot into the reverb space. Returns the send gain node. */
  sendReverb(node, amt = 0.2) {
    if (!this.ready || !node || amt <= 0) return null;
    const g = this.ac.createGain();
    g.gain.value = amt;
    node.connect(g).connect(this.reverb);
    return g;
  }

  /**
   * Distance / stereo-pan / air-absorption for positional one-shots.
   * Returns a reused scratch object {gain, pan, dist, lp} — callers destructure
   * immediately so reuse is safe and allocation-free in combat bursts.
   */
  spatial(pos, refDist = 60) {
    const out = this._spatialOut ?? (this._spatialOut = { gain: 1, pan: 0, dist: 0, lp: 20000 });
    if (!pos) { out.gain = 1; out.pan = 0; out.dist = 0; out.lp = 20000; return out; }
    const cam = this.ctx.camera;
    const dx = pos.x - cam.position.x;
    const dz = pos.z - cam.position.z;
    const dist = Math.hypot(dx, dz, (pos.y ?? 0) - cam.position.y);
    out.dist = dist;
    out.gain = clamp(refDist / Math.max(dist, refDist * 0.3), 0.02, 1);
    // pan by camera-relative bearing
    const q = cam.quaternion;
    const camDir = Math.atan2(
      2 * (q.w * q.y + q.x * q.z),
      1 - 2 * (q.y * q.y + q.x * q.x),
    );
    const bearing = Math.atan2(dx, dz);
    let rel = bearing - camDir;
    while (rel > Math.PI) rel -= Math.PI * 2;
    while (rel < -Math.PI) rel += Math.PI * 2;
    out.pan = clamp(Math.sin(rel) * -0.92, -1, 1);
    // air absorption — distant sounds go dull (high frequencies roll off)
    out.lp = clamp(20000 - Math.max(0, dist - refDist) * 22, 900, 20000);
    return out;
  }

  // --- occasional ambience one-shots (routed to the ambience bus) -----------

  _creak(intensity) {
    const ac = this.ac;
    const t0 = ac.currentTime;
    const dur = randRange(Math.random, 0.28, 0.62);
    const src = ac.createBufferSource();
    src.buffer = this.noiseBuffer('brown');
    src.playbackRate.value = randRange(Math.random, 0.8, 1.2);
    const bp = ac.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = randRange(Math.random, 5, 11);
    const f0 = randRange(Math.random, 150, 320);
    bp.frequency.setValueAtTime(f0, t0);
    bp.frequency.linearRampToValueAtTime(f0 * randRange(Math.random, 0.6, 1.5), t0 + dur);
    const g = ac.createGain();
    const peak = clamp(0.05 + intensity * 0.12, 0.03, 0.16);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(peak, t0 + dur * 0.4);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bp).connect(g).connect(this.ambBus);
    src.start(t0);
    src.stop(t0 + dur + 0.05);
  }

  _clink() {
    const ac = this.ac;
    const t0 = ac.currentTime + Math.random() * 0.05;
    for (const f of [randRange(Math.random, 1800, 2600), randRange(Math.random, 2600, 3600)]) {
      const osc = ac.createOscillator();
      osc.type = 'triangle';
      osc.frequency.value = f;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.03, t0 + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.18);
      osc.connect(g).connect(this.ambBus);
      osc.start(t0);
      osc.stop(t0 + 0.22);
    }
  }

  update(dt) {
    if (!this.ready) return;
    const ac = this.ac;
    const t = ac.currentTime;
    const c = this.ctx;
    const inMenu = c.mode === 'menu';

    const weather = c.weather;
    const cond = weather?.condition ?? 'clear';
    const intensity = clamp01(weather?.intensity ?? 0);
    const windSpeed = weather?.wind?.speed ?? 5;
    const sea = c.ocean?.seaState ?? 0.3;
    this._sea += (sea - this._sea) * Math.min(1, dt * 0.5);

    // --- where is the player, and how close to a port? ------------------------
    // getNearestPort() allocates its result, so poll it a few times a second and
    // let the slow crossfade smooth the rest — no per-frame garbage.
    const focus = c.mode === 'foot'
      ? c.character?.position
      : c.playerShip?.ship?.position;
    this._portCheckT -= dt;
    if (this._portCheckT <= 0) {
      this._portCheckT = 0.25;
      let pt = 0;
      if (!inMenu && focus) {
        const near = c.world?.getNearestPort?.(focus);
        if (near) pt = clamp01(1 - (near.distance - 45) / 240);
      }
      this._portTarget = pt;
    }
    this._portFactor += (this._portTarget - this._portFactor) * Math.min(1, dt * 0.6);

    // --- screen context: tavern room-tone, world muffle ----------------------
    const screen = c.ui?.activeScreen;
    const inTavern = screen === 'tavern' || screen === 'market' ||
      screen === 'shipwright' || screen === 'questboard';
    const tavernTarget = inTavern ? 1 : 0;
    this._tavernFactor += (tavernTarget - this._tavernFactor) * Math.min(1, dt * 0.8);

    // --- underwater? -----------------------------------------------------------
    let submerged = 0;
    if (c.mode === 'foot') {
      const cy = c.character?.position?.y;
      if (cy != null && cy < -0.2) submerged = 1;
    }

    // ===== ocean swell + surf ===============================================
    const seaFloor = inMenu ? 0.11 : 0.15;
    this.oceanLow.level.gain.setTargetAtTime(seaFloor + this._sea * 0.3, t, TAU_GAIN);
    this.oceanLow.filter.frequency.setTargetAtTime(300 + this._sea * 520, t, TAU_FILT);
    this.oceanSurf.level.gain.setTargetAtTime(
      inMenu ? 0.03 : 0.02 + this._sea * this._sea * 0.24, t, TAU_GAIN);
    this.oceanSurf.filter.frequency.setTargetAtTime(1000 + this._sea * 1400, t, TAU_FILT);

    // ===== wind (steady + storm howl) =======================================
    const windN = clamp01((windSpeed - 3) / 14);
    this.wind.level.gain.setTargetAtTime(inMenu ? 0.03 : windN * 0.2, t, 0.9);
    this.wind.filter.frequency.setTargetAtTime(380 + windSpeed * 55, t, 0.9);
    const howl = clamp01((windSpeed - 9) / 7) * lerp(0.4, 1, intensity);
    this.windHowl.level.gain.setTargetAtTime(inMenu ? 0 : howl * 0.13, t, 1.1);

    // ===== rain =============================================================
    const rainAmt = cond === 'storm' ? 1 : cond === 'rain' ? 0.62 : 0;
    this.rain.level.gain.setTargetAtTime(inMenu ? 0 : rainAmt * 0.13, t, 1.1);
    this.rainBody.level.gain.setTargetAtTime(inMenu ? 0 : rainAmt * 0.08, t, 1.1);

    // ===== port murmur + tavern tone ========================================
    // out at sea the crowd is gone; ashore it swells; behind a tavern door the
    // room-tone takes over and the open-air murmur ducks a little.
    const crowd = this._portFactor * (1 - this._tavernFactor * 0.5);
    this.crowd.level.gain.setTargetAtTime(crowd * 0.09, t, 0.9);
    this.tavern.level.gain.setTargetAtTime(this._tavernFactor * 0.12, t, 0.9);

    // ===== underwater hush ==================================================
    this.underwater.level.gain.setTargetAtTime(submerged * 0.22, t, 0.5);

    // ===== master ambience colouring (muffle for screens / underwater) ======
    const screenMuffle = !!screen && screen !== 'map';
    let cutoff = 20000;
    if (submerged) cutoff = 480;
    else if (this._tavernFactor > 0.3) cutoff = lerp(20000, 1600, this._tavernFactor);
    else if (screenMuffle) cutoff = 900;
    this.ambFilter.frequency.setTargetAtTime(cutoff, t, 0.3);

    // ===== scheduled one-shots ==============================================
    // rigging creaks — more frequent and louder the harder she heels & drives
    if (!inMenu && c.mode === 'sail') {
      this._creakT -= dt;
      if (this._creakT <= 0) {
        const phys = c.playerShip?.ship?.physics;
        const heel = Math.abs(phys?._heel ?? 0);
        const spd = phys?.speed ?? 0;
        const activity = clamp01(heel * 2.6 + spd * 0.02);
        this._creakT = randRange(Math.random, 2.4, 6.5) * (1.15 - activity * 0.8);
        if (activity > 0.04 && Math.random() < 0.5 + activity * 0.45) this._creak(activity);
      }
    }
    // tavern glass clinks & murmurs
    if (this._tavernFactor > 0.35) {
      this._clinkT -= dt;
      if (this._clinkT <= 0) {
        this._clinkT = randRange(Math.random, 2.5, 7);
        this._clink();
      }
    }
  }
}
