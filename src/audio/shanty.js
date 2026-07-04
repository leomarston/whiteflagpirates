// Procedural sea shanties + crew voice — the vocal life of the ship. While you
// sail with hands aboard, the fo'c'sle sings: a lone shanty-man calls a short
// modal line and the crew answers in a rougher unison, a slow rolling meter over
// and over with rests of open sea between passes. It ducks out the moment a
// fight starts, and the crew throws short wordless barks — a gruff "heave" on the
// guns, a rallying shout at a boarding, a cheer when a prize goes down.
//
// Every voice is synthesized: a buzzy sawtooth glottal source sung on a dorian
// melody, shaped by a small stack of bandpass "formant" filters into an open
// vowel timbre (oh / oo / ah / ey) — no lyrics, no samples, nothing borrowed.
// Output rides the shared musicBus so the global volume/mute govern it, and it
// sits deliberately low: it accompanies the sea, it never leads.
import { clamp, randRange, randInt } from '../core/utils.js';

// A dorian mode rooted low on D — warm, sea-faring, a shade melancholy. Stored
// as absolute frequencies so a scale degree is a plain array lookup (no pow in
// the hot path). D E F G A B C D E over roughly a male vocal register.
const F0 = 146.83;
const DORIAN = [0, 2, 3, 5, 7, 9, 10, 12, 14].map((s) => F0 * Math.pow(2, s / 12));

// Vowel formant tables: [centreHz, gain] per formant. Filtering the buzzy source
// through these parallel bandpasses is what turns an oscillator into a "voice".
const VOWELS = {
  oh: [[400, 0.8], [760, 0.4], [2400, 0.12]],
  oo: [[350, 0.8], [640, 0.3], [2300, 0.10]],
  ah: [[720, 0.7], [1150, 0.5], [2600, 0.14]],
  ey: [[500, 0.6], [1700, 0.45], [2500, 0.16]],
};

// How long the singing stays ducked after the last shot / hit (seconds).
const COMBAT_DUCK = 7;
// The verse's fade-in level on the sing bus — kept low so it merely accompanies.
const SING_LEVEL = 0.62;
// Per-bark minimum spacing so a rolling broadside doesn't turn into a chorus.
const BARK_MIN = { heave: 2.4, rally: 8, cheer: 6 };

export class Shanty {
  constructor(ctx) {
    this.ctx = ctx;
    // audio graph (lazily built once the shared AudioContext exists)
    this._out = null;
    this._warm = null;
    this._singGain = null;
    this._barkGain = null;

    // verse scheduler state
    this._phase = 'rest';
    this._restT = randRange(Math.random, 4, 9); // a beat of quiet before the first verse
    this._events = null;
    this._beat = 0;
    this._beatT = 0;
    this._total = 0;
    this._beatLen = 0.58; // slow rolling meter

    // combat ducking + bark rate-limiting
    this._lastCombatCue = -99;
    this._barkAt = { heave: -99, rally: -99, cheer: -99 };
    this._lastBark = -99;

    const on = (name, fn) => ctx.events?.on(name, fn);
    // any gunfire / impact ducks the shanty; the player's own guns also bark
    on('cannon:fire', ({ isPlayer } = {}) => {
      this._lastCombatCue = this._now();
      if (isPlayer) this._bark('heave');
    });
    on('ship:hit', () => { this._lastCombatCue = this._now(); });
    // rallying shouts as steel meets the rail
    on('boarding:offer', () => this._bark('rally'));
    on('boarding:accept', () => this._bark('rally'));
    // a cheer when the player sends one to the bottom
    on('ship:sunk', ({ byPlayer } = {}) => { if (byPlayer) this._bark('cheer'); });
  }

  _now() {
    return this.ctx.audio?.ac?.currentTime ?? 0;
  }

  // Crew count from either the crew system (roster getter or fn) or raw state.
  _crewCount() {
    const r = this.ctx.crew?.roster;
    if (Array.isArray(r)) return r.length;
    if (typeof r === 'function') { try { return r()?.length ?? 0; } catch { return 0; } }
    return this.ctx.state?.data?.crew?.length ?? 0;
  }

  _ensureNodes() {
    const a = this.ctx.audio;
    if (!a?.ready || this._out) return;
    const ac = a.ac;

    // out → warmth lowpass → shared music bus (so volume/mute apply), + a whisper
    // of the reverb space so the voices bloom out over the water like the music.
    this._out = ac.createGain();
    this._out.gain.value = 0.9;
    this._warm = ac.createBiquadFilter();
    this._warm.type = 'lowpass';
    this._warm.frequency.value = 3200;
    this._out.connect(this._warm).connect(a.musicBus);
    a.sendReverb?.(this._out, 0.18);

    // the sing bus fades whole verses in/out and ducks for combat
    this._singGain = ac.createGain();
    this._singGain.gain.value = 0.0001;
    this._singGain.connect(this._out);
    // barks bypass the duck — they ARE combat, and should be heard through it
    this._barkGain = ac.createGain();
    this._barkGain.gain.value = 0.9;
    this._barkGain.connect(this._out);
  }

