// One-shot synthesized SFX, wired to game events. Every sound is layered from
// scratch (sub + body + transient + tail) and spatialized through the audio
// engine (distance rolloff, stereo pan, air-absorption, reverb tails) so the
// world reads clearly by ear alone. Systems stay decoupled: we subscribe to
// events, we never reach back into gameplay.
import { clamp, randRange } from '../core/utils.js';

export class Sfx {
  constructor(ctx, engine) {
    this.ctx = ctx;
    this.a = engine;

    const on = (name, fn) => ctx.events?.on(name, fn);
    on('cannon:fire', ({ pos, isPlayer }) => this.cannon(pos, isPlayer));
    on('ship:hit', ({ ship, onPlayer }) => this.woodHit(ship?.position, onPlayer ? 1.25 : 0.95));
    on('ship:aground', ({ ship }) => this.woodBreak(ship?.position, 0.8));
    on('ship:sunk', ({ ship }) => this.shipSunk(ship?.position));
    on('sword:hit', ({ heavy }) => this.swordHit(heavy));
    on('sword:swing', () => this.swoosh());
    on('parry', () => this.clash());
    on('pistol:fire', () => this.pistol());
    on('footstep', ({ surface }) => this.footstep(surface));
    on('trade', () => this.coins());
    on('loot:collect', () => this.coins());
    on('treasure:dug', () => this.treasure());
    on('quest:complete', () => this.chime(1));
    on('level:up', () => this.chime(2));
    on('island:discovered', () => this.discover());
    on('thunder', ({ delay }) => setTimeout(() => this.thunder(delay), (delay ?? 1) * 1000));
    on('gull', () => this.gull());
    on('ship:dock', () => this.bell());
    on('player:hurt', () => this.grunt());
    on('weather:change', ({ condition }) => {
      if (condition === 'storm') this.bell(2);
    });
  }

  // --- dispatcher (contract API) --------------------------------------------
  play(name, opts = {}) {
    const p = opts.pos;
    switch (name) {
      case 'cannon': return this.cannon(p, true);
      case 'cannon-distant': return this.cannon(p, false);
      case 'wood-hit': case 'hit': return this.woodHit(p, opts.vol ?? 1);
      case 'wood-break': case 'break': return this.woodBreak(p, opts.vol ?? 1);
      case 'splash': return this.splash(p, opts.vol ?? 1);
      case 'swing': return this.swoosh();
      case 'sword-hit': return this.swordHit(false);
      case 'sword-heavy': return this.swordHit(true);
      case 'clash': case 'parry': return this.clash();
      case 'pistol': return this.pistol();
      case 'footstep': return this.footstep(opts.surface);
      case 'coins': return this.coins();
      case 'treasure': return this.treasure();
      case 'chime': return this.chime(opts.kind ?? 1);
      case 'level-up': return this.chime(2);
      case 'discover': return this.discover();
      case 'bell': return this.bell(opts.times ?? 1);
      case 'gull': return this.gull();
      case 'thunder': return this.thunder(opts.delay ?? 1);
      case 'grunt': return this.grunt();
      case 'ui': case 'click': return this.uiClick();
      case 'paper': return this.paper();
      case 'dig': return this.dig();
      default: return undefined;
    }
  }

  // --- primitives -----------------------------------------------------------

  /**
   * A spatial voice: sources connect to `node` (which carries distance
   * attenuation), then flow → air-absorption lowpass → stereo pan → sfx bus.
   * Route reverb from `node` with `a.sendReverb(v.node, amt)`.
   */
  _voice(pos, refDist = 80) {
    const a = this.a, ac = a.ac;
    const s = a.spatial(pos, refDist);
    const node = ac.createGain();
    node.gain.value = s.gain;
    let tail = node;
    if (pos && s.lp < 19000) {
      const lp = ac.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = s.lp;
      node.connect(lp);
      tail = lp;
    }
    const p = ac.createStereoPanner ? ac.createStereoPanner() : null;
    if (p) { p.pan.value = s.pan; tail.connect(p).connect(a.sfxBus); }
    else tail.connect(a.sfxBus);
    return { node, gain: s.gain, dist: s.dist };
  }

