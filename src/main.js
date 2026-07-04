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
import { Boarding } from './combat/boarding.js';
import { Character } from './character/player.js';
import { NPCManager } from './character/npc.js';
import { Animals } from './character/animals.js';
import { Economy } from './systems/economy.js';
import { Crew } from './systems/crew.js';
import { Quests } from './systems/quests.js';
import { Treasure } from './systems/treasure.js';
import { Progression } from './systems/progression.js';
import { Hunting } from './systems/hunting.js';
import { Encounters } from './systems/encounters.js';
import { Viewpoints } from './systems/viewpoints.js';
import { NavalSetpiece } from './combat/setpiece.js';
import { AudioEngine } from './audio/audio.js';
import { Music } from './audio/music.js';
import { Shanty } from './audio/shanty.js';
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
construct('setpiece', NavalSetpiece);
construct('character', Character);
construct('npcs', NPCManager);
construct('animals', Animals);
construct('economy', Economy);
construct('crew', Crew);
construct('boarding', Boarding);
construct('viewpoints', Viewpoints);
construct('quests', Quests);
construct('treasure', Treasure);
construct('progression', Progression);
construct('hunting', Hunting);
construct('encounters', Encounters);
construct('audio', AudioEngine);
construct('music', Music);
construct('shanty', Shanty);
construct('ui', UI);

if (bootErrors.length) {
  console.error(`[boot] ${bootErrors.length} system(s) failed:`, bootErrors.map((b) => b.key).join(', '));
}

// --- game flow -------------------------------------------------------------

const gullhaven = ISLANDS.find((i) => i.id === 'gullhaven') ?? ISLANDS[0];

function startPositionFor(fresh) {
  const saved = ctx.state.data.position;
  // persist() writes [x, z, heading] — read it back with matching indices
  if (!fresh && saved) return { x: saved[0], z: saved[1], heading: saved[2] ?? 0 };
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

// Reset/load must happen BEFORE systems react, so they initialize against the
// correct state. menus.js calls beginGame() which resets first, then emits.
ctx.beginGame = (fresh) => {
  if (fresh) ctx.state.reset();
  else ctx.state.load();
  if (ctx.state.data.dayFrac != null) ctx.time.dayFrac = ctx.state.data.dayFrac;
  ctx.time.paused = false;
  events.emit('game:start', { fresh });
};

events.on('game:start', ({ fresh }) => {
  // state is already reset/loaded by beginGame() at this point
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

// Go ashore on any island (non-port beaches, ruins, treasure). The ship stays
// anchored offshore; walk/swim back to it to take the helm again.
events.on('ship:goashore', ({ island, shore }) => {
  ctx.setMode('foot');
  ctx.character?.spawnAt(shore.point, shore.heading);
  events.emit('toast', { text: `Ashore on ${island.def.name}.`, kind: 'discover' });
  persist();
});

// Death & respawn — one path, driven by the death-screen button (menus.js
// shows the overlay on 'player:death' and its button emits 'player:respawn').
// No auto-respawn here, or the 10% gold penalty would be applied twice.
let _respawning = false;

// Losing the player's OWN ship in naval combat is a death too — otherwise the
// helm/camera freeze forever once the wreck is removed (soft-lock).
events.on('ship:sunk', ({ ship }) => {
  if (ship && ship === ctx.playerShip?.ship && !_respawning) {
    _respawning = true;
    ctx.state.addLog('The ship went down under me. The sea always collects.');
    events.emit('player:death', { cause: 'shipwreck' });
  }
});

events.on('player:respawn', () => {
  const focus = ctx.playerShip?.ship?.group?.position ?? ctx.camera.position;
  const near = ctx.world?.getNearestPort?.(focus);
  const dock = near?.port?.dockPosition;
  ctx.state.addGold(-Math.round(ctx.state.data.gold * 0.1));

  const shipDead = !ctx.playerShip?.ship?.alive || ctx.playerShip?.ship?.sinking;
  if (shipDead) {
    // wrecked: give her a fresh hull and put the captain back at the nearest port
    if (ctx.state.data.ship) ctx.state.data.ship.hull = null;
    ctx.playerShip?._rebuild?.(true);
    if (dock && near) {
      const away = Math.atan2(dock.x - near.island.center.x, dock.z - near.island.center.z);
      ctx.playerShip?.placeAt?.(dock.x + Math.sin(away) * 150, dock.z + Math.cos(away) * 150, away);
    }
    ctx.setMode('sail');
  } else if (ctx.character && dock) {
    ctx.character.hp = ctx.character.hpMax ?? 100;
    ctx.character.spawnAt(dock, 0);
    ctx.setMode('foot');
  } else {
    ctx.setMode('sail');
  }
  _respawning = false;
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
  // during a boarding melee the deck is a battlefield, not the helm — don't let
  // "take the helm" strand the fight.
  if (ctx.boarding?.active) { events.emit('prompt', { id: 'board', text: null }); return; }
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

// --- camera shake (decoupled; layered on top of the active camera each frame) ---
const shake = { trauma: 0 };
ctx.fx = {
  shake(amount = 0.4) { shake.trauma = Math.min(1, shake.trauma + amount); },
};
events.on('shake', (p) => ctx.fx.shake(typeof p === 'number' ? p : (p?.amount ?? 0.4)));
events.on('cannon:fire', ({ isPlayer }) => { if (isPlayer) ctx.fx.shake(0.3); });
events.on('ship:hit', ({ onPlayer }) => { if (onPlayer) ctx.fx.shake(0.5); });
events.on('player:hurt', () => ctx.fx.shake(0.3));
events.on('sword:hit', ({ heavy }) => ctx.fx.shake(heavy ? 0.22 : 0.12));

function renderWithShake(dt) {
  if (shake.trauma > 0.001) {
    const amp = shake.trauma * shake.trauma * (ctx.mode === 'foot' ? 0.35 : 0.7);
    const px = engine.camera.position.x, py = engine.camera.position.y, pz = engine.camera.position.z;
    engine.camera.position.x += (Math.random() - 0.5) * amp;
    engine.camera.position.y += (Math.random() - 0.5) * amp;
    engine.camera.position.z += (Math.random() - 0.5) * amp;
    engine.render();
    engine.camera.position.set(px, py, pz); // restore so controllers don't drift
    shake.trauma = Math.max(0, shake.trauma - dt * 2.4);
  } else {
    engine.render();
  }
}

// --- main loop ---------------------------------------------------------------

const order = [
  'weather', 'sky', 'ocean', 'world',
  'ships', 'playerShip', 'enemies', 'setpiece', 'combat', 'effects',
  'character', 'npcs', 'boarding', 'viewpoints', 'animals', 'hunting',
  'economy', 'crew', 'quests', 'treasure', 'progression', 'encounters',
  'audio', 'music', 'shanty',
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

  renderWithShake(dt);
  input.endFrame();
});

window.addEventListener('beforeunload', () => {
  if (ctx.mode !== 'menu') persist();
});

// drop the boot veil once the first real frame is out
requestAnimationFrame(() => {
  setTimeout(() => {
    const boot = document.getElementById('boot');
    if (boot) {
      boot.classList.add('done');
      // belt-and-suspenders: fully remove it after the fade so no stray CSS
      // (e.g. a class collision) can leave the veil covering the title screen
      setTimeout(() => { boot.style.display = 'none'; }, 1400);
    }
    events.emit('game:ready');
  }, 600);
});

// expose for debugging & headless testing
window.__WFP = ctx;