  _degFreq(deg) {
    return DORIAN[clamp(deg | 0, 0, DORIAN.length - 1)];
  }

  // A rising, arcing line of 4 degrees resolving toward a chosen peak — composed,
  // never a random wander (mirrors the melodic shaping in music.js).
  _genLine(startDeg, peakDeg) {
    const out = [];
    let d = startDeg;
    for (let i = 0; i < 4; i++) {
      if (i === 3) { d = peakDeg; }
      else {
        const dir = Math.sign(peakDeg - d) || 1;
        d = clamp(d + dir * (Math.random() < 0.6 ? 1 : 2), 0, DORIAN.length - 1);
      }
      out.push(d);
    }
    return out;
  }

  // Lay out one verse: two call-and-response couplets over 16 beats. The
  // shanty-man calls a four-note line; the crew answers with two long held
  // vowels, and the final answer resolves home to the tonic.
  _buildVerse() {
    const bl = this._beatLen;
    const ev = [];
    for (let c = 0; c < 2; c++) {
      const base = c * 8;
      const peak = randInt(Math.random, 3, DORIAN.length - 2);
      const call = this._genLine(0, peak);
      call.forEach((deg, i) => ev.push({
        beat: base + i, kind: 'call', deg,
        dur: bl * (i === 3 ? 1.5 : 0.9), vowel: i % 2 ? 'oo' : 'oh',
      }));
      const midDeg = clamp(peak - 2, 0, DORIAN.length - 1);
      const endDeg = c === 1 ? 0 : clamp(peak - 3, 0, DORIAN.length - 1);
      ev.push({ beat: base + 4, kind: 'resp', deg: midDeg, dur: bl * 1.8, vowel: 'oh' });
      ev.push({ beat: base + 6, kind: 'resp', deg: endDeg, dur: bl * 2.2, vowel: 'ah' });
    }
    this._events = ev;
    this._total = 16;
    this._beat = 0;
    this._beatT = 0; // fire the downbeat on the next tick
  }

  _fireBeat() {
    const evs = this._events;
    if (!evs) return;
    for (const ev of evs) {
      if (ev.beat !== this._beat) continue;
      const freq = this._degFreq(ev.deg);
      if (ev.kind === 'call') {
        // lone shanty-man: single clean voice, a little portamento into pitch
        this._sing(this._singGain, 0, freq, ev.dur,
          { vowel: ev.vowel, voices: 1, peak: 0.085, glide: 0.93 });
      } else {
        // the crew answers: doubled, rougher, with an octave below for weight
        this._sing(this._singGain, 0, freq, ev.dur,
          { vowel: ev.vowel, voices: 2, peak: 0.055, glide: 0.965, rough: true, sub: true });
      }
    }
  }

  /**
   * Sing a single sustained note as a small stack of formant-filtered sawtooth
   * "voices". opts: { vowel, voices, peak, glide (start-pitch multiplier for a
   * sung slide-in), rough (thicker vibrato + breath), sub (add an octave below) }.
   * All nodes are one-shot and self-stopping — no per-frame allocation, this runs
   * only when a note is scheduled (a couple of times a second at most).
   */
  _sing(target, when, freq, dur, opts = {}) {
    const a = this.ctx.audio;
    if (!a?.ready || !target) return;
    const ac = a.ac;
    const t0 = ac.currentTime + Math.max(0, when);
    const vowel = VOWELS[opts.vowel] || VOWELS.oh;
    const voices = opts.voices ?? 1;
    const peak = opts.peak ?? 0.08;
    const glide = opts.glide ?? 1;
    const rough = !!opts.rough;

    // shared amplitude envelope for the whole note: soft sung attack, hold, release
    const voiceGain = ac.createGain();
    const atk = Math.min(0.09, dur * 0.3);
    const rel = Math.min(0.35, dur * 0.5);
    const g = voiceGain.gain;
    g.setValueAtTime(0.0001, t0);
    g.linearRampToValueAtTime(peak, t0 + atk);
    g.setValueAtTime(peak, t0 + Math.max(atk, dur - rel));
    g.exponentialRampToValueAtTime(0.0001, t0 + dur);
    voiceGain.connect(target);

    const mkVoice = (f, det, level) => {
      const osc = ac.createOscillator();
      osc.type = 'sawtooth';
      osc.frequency.setValueAtTime(f * glide, t0);
      if (glide !== 1) osc.frequency.exponentialRampToValueAtTime(Math.max(f, 8), t0 + Math.min(0.14, dur * 0.4));
      else osc.frequency.setValueAtTime(f, t0);
      osc.detune.value = det;
      // vibrato — a human waver on the sustained vowel
      const lfo = ac.createOscillator();
      lfo.type = 'sine';
      lfo.frequency.value = rough ? 6.4 : 5.2;
      const ld = ac.createGain();
      ld.gain.value = rough ? 14 : 8; // cents
      lfo.connect(ld).connect(osc.detune);
      // parallel formant stack → this voice's mix
      const mix = ac.createGain();
      mix.gain.value = level;
      for (let i = 0; i < vowel.length; i++) {
        const bp = ac.createBiquadFilter();
        bp.type = 'bandpass';
        bp.frequency.value = vowel[i][0];
        bp.Q.value = i === 0 ? 9 : 11;
        const fg = ac.createGain();
        fg.gain.value = vowel[i][1] * (rough ? 1.05 : 1);
        osc.connect(bp).connect(fg).connect(mix);
      }
      mix.connect(voiceGain);
      osc.start(t0);
      osc.stop(t0 + dur + 0.12);
      lfo.start(t0);
      lfo.stop(t0 + dur + 0.12);
    };

    const spread = voices > 1 ? 9 : 0; // cents of chorus detune across the unison
    const norm = 1 / Math.sqrt(voices);
    for (let v = 0; v < voices; v++) {
      const det = voices > 1
        ? (v - (voices - 1) / 2) * spread + (Math.random() * 4 - 2)
        : (Math.random() * 6 - 3);
      mkVoice(freq, det, norm);
    }
    if (opts.sub) mkVoice(freq * 0.5, Math.random() * 6 - 3, norm * 0.5);
  }

