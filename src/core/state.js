// Frozen shared game state + persistence. See docs/CONTRACTS.md.
import { ECONOMY, SAVE_KEY } from './constants.js';

function defaultData() {
  return {
    version: 1,
    gold: ECONOMY.START_GOLD,
    xp: 0,
    level: 1,
    skillPoints: 0,
    skills: {},                    // { skillKey: true }
    reputation: { corsairs: 25, crown: -15, concern: 0, tidebound: 0 },
    cargo: {},                     // { goodKey: qty }
    crew: [],                      // filled by crew system on new game
    ship: {
      type: 'sloop',
      name: 'White Gull',
      hullTier: 1,
      sailTier: 1,
      cannonTier: 1,
      paint: 'default',
      hull: null,                  // null = full; persisted current hp
    },
    quests: { active: [], completed: [], progress: {} },
    maps: [],                      // treasure maps
    discovered: ['gullhaven'],     // island ids seen
    flags: {},                     // arbitrary story flags
    position: null,                // [x, z, heading] of ship at save
    dayFrac: null,
    timePlayed: 0,
    logEntries: [],                // captain's log
  };
}

function defaultSettings() {
  return {
    quality: 'high',               // 'low' | 'medium' | 'high'
    volumeMaster: 0.8,
    volumeMusic: 0.6,
    volumeSfx: 0.9,
    invertY: false,
    fov: 60,
  };
}

export class GameState {
  constructor(events) {
    this.events = events;
    this.data = defaultData();
    this.settings = defaultSettings();
    this._loadSettings();
  }

  hasSave() {
    try {
      return localStorage.getItem(SAVE_KEY) != null;
    } catch {
      return false;
    }
  }

  save() {
    try {
      localStorage.setItem(SAVE_KEY, JSON.stringify(this.data));
      localStorage.setItem(SAVE_KEY + '_settings', JSON.stringify(this.settings));
      this.events?.emit('state:saved');
      return true;
    } catch (err) {
      console.warn('[state] save failed', err);
      return false;
    }
  }

  load() {
    try {
      const raw = localStorage.getItem(SAVE_KEY);
      if (!raw) return false;
      const parsed = JSON.parse(raw);
      this.data = { ...defaultData(), ...parsed };
      this.events?.emit('state:loaded');
      return true;
    } catch (err) {
      console.warn('[state] load failed', err);
      return false;
    }
  }

  _loadSettings() {
    try {
      const raw = localStorage.getItem(SAVE_KEY + '_settings');
      if (raw) this.settings = { ...defaultSettings(), ...JSON.parse(raw) };
    } catch { /* defaults are fine */ }
  }

  saveSettings() {
    try {
      localStorage.setItem(SAVE_KEY + '_settings', JSON.stringify(this.settings));
    } catch { /* ignore */ }
  }

  reset() {
    this.data = defaultData();
    try {
      localStorage.removeItem(SAVE_KEY);
    } catch { /* ignore */ }
    this.events?.emit('state:reset');
  }

  addGold(n) {
    this.data.gold = Math.max(0, Math.round(this.data.gold + n));
    this.events?.emit('gold:change', this.data.gold);
    return this.data.gold;
  }

  addLog(text) {
    this.data.logEntries.push({ t: Date.now(), text });
    if (this.data.logEntries.length > 120) this.data.logEntries.shift();
    this.events?.emit('log', { text });
  }
}
