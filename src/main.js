// WhiteFlagPirates — boot & orchestration. Owns ctx wiring and game flow.
import { Engine } from './core/engine.js';
import { EventBus } from './core/events.js';
import { Input } from './core/input.js';
import { GameState } from './core/state.js';
import { WORLD } from './core/constants.js';
import { mulberry32, hashSeed } from './core/utils.js';

import './ui/styles.css';

import { ISLANDS } from './data/islands.js';
import { FACTIONS } from './data/factions.js';
import { GOODS } from './data/goods.js';
import * as NAMES from './data/names.js';
import { QUESTS } from './data/quests.js';
import { LORE } from './data/lore.js';

import { Ocean } from './world/ocean.js';
import { Sky } from './world/sky.js';
import { Weather } from './world/weather.js';
import { World } from './world/worldgen.js';
import { ShipManager } from './ship/ship.js';
import { PlayerShip } from './ship/playerShip.js';
import { Effects } from './combat/effects.js';
import { NavalCombat } from './combat/naval.js';
import { EnemyFleet } from './combat/enemyAI.js';
import { Character } from './character/player.js';
import { NPCManager } from './character/npc.js';
import { Animals } from './character/animals.js';
import { Economy } from './systems/economy.js';
import { Crew } from './systems/crew.js';
import { Quests } from './systems/quests.js';
import { Treasure } from './systems/treasure.js';
import { Progression } from './systems/progression.js';
import { Encounters } from './systems/encounters.js';
import { AudioEngine } from './audio/audio.js';
import { Music } from './audio/music.js';
import { UI } from './ui/ui.js';

const events = new EventBus();
const state = new GameState(events);
const input = new Input(window);
const engine = new Engine(document.getElementById('app'), state.settings, events);

const ctx = {
  engine,
  scene: engine.scene,
  camera: engine.camera,
  renderer: engine.renderer,
  events,
  input,
  state,
  rng: mulberry32(hashSeed('meridian-verge')),
  time: {
    t: 0,
    dt: 0,
    dayFrac: WORLD.START_DAYFRAC,
    dayLength: WORLD.DAY_LENGTH,
    paused: false,
  },
  mode: 'menu',
  setMode(mode) {
    const prev = ctx.mode;
    if (prev === mode) return;
    ctx.mode = mode;
    events.emit('mode:change', { mode, prev });
  },
  data: {
    islands: ISLANDS,
    factions: FACTIONS,
    goods: GOODS,
    names: NAMES,
    quests: QUESTS,
    lore: LORE,
  },
};

// --- construct systems (contract order); collect failures loudly ---
const bootErrors = [];
function construct(key, Ctor) {
  try {
    ctx[key] = new Ctor(ctx);
  } catch (err) {
    bootErrors.push({ key, err });
    console.error(`[boot] failed to construct ${key}:`, err);
    ctx[key] = null;
  }
}

construct('ocean', Ocean);
construct('sky', Sky);
construct('weather', Weather);
construct('world', World);
construct('ships', ShipManager);
construct('playerShip', PlayerShip);
construct('effects', Effects);
construct('combat', NavalCombat);
construct('enemies', EnemyFleet);
construct('character', Character);
construct('npcs', NPCManager);
construct('animals', Animals);
construct('economy', Economy);
construct('crew', Crew);
construct('quests', Quests);
construct('treasure', Treasure);
construct('progression', Progression);
construct('encounters', Encounters);
construct('audio', AudioEngine);
construct('music', Music);
construct('ui', UI);

if (bootErrors.length) {
  console.error(`[boot] ${bootErrors.length} system(s) failed:`, bootErrors.map((b) => b.key).join(', '));
}

// --- game flow -------------------------------------------------------------

const gullhaven = ISLANDS.find((i) => i.id === 'gullhaven') ?? ISLANDS[0];

function startPositionFor(fresh) {
  const saved = ctx.state.data.position;
  if (!fresh && saved) return { x: saved[0], z: saved[2] ?? saved[1], heading: saved[3] ?? saved[2] ?? 0 };
  // just off Gullhaven's harbor
  const [ix, iz] = gullhaven.position;
  const island = ctx.world?.islands?.find((w) => w.def.id === gullhaven.id);
  if (island?.port) {
    const d = island.port.dockPosition;
    const away = Math.atan2(d.x - island.center.x, d.z - island.center.z);
    // spawn seaward of the dock, bow pointing to open water
    return { x: d.x + Math.sin(away) * 150, z: d.z + Math.cos(away) * 150, heading: away };
  }
  return { x: ix + gullhaven.radius + 260, z: iz, heading: -Math.PI / 2 };
}

events.on('game:start', ({ fresh }) => {
  if (fresh) ctx.state.reset();
  else ctx.state.load();
  if (ctx.state.data.dayFrac != null) ctx.time.dayFrac = ctx.state.data.dayFrac;
  const p = startPositionFor(fresh);
  ctx.playerShip?.placeAt?.(p.x, p.z, p.heading);
  ctx.setMode('sail');
  if (fresh) {
    ctx.state.addLog('Weighed anchor at Gullhaven. The Verge is wide and owes me a living.');
    events.emit('toast', { text: 'Welcome to the Meridian Verge, Captain.', kind: 'info' });
  }
});

