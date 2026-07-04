// Generative score: original modal sea-shanty flavour over a tonic drone.
// Melodies are quantized to the active scale and phrased to a cadence (they arc
// up to a peak, then resolve home to the tonic), so it always sounds composed,
// never dissonant, never a random wandering. Layers — drone, warm pad, bass,
// melody, and (in a fight) drums — fade between moods over several seconds.
//
// Everything shares the tonic A, so the drone stays put while the mode shifts
// dorian → aeolian → pentatonic underneath it. Modest volume, read from the
// settings via the music bus.
import { clamp, randRange } from '../core/utils.js';
import { Sfx } from './sfx.js';

// Scales as frequencies, all rooted on A (so they sit on the A/E drone).
const SCALES = {
  // A dorian — bright, hopeful, sea-faring (has the major 6th, F#)
  calm: [220, 246.94, 261.63, 293.66, 329.63, 369.99, 392.00],
  // A aeolian — darker natural minor (F natural) for storm & dread
  dark: [220, 246.94, 261.63, 293.66, 329.63, 349.23, 392.00],
  // A minor pentatonic — singable, lively, never a wrong note (port jig)
  jig: [220, 261.63, 293.66, 329.63, 392.00],
};

const CONTEXTS = {
  title:   { tempo: 50,  density: 0.32, scale: 'calm', drone: true,  bass: true,  pad: true,  drums: false, hats: false, vol: 0.5,  bright: 2800 },
  calm:    { tempo: 60,  density: 0.30, scale: 'calm', drone: true,  bass: true,  pad: true,  drums: false, hats: false, vol: 0.4,  bright: 2600 },
  night:   { tempo: 52,  density: 0.18, scale: 'calm', drone: true,  bass: false, pad: true,  drums: false, hats: false, vol: 0.3,  bright: 1500 },
  storm:   { tempo: 68,  density: 0.40, scale: 'dark', drone: true,  bass: true,  pad: true,  drums: false, hats: false, vol: 0.44, bright: 1900 },
  tension: { tempo: 78,  density: 0.42, scale: 'dark', drone: true,  bass: true,  pad: false, drums: false, hats: false, vol: 0.46, bright: 2300 },
  combat:  { tempo: 112, density: 0.60, scale: 'dark', drone: true,  bass: true,  pad: false, drums: true,  hats: true,  vol: 0.6,  bright: 3600 },
  port:    { tempo: 100, density: 0.70, scale: 'jig',  drone: false, bass: true,  pad: false, drums: false, hats: true,  vol: 0.5,  bright: 4200 },
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
    this._peak = 4;
    this._gain = null;
    this._lp = null;
    this._droneGain = null;
  }

  _ensureNodes() {
    const a = this.ctx.audio;
    if (!a?.ready || this._gain) return;
    const ac = a.ac;

    this._gain = ac.createGain();
    this._gain.gain.value = 0.0001;
    // a warmth lowpass whose cutoff tracks the mood's brightness
    this._lp = ac.createBiquadFilter();
    this._lp.type = 'lowpass';
    this._lp.frequency.value = 2600;
    this._gain.connect(this._lp).connect(a.musicBus);
    // a whisper of the shared reverb space for bloom
    a.sendReverb?.(this._gain, 0.12);

    // drone: detuned sines on the tonic + a fifth + a low octave for weight
    this._droneGain = ac.createGain();
    this._droneGain.gain.value = 0.05;
    this._droneGain.connect(this._gain);
    const drone = (freq, detune, gain) => {
      const osc = ac.createOscillator();
      osc.type = 'sine';
      osc.frequency.value = freq;
      osc.detune.value = detune;
      const g = ac.createGain();
      g.gain.value = gain;
      osc.connect(g).connect(this._droneGain);
      osc.start();
    };
    drone(110, -4, 1.0);
    drone(110, 3, 1.0);
    drone(164.81, 0, 0.35);  // the fifth (E)
    drone(55, 0, 0.5);       // sub octave
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
      if (near && near.distance < 170) return 'port';
    }
    const frac = ctx.time.dayFrac;
    if (frac < 0.2 || frac > 0.85) return 'night';
    return 'calm';
  }

  _note(freq, dur, vol, type = 'triangle', when = 0) {
    const ac = this.ctx.audio.ac;
    const t0 = ac.currentTime + when;
    const osc = ac.createOscillator();
    osc.type = type;
    osc.frequency.value = freq;
    osc.detune.value = randRange(Math.random, -5, 5);
    const lp = ac.createBiquadFilter();
    lp.type = 'lowpass';
    lp.frequency.value = Math.min(6000, freq * 3.5 + 500);
    const g = ac.createGain();
    const atk = Math.min(0.05, dur * 0.25);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(Math.max(vol, 0.0002), t0 + atk);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(lp).connect(g).connect(this._gain);
    osc.start(t0);
    osc.stop(t0 + dur + 0.1);
  }

  _bass(freq, dur, when = 0) {
    const ac = this.ctx.audio.ac;
    const t0 = ac.currentTime + when;
    const osc = ac.createOscillator();
    osc.type = 'sine';
    osc.frequency.value = freq;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(0.11, t0 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this._gain);
    osc.start(t0);
    osc.stop(t0 + dur + 0.1);
  }

  _chord(freqs, dur, vol, when = 0) {
    for (const f of freqs) this._note(f, dur, vol, 'sine', when);
  }

  _drum(kind, when = 0, vol = 1) {
    const ac = this.ctx.audio.ac;
    const t0 = ac.currentTime + when;
    if (kind === 'kick') {
      const osc = ac.createOscillator();
      osc.frequency.setValueAtTime(120, t0);
      osc.frequency.exponentialRampToValueAtTime(38, t0 + 0.14);
      const g = ac.createGain();
      g.gain.setValueAtTime(0.5 * vol, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.22);
      osc.connect(g).connect(this._gain);
      osc.start(t0);
      osc.stop(t0 + 0.3);
    } else if (kind === 'hat') {
      const src = ac.createBufferSource();
      src.buffer = this.ctx.audio.noiseBuffer('white');
      const f = ac.createBiquadFilter();
      f.type = 'highpass';
      f.frequency.value = 7000;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.05 * vol, t0);
      g.gain.exponentialRampToValueAtTime(0.001, t0 + 0.05);
      src.connect(f).connect(g).connect(this._gain);
      src.start(t0);
      src.stop(t0 + 0.07);
    } else {
      const src = ac.createBufferSource();
      src.buffer = this.ctx.audio.noiseBuffer('white');
      const f = ac.createBiquadFilter();
      f.type = 'bandpass';
      f.frequency.value = 2400;
      const g = ac.createGain();
      g.gain.setValueAtTime(0.14 * vol, t0);
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
      this._beat = 0; // start the new mood cleanly on a downbeat
    }
    const conf = CONTEXTS[this.context];
    const t = a.ac.currentTime;

    // smooth, multi-second crossfades of level, warmth and drone
    this._gain.gain.setTargetAtTime(conf.vol, t, 2.0);
    this._lp.frequency.setTargetAtTime(conf.bright, t, 1.6);
    this._droneGain.gain.setTargetAtTime(conf.drone ? 0.05 : 0.003, t, 1.4);

    // eighth-note scheduler
    this._nextNote -= dt;
    if (this._nextNote > 0) return;
    const beatLen = 60 / conf.tempo;
    this._nextNote = beatLen / 2;
    this._beat = (this._beat + 1) % 16;
    if (this._beat === 0) this._phrase++;

    const scale = SCALES[conf.scale];

    // --- plan a fresh phrase: choose a melodic peak to arc toward -----------
    if (this._beat === 0) {
      this._peak = 2 + Math.floor(Math.random() * (scale.length - 2));
    }

    // --- rhythm section -----------------------------------------------------
    if (conf.drums) {
      if (this._beat % 4 === 0) this._drum('kick');
      if (this._beat % 8 === 4) this._drum('snare');
      if (conf.hats && this._beat % 2 === 1) this._drum('hat', 0, 0.7);
    } else if (this.context === 'port' && conf.hats) {
      if (this._beat % 4 === 0) this._drum('kick', 0, 0.4);
      if (this._beat % 2 === 1) this._drum('hat', 0, 0.5);
    }

    // bass: a rocking I–V, or an oompah lilt in port
    if (conf.bass) {
      if (this.context === 'port') {
        if (this._beat % 2 === 0) this._bass(this._beat % 4 === 0 ? 110 : 164.81, beatLen * 0.5);
      } else if (this._beat === 0 || this._beat === 8) {
        this._bass(110, beatLen * 1.4);
      } else if (this._beat === 4 || this._beat === 12) {
        this._bass(164.81, beatLen * 1.2);
      }
    }

    // warm pad chord blooms at the head of each phrase
    if (conf.pad && this._beat === 0) {
      this._chord([scale[0], scale[2], scale[4]], beatLen * 8, 0.022, 0);
    }

    // --- melody: arc to the peak, resolve home to the tonic -----------------
    if (Math.random() < conf.density) {
      const firstHalf = this._beat < 8;
      // clamp to the ACTIVE scale — _peak may exceed the shorter pentatonic
      // 'jig' scale after a context switch, which would index undefined -> NaN
      const target = clamp(firstHalf ? this._peak : 0, 0, scale.length - 1);
      if (Math.abs(target - this._degree) <= 1) {
        this._degree = target;
      } else {
        const dir = Math.sign(target - this._degree);
        this._degree = clamp(this._degree + dir * (Math.random() < 0.6 ? 1 : 2), 0, scale.length - 1);
      }
      // firm cadence to the tonic at the phrase end
      if (this._beat >= 14) this._degree = 0;

      const octave = this.context === 'port' ? 2 : (Math.random() < 0.25 ? 2 : 1);
      const freq = scale[this._degree] * octave;
      const long = this._beat % 4 === 0 || this._beat >= 14;
      const dur = beatLen * (long ? 1.5 : 0.85);
      const type = this.context === 'port' ? 'square'
        : this.context === 'combat' ? 'sawtooth' : 'triangle';
      const vol = this.context === 'combat' ? 0.1 : this.context === 'port' ? 0.095 : 0.08;
      this._note(freq, dur, vol, type);

      // a consonant harmony a scale-third below, sparingly
      if (Math.random() < 0.16 && this._degree >= 2) {
        this._note(scale[this._degree - 2] * octave, dur * 1.05, vol * 0.5, 'sine');
      }
    }
  }
}