  // Short wordless crew barks, rate-limited, only with hands aboard at sea.
  _bark(kind) {
    const a = this.ctx.audio;
    if (!a?.ready) return;
    this._ensureNodes();
    if (!this._barkGain) return;
    if (this.ctx.mode !== 'sail' || this._crewCount() <= 0) return;
    const now = a.ac.currentTime;
    if (now - (this._barkAt[kind] ?? -99) < (BARK_MIN[kind] ?? 4)) return;
    if (now - this._lastBark < 0.7) return; // global anti-spam
    this._barkAt[kind] = now;
    this._lastBark = now;
    const r = Math.random;

    if (kind === 'heave') {
      // a gruff, low grunt swelling up under the recoil
      const f = 130 * randRange(r, 0.96, 1.06);
      this._sing(this._barkGain, 0, f, 0.5, { vowel: 'ah', voices: 1, peak: 0.13, glide: 0.72, rough: true });
    } else if (kind === 'rally') {
      // a bright unison shout going up over the rail, with a low body under it
      const f = 196 * randRange(r, 0.97, 1.05);
      this._sing(this._barkGain, 0, f, 0.6, { vowel: 'ey', voices: 2, peak: 0.10, glide: 0.84, rough: true });
      this._sing(this._barkGain, 0, f * 0.5, 0.55, { vowel: 'oh', voices: 1, peak: 0.06, glide: 0.84, rough: true });
    } else {
      // a ragged crowd cheer — a few staggered voices at scattered pitches
      for (let i = 0; i < 3; i++) {
        const f = 220 * randRange(r, 0.9, 1.12);
        this._sing(this._barkGain, i * 0.03, f, randRange(r, 0.6, 0.9),
          { vowel: i ? 'ah' : 'oh', voices: 1, peak: 0.075, glide: 0.9, rough: true });
      }
    }
  }

  update(dt) {
    const a = this.ctx.audio;
    if (!a?.ready) return;
    this._ensureNodes();
    if (!this._out) return;
    const ac = a.ac;
    const t = ac.currentTime;
    const ctx = this.ctx;

    // only sing at the helm, with a crew, out of a fight
    const sailing = ctx.mode === 'sail';
    const hasCrew = this._crewCount() > 0;
    const combatNow = !!ctx.combat?.currentTarget || (t - this._lastCombatCue) < COMBAT_DUCK;
    const wants = sailing && hasCrew && !combatNow;

    // fade the verse in slowly; duck it out quickly when a fight breaks
    const singOn = wants && this._phase === 'sing';
    this._singGain.gain.setTargetAtTime(singOn ? SING_LEVEL : 0.0001, t, singOn ? 1.4 : 0.5);

    if (this._phase === 'sing') {
      if (!wants) {
        // abandon the verse; rest a while before trying again
        this._phase = 'rest';
        this._restT = randRange(Math.random, 6, 12);
        return;
      }
      this._beatT -= dt;
      if (this._beatT <= 0) {
        this._fireBeat();
        this._beat++;
        this._beatT += this._beatLen;
        if (this._beat >= this._total) {
          // a stretch of open-sea quiet between passes
          this._phase = 'rest';
          this._restT = randRange(Math.random, 9, 17);
        }
      }
    } else {
      if (!wants) {
        // don't pounce the instant combat clears — keep a little calm in hand
        this._restT = Math.max(this._restT, 3);
        return;
      }
      this._restT -= dt;
      if (this._restT <= 0) {
        this._buildVerse();
        this._phase = 'sing';
      }
    }
  }
}
