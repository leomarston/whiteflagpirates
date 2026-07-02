// Generative score: modal shanty melodies over drones; morphs with the mood.
import { Sfx } from './sfx.js';

// A dorian-ish and minor pentatonic pools (frequencies around A3)
const SCALES = {
  calm: [220, 246.9, 261.6, 293.7, 329.6, 392, 440],       // A dorian flavor
  dark: [220, 261.6, 293.7, 311.1, 349.2, 415.3, 440],     // darker minor
  jig: [220, 246.9, 277.2, 293.7, 329.6, 370, 440],        // brighter
};

const CONTEXTS = {
  title: { tempo: 46, density: 0.35, scale: 'calm', drone: true, drums: false, vol: 0.5 },
  calm: { tempo: 58, density: 0.3, scale: 'calm', drone: true, drums: false, vol: 0.4 },
  night: { tempo: 50, density: 0.18, scale: 'calm', drone: true, drums: false, vol: 0.3 },
  storm: { tempo: 66, density: 0.4, scale: 'dark', drone: true, drums: false, vol: 0.45 },
  tension: { tempo: 76, density: 0.4, scale: 'dark', drone: true, drums: false, vol: 0.45 },
  combat: { tempo: 108, density: 0.65, scale: 'dark', drone: true, drums: true, vol: 0.6 },
  port: { tempo: 96, density: 0.7, scale: 'jig', drone: false, drums: false, vol: 0.45 },
};

export class Music {
  constructor(ctx) {
    this.ctx = ctx;
    this.sfx = new Sfx(ctx, ctx.audio); // sfx lives with music so both exist after audio
    this.context = 'title';
    this._nextNote = 0;
    this._beat = 0;
    this._phrase = 0;
    this._degree = 0;
    this._gain = null;
    this._droneOsc = null;
    this._contextVol = 0.5;
  }

  _ensureNodes() {
    const a = this.ctx.audio;
    if (!a?.ready || this._gain) return;
    const ac = a.ac;
    this._gain = ac.createGain();
    this._gain.gain.value = 0.5;
    this._gain.connect(a.musicBus);

    // drone: two detuned sines on the tonic
    this._droneGain = ac.createGain();
    this._droneGain.gain.value = 0.05;
    this._droneGain.connect(this._gain);
    for (const detune of [-4, 3]) {
      const osc = ac.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = 110;
      osc.detune.value = detune;
      osc.connect(this._droneGain);
      osc.start();
    }
    const fifth = ac.createOscillator();
    fifth.type = 'sine';
    fifth.frequency.value = 164.8;
    const fg = ac.createGain();
    fg.gain.value = 0.35;
    fifth.connect(fg).connect(this._droneGain);
    fifth.start();
  }

  _pickContext() {
    const ctx = this.ctx;
    if (ctx.mode === 'menu') return 'title';
    const threat = ctx.enemies?.threatLevel ?? 0;
    if (threat === 2) return 'combat';
    const screen = ctx.ui?.activeScreen;
    if (screen === 'tavern' || screen === 'market' || screen === 'shipwright' ||
      screen === 'dock' || screen === 'questboard') return 'port';
    if (threat === 1) return 'tension';
    if (ctx.weather?.condition === 'storm') return 'storm';
    const focus = ctx.mode === 'foot' ? ctx.character?.position : ctx.playerShip?.ship?.position;
    if (focus) {
      const near = ctx.world?.getNearestPort?.(focus);
      if (near && near.distance < 160) return 'port';
    }
    const frac = ctx.time.dayFrac;
    if (frac < 0.2 || frac > 0.85) return 'night';
    return 'calm';
  }

  _note(freq, dur, vol, type = 'triangle', when = 0) {
    const a = this.ctx.audio;
    const ac = a.ac;
    const t0 = ac.currentTime + when;
    const osc = ac.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.04);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this._gain);
    osc.start(t0);
    osc.stop(t0 + dur + 0.1);
  }

  _drum(kind, when = 0) {
    const a = this.ctx.audio;
    const ac = a.ac;
    const t0 = ac.currentTime + when;
    if (kind === 'kick') {
      const osc = ac.createOscillator();
      osc.frequency.setValueAtTime(120, t0);
      osc.frequency.exponentialRampToValueAtTime(38, t0 + 0.14);
      const g = ac.createGain();
      g.gain.setValueAtTime(0.5, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.22);
      osc.connect(g).connect(this._gain);
      osc.start(t0);
      osc.stop(t0 + 0.3);
    } else {
      const src = ac.createBufferSource();
      src.buffer = a.noiseBuffer('white');
      const f = ac.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 2400;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.14, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.09);
      src.connect(f).connect(g).connect(this._gain);
      src.start(t0);
      src.stop(t0 + 0.12);
    }
  }

  update(dt) {
    const a = this.ctx.audio;
    if (!a?.ready) return;
    this._ensureNodes();
    if (!this._gain) return;

    const next = this._pickContext();
    if (next !== this.context) {
      this.context = next;
      this._phrase = 0;
    }
    const conf = CONTEXTS[this.context];
    // smooth volume toward the context level
    this._contextVol += (conf.vol - this._contextVol) * Math.min(1, dt * 0.4);
    this._gain.gain.setTargetAtTime(this._contextVol, a.ac.currentTime, 0.8);
    this._droneGain?.gain.setTargetAtTime(conf.drone ? 0.05 : 0.004, a.ac.currentTime, 1.2);

    // beat scheduler
    this._nextNote -= dt;
    if (this._nextNote > 0) return;
    const beatLen = 60 / conf.tempo;
    this._nextNote = beatLen / 2; // eighth-note grid
    this._beat = (this._beat + 1) % 16;

    const scale = SCALES[conf.scale];

    // drums
    if (conf.drums) {
      if (this._beat % 4 === 0) this._drum('kick');
      if (this._beat % 8 === 4) this._drum('snare');
    }
    if (this.context === 'port' && this._beat % 2 === 0) {
      // oompah bass for the jig
      this._note(this._beat % 4 === 0 ? 110 : 164.8, beatLen * 0.5, 0.09, 'sine');
    }

    // melody: seeded-feeling random walk with cadences
    if (Math.random() < conf.density) {
      // walk the scale; resolve to the tonic at phrase ends
      this._degree += Math.round((Math.random() - 0.5) * 3.4);
      this._degree = Math.max(0, Math.min(scale.length - 1, this._degree));
      if (this._beat === 15 && Math.random() < 0.7) this._degree = 0;
      const octave = this.context === 'port' ? 2 : Math.random() < 0.25 ? 2 : 1;
      const freq = scale[this._degree] * octave;
      const dur = beatLen * (Math.random() < 0.3 ? 1.6 : 0.9);
      this._note(freq, dur, this.context === 'combat' ? 0.11 : 0.085,
        this.context === 'port' ? 'square' : 'triangle');
      // occasional harmony a third below
      if (Math.random() < 0.18 && this._degree >= 2) {
        this._note(scale[this._degree - 2] * octave, dur * 1.1, 0.045);
      }
    }
  }
}