  _env(g, t0, attack, peak, decay, curve = 'exp') {
    const gg = g.gain;
    gg.setValueAtTime(0.0001, t0);
    gg.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + attack);
    if (curve === 'lin') gg.linearRampToValueAtTime(0.0001, t0 + attack + decay);
    else gg.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  _osc(v, type, f0, f1, t0, dur, peak, attack = 0.004) {
    const ac = this.a.ac;
    const osc = ac.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 8), t0 + dur);
    const g = ac.createGain();
    this._env(g, t0, attack, peak, dur);
    osc.connect(g).connect(v.node);
    osc.start(t0);
    osc.stop(t0 + dur + 0.05);
    return osc;
  }

  _noise(v, kind, filterType, f0, f1, t0, dur, peak, q = 0.7, attack = 0.003) {
    const ac = this.a.ac;
    const src = ac.createBufferSource();
    src.buffer = this.a.noiseBuffer(kind);
    src.playbackRate.value = randRange(Math.random, 0.9, 1.12);
    const flt = ac.createBiquadFilter();
    flt.type = filterType;
    flt.Q.value = q;
    flt.frequency.setValueAtTime(f0, t0);
    if (f1 !== f0) flt.frequency.exponentialRampToValueAtTime(Math.max(f1, 20), t0 + dur);
    const g = ac.createGain();
    this._env(g, t0, attack, peak, dur);
    src.connect(flt).connect(g).connect(v.node);
    src.start(t0);
    src.stop(t0 + dur + 0.06);
  }

  // --- naval ----------------------------------------------------------------

  cannon(pos, isPlayer = false) {
    const a = this.a;
    if (!a.ready) return;
    const t0 = a.ac.currentTime;
    const v = this._voice(pos, 240);
    const dist = v.dist;
    // crack collapses with distance; the rolling boom lengthens as it travels
    const near = clamp(1 - dist / 520, 0.12, 1);
    const rv = clamp(0.16 + dist / 700, 0.16, 0.55);
    a.sendReverb(v.node, rv);

    // sub thump — the shove of powder
    this._osc(v, 'sine', 84, 30, t0, 0.55, isPlayer ? 1.0 : 0.9, 0.002);
    // body punch
    this._osc(v, 'triangle', 150, 46, t0, 0.26, 0.5);
    // report crack
    this._noise(v, 'white', 'bandpass', 2900, 700, t0, 0.10, 0.72 * near, 0.9, 0.001);
    // bright ignition transient
    this._noise(v, 'white', 'highpass', 5400, 3000, t0, 0.03, 0.55 * near, 0.7, 0.0008);
    // rolling tail out over the water
    this._noise(v, 'brown', 'lowpass', 540, 90, t0 + 0.015, 0.6 + dist / 900, 0.42, 0.6);
  }

  woodHit(pos, vol = 1) {
    const a = this.a;
    if (!a.ready) return;
    const t0 = a.ac.currentTime;
    const v = this._voice(pos, 130);
    a.sendReverb(v.node, 0.1);
    // dull hull thud
    this._osc(v, 'triangle', 210, 70, t0, 0.17, 0.42 * vol);
    this._osc(v, 'sine', 96, 52, t0, 0.12, 0.3 * vol, 0.002);
    // timber crack
    this._noise(v, 'white', 'bandpass', 900, 210, t0, 0.13, 0.5 * vol, 1.1);
    // splinters rattling free
    this._noise(v, 'white', 'highpass', 3200, 1500, t0 + 0.01, 0.2, 0.2 * vol, 0.7);
  }

  woodBreak(pos, vol = 1) {
    const a = this.a;
    if (!a.ready) return;
    const t0 = a.ac.currentTime;
    const v = this._voice(pos, 150);
    a.sendReverb(v.node, 0.18);
    // a low groan of stressed timber
    this._osc(v, 'sawtooth', 150, 54, t0, 0.5, 0.34 * vol, 0.01);
    this._osc(v, 'triangle', 220, 80, t0, 0.28, 0.3 * vol);
    // the crack
    this._noise(v, 'white', 'bandpass', 1100, 240, t0, 0.2, 0.55 * vol, 1.2);
    // scattering splinters
    for (let i = 0; i < 3; i++) {
      this._noise(v, 'white', 'highpass', 3400, 1600, t0 + i * 0.04, 0.16, 0.16 * vol, 0.8);
    }
  }

  shipSunk(pos) {
    const a = this.a;
    if (!a.ready) return;
    // ignore sinkings too far to hear
    if (pos && a.spatial(pos, 150).dist > 620) return;
    this.woodBreak(pos, 1.1);
    setTimeout(() => this.splash(pos, 1.9), 260);
  }

  splash(pos, scale = 1) {
    const a = this.a;
    if (!a.ready) return;
    const t0 = a.ac.currentTime;
    const v = this._voice(pos, 90);
    const s = clamp(scale, 0.2, 2.4);
    // the gulp of displaced water — a downward-sweeping hiss
    this._noise(v, 'white', 'lowpass', 4200, 320, t0, 0.18 + 0.16 * s, 0.42 * s, 0.5);
    // a mid plip on top
    this._noise(v, 'pink', 'bandpass', 1400, 700, t0, 0.12, 0.22 * s, 0.9);
    // low body for the big ones
    if (s > 0.9) this._osc(v, 'sine', 150, 60, t0, 0.2 * s, 0.2 * s, 0.003);
  }

  // --- melee & firearms -----------------------------------------------------

  swoosh() {
    const a = this.a;
    if (!a.ready) return;
    const t0 = a.ac.currentTime;
    const v = this._voice(null);
    // an airy blade-arc: rises then falls away
    this._noise(v, 'white', 'bandpass', 700, 2600, t0, 0.08, 0.16, 1.4);
    this._noise(v, 'white', 'bandpass', 2600, 600, t0 + 0.06, 0.12, 0.13, 1.4);
  }

  swordHit(heavy) {
    const a = this.a;
    if (!a.ready) return;
    const t0 = a.ac.currentTime;
    const v = this._voice(null);
    // impact body
    this._osc(v, 'square', heavy ? 200 : 300, 90, t0, 0.12, heavy ? 0.22 : 0.16);
    // edge bite
    this._noise(v, 'white', 'highpass', 3200, 1200, t0, 0.1, heavy ? 0.34 : 0.26, 0.8);
    // low thunk on a heavy blow
    if (heavy) this._osc(v, 'sine', 110, 48, t0, 0.16, 0.24, 0.003);
  }

  clash() {
    const a = this.a;
    if (!a.ready) return;
    const t0 = a.ac.currentTime;
    const v = this._voice(null);
    a.sendReverb(v.node, 0.22);
    // inharmonic metallic ring — steel on steel
    const parts = [1730, 2260, 3170, 4390];
    parts.forEach((f, i) => {
      const jf = f * randRange(Math.random, 0.98, 1.02);
      this._osc(v, 'triangle', jf, jf * 0.72, t0, 0.55 - i * 0.06, 0.11 - i * 0.02, 0.001);
    });
    // the strike transient
    this._noise(v, 'white', 'highpass', 4200, 2000, t0, 0.08, 0.28, 0.7, 0.0008);
  }

  pistol() {
    const a = this.a;
    if (!a.ready) return;
    const t0 = a.ac.currentTime;
    const v = this._voice(null, 80);
    a.sendReverb(v.node, 0.2);
    // sharp report
    this._noise(v, 'white', 'lowpass', 6000, 500, t0, 0.16, 0.7, 0.4, 0.0006);
    this._noise(v, 'white', 'highpass', 4000, 2000, t0, 0.03, 0.5, 0.7, 0.0006);
    // powder thump
    this._osc(v, 'sine', 150, 50, t0, 0.14, 0.4, 0.002);
    // wisp of a tail
    this._noise(v, 'brown', 'lowpass', 800, 200, t0 + 0.01, 0.28, 0.14);
  }

  // --- foot & world ---------------------------------------------------------

  footstep(surface) {
    const a = this.a;
    if (!a.ready) return;
    const t0 = a.ac.currentTime;
    const v = this._voice(null, 30);
    const j = randRange(Math.random, 0.9, 1.12);
    if (surface === 'wood' || surface === 'deck') {
      this._noise(v, 'brown', 'bandpass', 300 * j, 130, t0, 0.09, 0.22, 1.2);
      this._osc(v, 'sine', 150, 70, t0, 0.06, 0.08, 0.002);
    } else if (surface === 'stone' || surface === 'dock') {
      this._noise(v, 'white', 'bandpass', 1400 * j, 500, t0, 0.06, 0.14, 1.6);
      this._noise(v, 'brown', 'lowpass', 500, 180, t0, 0.05, 0.1);
    } else if (surface === 'grass' || surface === 'dirt') {
      this._noise(v, 'pink', 'lowpass', 700 * j, 260, t0, 0.08, 0.1, 0.8);
    } else {
      // sand / default — soft, dry
      this._noise(v, 'white', 'lowpass', 900 * j, 300, t0, 0.08, 0.12, 0.6);
    }
  }

  coins() {
    const a = this.a;
    if (!a.ready) return;
    for (let i = 0; i < 4; i++) {
      setTimeout(() => {
        if (!a.ready) return;
        const t0 = a.ac.currentTime;
        const v = this._voice(null);
        a.sendReverb(v.node, 0.12);
        const f = randRange(Math.random, 2200, 3600);
        this._osc(v, 'triangle', f, f * 0.82, t0, 0.09, 0.07, 0.001);
        this._osc(v, 'square', f * 1.5, f * 1.3, t0, 0.05, 0.03, 0.001);
      }, i * 42 + Math.random() * 20);
    }
  }

  treasure() {
    this.coins();
    setTimeout(() => this.chime(1), 220);
  }

  dig() {
    const a = this.a;
    if (!a.ready) return;
    const t0 = a.ac.currentTime;
    const v = this._voice(null, 30);
    // shovel bite into earth
    this._noise(v, 'brown', 'lowpass', 700, 200, t0, 0.16, 0.24, 0.6);
    this._noise(v, 'white', 'highpass', 2600, 1200, t0, 0.06, 0.08, 0.7);
  }

  chime(kind = 1) {
    const a = this.a;
    if (!a.ready) return;
    // a warm rising figure; level-up gets a fuller triumphant arpeggio
    const notes = kind === 2 ? [523.25, 659.25, 783.99, 1046.5, 1318.5] : [523.25, 783.99];
    notes.forEach((f, i) => {
      setTimeout(() => {
        if (!a.ready) return;
        const t0 = a.ac.currentTime;
        const v = this._voice(null);
        a.sendReverb(v.node, 0.25);
        this._osc(v, 'triangle', f, f, t0, 0.9, 0.13, 0.02);
        this._osc(v, 'sine', f * 2, f * 2, t0, 0.5, 0.04, 0.02);
      }, i * (kind === 2 ? 95 : 130));
    });
  }

  discover() {
    const a = this.a;
    if (!a.ready) return;
    // a low, open, faraway-horizon swell — a landfall of the ear
    [261.63, 392.0].forEach((f, i) => {
      setTimeout(() => {
        if (!a.ready) return;
        const t0 = a.ac.currentTime;
        const v = this._voice(null);
        a.sendReverb(v.node, 0.3);
        this._osc(v, 'triangle', f, f, t0, 1.6, 0.1, 0.08);
        this._osc(v, 'sine', f * 1.5, f * 1.5, t0, 1.2, 0.045, 0.08);
      }, i * 240);
    });
  }

  bell(times = 1) {
    const a = this.a;
    if (!a.ready) return;
    for (let i = 0; i < times; i++) {
      setTimeout(() => {
        if (!a.ready) return;
        const t0 = a.ac.currentTime;
        const v = this._voice(null, 120);
        a.sendReverb(v.node, 0.28);
        // struck-bronze partials (slightly inharmonic) with a long hum
        this._osc(v, 'triangle', 620, 616, t0, 1.5, 0.2, 0.001);
        this._osc(v, 'triangle', 935, 928, t0, 0.9, 0.09, 0.001);
        this._osc(v, 'sine', 1560, 1550, t0, 0.5, 0.04, 0.001);
        this._noise(v, 'white', 'highpass', 5000, 3000, t0, 0.02, 0.12, 0.7, 0.0006);
      }, i * 720);
    }
  }

  gull() {
    const a = this.a;
    if (!a.ready) return;
    const t0 = a.ac.currentTime;
    const v = this._voice(null, 60);
    const f = randRange(Math.random, 1100, 1500);
    // two-syllable cry with a little rasp
    this._osc(v, 'sawtooth', f, f * 0.62, t0, 0.26, 0.05, 0.01);
    setTimeout(() => {
      if (!a.ready) return;
      const t1 = a.ac.currentTime;
      const v2 = this._voice(null, 60);
      this._osc(v2, 'sawtooth', f * 0.94, f * 0.56, t1, 0.22, 0.04, 0.01);
    }, 250);
  }

  thunder(delay = 1) {
    const a = this.a;
    if (!a.ready) return;
    const t0 = a.ac.currentTime;
    const vol = clamp(1 - delay * 0.2, 0.25, 1);
    const v = this._voice(null, 100);
    a.sendReverb(v.node, 0.4);
    // deep, long roll
    this._noise(v, 'brown', 'lowpass', 900, 55, t0, 2.6, vol, 0.6, 0.02);
    // the initial crack for close strikes
    this._noise(v, 'white', 'bandpass', 1800, 200, t0, 0.5, vol * 0.32, 0.8, 0.002);
    this._osc(v, 'sine', 70, 30, t0, 1.2, vol * 0.5, 0.01);
    // a close strike thumps the deck — a whisper of extra shake
    if (delay < 0.7) {
      this.ctx.events?.emit('shake', { amount: clamp(0.3 * (1 - delay), 0.05, 0.3) });
    }
  }

  grunt() {
    const a = this.a;
    if (!a.ready) return;
    const t0 = a.ac.currentTime;
    const v = this._voice(null);
    this._osc(v, 'sawtooth', 150, 78, t0, 0.18, 0.12, 0.005);
    this._noise(v, 'brown', 'lowpass', 500, 200, t0, 0.12, 0.06);
  }

  uiClick() {
    const a = this.a;
    if (!a.ready) return;
    const t0 = a.ac.currentTime;
    const v = this._voice(null);
    this._osc(v, 'square', 1400, 1200, t0, 0.04, 0.05, 0.001);
  }

  paper() {
    const a = this.a;
    if (!a.ready) return;
    const t0 = a.ac.currentTime;
    const v = this._voice(null);
    this._noise(v, 'white', 'highpass', 3000, 1800, t0, 0.14, 0.07, 0.5);
  }

  update() { /* event-driven */ }
}
