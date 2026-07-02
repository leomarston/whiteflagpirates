// One-shot synthesized SFX, wired to game events.
import { randRange } from '../core/utils.js';

export class Sfx {
  constructor(ctx, engine) {
    this.ctx = ctx;
    this.a = engine;

    const on = (name, fn) => ctx.events?.on(name, fn);
    on('cannon:fire', ({ pos }) => this.cannon(pos));
    on('ship:hit', ({ ship }) => this.woodHit(ship?.position));
    on('ship:aground', () => this.woodHit(null, 0.7));
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
    on('thunder', ({ delay }) => setTimeout(() => this.thunder(delay), (delay ?? 1) * 1000));
    on('gull', () => this.gull());
    on('ship:dock', () => this.bell());
    on('player:hurt', () => this.grunt());
    on('weather:change', ({ condition }) => {
      if (condition === 'storm') this.bell(2);
    });
  }

  _env(gainNode, t0, attack, peak, decay) {
    const g = gainNode.gain;
    g.setValueAtTime(0.0001, t0);
    g.exponentialRampToValueAtTime(Math.max(peak, 0.0002), t0 + attack);
    g.exponentialRampToValueAtTime(0.0001, t0 + attack + decay);
  }

  _out(pos, refDist) {
    const a = this.a;
    const { gain, pan } = a.spatial(pos, refDist);
    const g = a.ac.createGain();
    const p = a.ac.createStereoPanner ? a.ac.createStereoPanner() : null;
    if (p) {
      p.pan.value = pan;
      g.connect(p).connect(a.sfxBus);
    } else {
      g.connect(a.sfxBus);
    }
    return { node: g, spatialGain: gain };
  }

  _noise(kind, filterType, f0, f1, dur, peak, pos, refDist = 80, echo = 0) {
    const a = this.a;
    if (!a.ready) return;
    const ac = a.ac;
    const t0 = ac.currentTime;
    const src = ac.createBufferSource();
    src.buffer = a.noiseBuffer(kind);
    src.playbackRate.value = randRange(Math.random, 0.9, 1.1);
    const filter = ac.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(f0, t0);
    filter.frequency.exponentialRampToValueAtTime(Math.max(f1, 30), t0 + dur);
    const { node, spatialGain } = this._out(pos, refDist);
    this._env(node, t0, 0.008, peak * spatialGain, dur);
    src.connect(filter).connect(node);
    if (echo > 0) {
      const eg = ac.createGain();
      eg.gain.value = echo * spatialGain;
      filter.connect(eg).connect(a.echo);
    }
    src.start(t0);
    src.stop(t0 + dur + 0.1);
  }

  _tone(type, f0, f1, dur, peak, pos, refDist = 60) {
    const a = this.a;
    if (!a.ready) return;
    const ac = a.ac;
    const t0 = ac.currentTime;
    const osc = ac.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(f0, t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(f1, 20), t0 + dur);
    const { node, spatialGain } = this._out(pos, refDist);
    this._env(node, t0, 0.006, peak * spatialGain, dur);
    osc.connect(node);
    osc.start(t0);
    osc.stop(t0 + dur + 0.1);
  }

  cannon(pos) {
    this._tone('sine', 62, 34, 0.5, 0.9, pos, 220);
    this._noise('white', 'lowpass', 3200, 240, 0.42, 0.65, pos, 220, 0.5);
  }

  thunder(delay = 1) {
    const vol = Math.max(0.25, 1 - delay * 0.2);
    this._noise('brown', 'lowpass', 900, 60, 2.6, vol, null, 100, 0.4);
    this._noise('white', 'bandpass', 1800, 200, 0.5, vol * 0.3, null);
  }

  woodHit(pos, vol = 1) {
    this._noise('white', 'bandpass', 700, 180, 0.22, 0.5 * vol, pos, 120);
    this._tone('triangle', 180, 70, 0.18, 0.3 * vol, pos, 120);
  }

  swoosh() {
    this._noise('white', 'bandpass', 900, 2400, 0.16, 0.16, null);
  }

  swordHit(heavy) {
    this._noise('white', 'highpass', 3000, 1200, 0.12, 0.3, null);
    this._tone('square', heavy ? 220 : 320, 90, 0.12, 0.18, null);
  }

  clash() {
    // inharmonic metallic ring
    for (const f of [1730, 2260, 3170]) {
      this._tone('triangle', f * randRange(Math.random, 0.98, 1.02), f * 0.7, 0.5, 0.1, null);
    }
    this._noise('white', 'highpass', 4000, 2000, 0.1, 0.25, null);
  }

  pistol() {
    this._noise('white', 'lowpass', 5000, 500, 0.18, 0.7, null, 80, 0.3);
    this._tone('sine', 140, 50, 0.14, 0.4, null);
  }

  footstep(surface) {
    if (surface === 'wood') this._noise('brown', 'bandpass', 300, 140, 0.09, 0.22, null);
    else this._noise('white', 'lowpass', 900, 300, 0.08, 0.12, null);
  }

  coins() {
    for (let i = 0; i < 3; i++) {
      setTimeout(() => {
        this._tone('square', randRange(Math.random, 2200, 3400), 1800, 0.08, 0.07, null);
      }, i * 45);
    }
  }

  treasure() {
    this.coins();
    setTimeout(() => this.chime(1), 200);
  }

  chime(kind = 1) {
    const base = kind === 2 ? [523, 659, 784, 1047] : [523, 784];
    base.forEach((f, i) => {
      setTimeout(() => this._tone('triangle', f, f * 0.995, 0.9, 0.14, null), i * 110);
    });
  }

  bell(times = 1) {
    for (let i = 0; i < times; i++) {
      setTimeout(() => {
        this._tone('triangle', 620, 610, 1.4, 0.2, null);
        this._tone('triangle', 935, 920, 0.9, 0.08, null);
      }, i * 700);
    }
  }

  gull() {
    const f = randRange(Math.random, 1100, 1500);
    this._tone('sawtooth', f, f * 0.6, 0.28, 0.045, null);
    setTimeout(() => this._tone('sawtooth', f * 0.92, f * 0.55, 0.22, 0.035, null), 260);
  }

  grunt() {
    this._tone('sawtooth', 140, 80, 0.18, 0.12, null);
  }

  update() { /* event-driven */ }
}