function persist() {
  const g = ctx.playerShip?.ship?.group;
  if (g) ctx.state.data.position = [g.position.x, g.position.z, ctx.playerShip.heading ?? 0];
  ctx.state.data.dayFrac = ctx.time.dayFrac;
  ctx.state.save();
}

events.on('ship:dock', ({ port, island }) => {
  events.emit('ship:undocked-clear');
  events.emit('port:menu', { port, island });
  persist();
});

events.on('player:death', () => {
  setTimeout(() => events.emit('player:respawn'), 100);
});

events.on('player:respawn', () => {
  const near = ctx.world?.getNearestPort?.(ctx.camera.position);
  const dock = near?.port?.dockPosition;
  ctx.state.addGold(-Math.round(ctx.state.data.gold * 0.1));
  if (ctx.character && dock) {
    ctx.character.hp = ctx.character.hpMax ?? 100;
    ctx.character.spawnAt(dock, 0);
    ctx.setMode('foot');
  } else {
    ctx.setMode('sail');
  }
});

// island discovery
let discoverTimer = 0;
function checkDiscovery(dt) {
  discoverTimer -= dt;
  if (discoverTimer > 0 || !ctx.world) return;
  discoverTimer = 2;
  const pos = ctx.playerShip?.ship?.group?.position ?? ctx.camera.position;
  for (const isl of ctx.world.islands ?? []) {
    if (pos.distanceTo(isl.center) < isl.radius + 320) {
      const id = isl.def.id;
      if (!ctx.state.data.discovered.includes(id)) {
        ctx.state.data.discovered.push(id);
        events.emit('island:discovered', { island: isl });
        events.emit('toast', { text: `Discovered — ${isl.def.name}`, kind: 'discover' });
        ctx.state.addLog(`Sighted ${isl.def.name}. Marked it on the chart.`);
      }
    }
  }
}

// return-to-ship interaction in foot mode
function checkBoardOwnShip() {
  if (ctx.mode !== 'foot' || !ctx.character || !ctx.playerShip?.ship) return;
  const shipPos = ctx.playerShip.ship.group.position;
  const d = ctx.character.position.distanceTo(shipPos);
  const near = d < Math.max(14, (ctx.playerShip.ship.type?.length ?? 20) * 0.75);
  if (near) {
    events.emit('prompt', { id: 'board', text: 'E — Take the helm' });
    if (input.wasPressed('KeyE')) {
      events.emit('prompt', { id: 'board', text: null });
      events.emit('ship:undock');
      ctx.setMode('sail');
    }
  } else {
    events.emit('prompt', { id: 'board', text: null });
  }
}

// autosave
let saveTimer = 60;

// --- main loop ---------------------------------------------------------------

const order = [
  'weather', 'sky', 'ocean', 'world',
  'ships', 'playerShip', 'enemies', 'combat', 'effects',
  'character', 'npcs', 'animals',
  'economy', 'crew', 'quests', 'treasure', 'progression', 'encounters',
  'audio', 'music',
];

const failedOnce = new Set();

engine.start((dt) => {
  ctx.time.dt = dt;

  const paused = ctx.time.paused;
  if (!paused && ctx.mode !== 'menu') {
    ctx.time.t += dt;
    ctx.time.dayFrac = (ctx.time.dayFrac + dt / ctx.time.dayLength) % 1;
    ctx.state.data.timePlayed += dt;
  }

  if (!paused) {
    for (const key of order) {
      const sys = ctx[key];
      if (!sys?.update) continue;
      try {
        sys.update(dt);
      } catch (err) {
        if (!failedOnce.has(key)) {
          failedOnce.add(key);
          console.error(`[loop] ${key}.update threw (muted after first):`, err);
        }
      }
    }
    if (ctx.mode !== 'menu') {
      checkDiscovery(dt);
      checkBoardOwnShip();
      saveTimer -= dt;
      if (saveTimer <= 0 && ctx.mode === 'sail') {
        saveTimer = 60;
        persist();
      }
    }
  } else {
    // keep audio + sky ambience alive under pause
    try { ctx.audio?.update?.(dt); ctx.music?.update?.(dt); } catch { /* muted */ }
  }

  try {
    ctx.ui?.update?.(dt);
  } catch (err) {
    if (!failedOnce.has('ui')) {
      failedOnce.add('ui');
      console.error('[loop] ui.update threw (muted after first):', err);
    }
  }

  engine.render();
  input.endFrame();
});

window.addEventListener('beforeunload', () => {
  if (ctx.mode !== 'menu') persist();
});

// drop the boot veil once the first real frame is out
requestAnimationFrame(() => {
  setTimeout(() => {
    document.getElementById('boot')?.classList.add('done');
    events.emit('game:ready');
  }, 600);
});

// expose for debugging & headless testing
window.__WFP = ctx;
