// A memorable named naval set-piece: the legend of the Ashen Verdict.
//
// The Verge's naval content is otherwise procedurally uniform — random convoys
// and patrols. This is the one peak: a rumoured privateer man-o'-war, black of
// hull and flying her own colours, far tougher than any line ship and hitting
// twice as hard. She is rare, telegraphed with a cold fog and a lookout's cry,
// pays out a king's ransom when broken, and then sleeps beneath the swell for a
// long cooldown so the encounter always feels earned.
//
// She is injected into the live enemy fleet exactly like any other hostile
// (ctx.ships.createShip + ctx.enemies.entries) so every existing naval system —
// broadsides, chain shot, fires, boarding, sinking — works on her unchanged.
import * as THREE from 'three';
import { randRange, clamp } from '../core/utils.js';

// the legend, in numbers
const LEGEND = {
  name: 'the Ashen Verdict',
  type: 'galleon',      // biggest hull in the yard
  hullMult: 2.7,        // ~1240 hull — a fortress under canvas
  crew: 64,             // a full press gang for the boarding fight
  paint: 'storm',       // charcoal topsides
};

const TELEGRAPH_S = 9;         // fog & rumour before she looms out of the murk
const SPAWN_DIST = 720;        // how far off she first appears
const SINK_THRESHOLD = 4;      // ships the player must have sunk before she stirs
const COOLDOWN_DEFEAT = 1500;  // long silence after she's put down for good
const COOLDOWN_ESCAPE = 360;   // shorter if she slips the hook
const AUTO_CHANCE = 0.03;      // ~per-second odds she rises once fully eligible
const REWARD_GOLD_MIN = 3800;
const REWARD_GOLD_MAX = 6200;
const REWARD_XP = 420;

export class NavalSetpiece {
  constructor(ctx) {
    this.ctx = ctx;
    this.ship = null;          // the live legendary Ship, when at sea
    this.entry = null;         // the {ship, brain} handle inside ctx.enemies.entries
    this.cooldown = 0;         // seconds until she may appear again
    this.playerSinks = 0;      // hostile ships sent down since the last legend
    this._pending = 0;         // telegraph countdown; >0 means she's inbound
    this._forcedCond = false;  // whether we nudged the weather for atmosphere

    this._registerFaction();

    ctx.events?.on('ship:sunk', ({ ship, byPlayer }) => this._onSunk(ship, byPlayer));
    ctx.events?.on('game:start', () => this.reset());
  }

  // Give the Verdict her own house colours without disturbing the shared roster
  // of powers: a dark ensign under a coiled sigil. Purely additive & guarded.
  _registerFaction() {
    const factions = this.ctx.data?.factions;
    if (factions && !factions.revenant) {
      factions.revenant = {
        key: 'revenant',
        name: 'The Ashen Court',
        color: 0x1b2436,
        accent: 0xc9a24b,
        flag: { base: 'blue', emblem: 'spiral' },
        shipPrefixes: [''],
        disposition: { toPlayerBase: -100 },
        motto: 'The sea pays every debt.',
      };
    }
  }

  /** Reset all per-voyage state — called on every game:start. */
  reset() {
    // the world is torn down on a new game; just drop our references
    this.ship = null;
    this.entry = null;
    this.cooldown = 0;
    this.playerSinks = 0;
    this._pending = 0;
    this._forcedCond = false;
  }

  get active() {
    return !!this.ship && this.ship.alive && !this.ship.sinking;
  }

  /** External trigger (used by the encounter scheduler). Returns true if the
   *  rumour took and she is now inbound. Safe to call liberally — it self-gates
   *  on cooldown, threshold, weather of the moment, and open water. */
  requestSpawn(reason = 'rumour') {
    if (!this._ready()) return false;
    this._beginTelegraph(reason);
    return true;
  }

  _ready() {
    const ctx = this.ctx;
    if (ctx.mode !== 'sail') return false;
    if (this.active || this._pending > 0) return false;
    if (this.cooldown > 0) return false;
    if (this.playerSinks < SINK_THRESHOLD) return false;
    const p = ctx.playerShip?.ship?.position;
    if (!p) return false;
    // she does not haunt the crowded roads off a port
    const near = ctx.world?.getNearestPort?.(p);
    if (near && near.distance < 600) return false;
    return true;
  }

  _beginTelegraph() {
    const ctx = this.ctx;
    this._pending = TELEGRAPH_S;
    // a cold fog bank rolls in as the atmosphere; harmless if weather is absent
    if (ctx.weather?.forceCondition) {
      ctx.weather.forceCondition('overcast');
      this._forcedCond = true;
    }
    ctx.events?.emit('toast', {
      text: 'A cold fog rolls in. The lookout swears he sees black sails — the Ashen Verdict rides.',
      kind: 'warn',
    });
    ctx.state?.addLog?.('They say the Ashen Verdict answers to no crown and no port. Today her course crossed ours.');
  }

  _spawnLegend() {
    const ctx = this.ctx;
    const enemies = ctx.enemies;
    const p = ctx.playerShip?.ship?.position;
    if (!enemies?.entries || !ctx.ships?.createShip || !p) {
      // conditions collapsed mid-telegraph — stand her down without penalty
      this.cooldown = COOLDOWN_ESCAPE;
      return;
    }

    // find open water off the beam for her to loom out of
    let x = p.x, z = p.z;
    for (let tries = 0; tries < 6; tries++) {
      const a = Math.random() * Math.PI * 2;
      const d = randRange(Math.random, SPAWN_DIST, SPAWN_DIST + 220);
      x = p.x + Math.sin(a) * d;
      z = p.z + Math.cos(a) * d;
      if ((ctx.world?.getTerrainHeight?.(x, z) ?? -30) < -8) break;
    }

    const ship = ctx.ships.createShip(LEGEND.type, {
      faction: 'revenant',
      name: LEGEND.name,
      paint: LEGEND.paint,
      hullMult: LEGEND.hullMult,
      crewCount: LEGEND.crew,
    });
    if (!ship) {
      this.cooldown = COOLDOWN_ESCAPE;
      return;
    }
    ship.physics.placeAt(x, z, Math.atan2(p.x - x, p.z - z));
    ship.sailAmount = 0.85;
    ship._legendary = true;    // our own marker; distinct from progression's hunter

    // a brain the existing EnemyFleet AI can drive: a relentless hunter that
    // never breaks off (hunter role is exempt from the low-hull flee), locked
    // to engage from the first heartbeat.
    const brain = {
      role: 'hunter',
      state: 'engage',
      provoked: true,
      announced: false,
      waypoint: new THREE.Vector3(p.x, 0, p.z),
      fleeDropped: false,
      broadsideSide: 'L',
    };
    this.entry = { ship, brain };
    enemies.entries.push(this.entry);
    this.ship = ship;

    ctx.events?.emit('toast', {
      text: `${LEGEND.name} comes about to engage. Beat to quarters!`,
      kind: 'warn',
    });
    ctx.events?.emit('shake', { amount: 0.25 });
  }

  _onSunk(ship, byPlayer) {
    if (!ship || ship.isPlayer) return;
    // tally the player's kills to gate when the legend may first stir
    if (ship !== this.ship) {
      if (byPlayer) this.playerSinks++;
      return;
    }
    // whatever happens next, our references are stale the moment she founders
    this.ship = null;
    this.entry = null;
    this._pending = 0;
    if (!byPlayer) {
      this.cooldown = COOLDOWN_ESCAPE;
      return;
    }
    // the prize of a lifetime
    this.cooldown = COOLDOWN_DEFEAT;
    this.playerSinks = 0;
    const ctx = this.ctx;
    const gold = Math.round(randRange(Math.random, REWARD_GOLD_MIN, REWARD_GOLD_MAX));
    ctx.state?.addGold?.(gold);
    ctx.progression?.addXp?.(REWARD_XP);
    ctx.state?.addLog?.(`Broke the Ashen Verdict and split her strongroom — ${gold} sovereigns richer, and a story no tavern will believe.`);
    ctx.events?.emit('toast', {
      text: `The Ashen Verdict is broken and gone beneath. +${gold} sovereigns — the Verge will remember this.`,
      kind: 'gold',
    });
    // her fall heartens every hand aboard (crew also books its own +morale on
    // the ship:sunk it hears — this is the legend's extra spur)
    ctx.events?.emit('crew:legend', { name: LEGEND.name });
  }

  update(dt) {
    const ctx = this.ctx;
    if (ctx.mode === 'menu' || ctx.time?.paused) return;

    if (this.cooldown > 0) this.cooldown -= dt;

    // telegraph: fog & rumour, then she looms out of the murk
    if (this._pending > 0) {
      this._pending -= dt;
      if (this._pending <= 0) {
        this._pending = 0;
        if (ctx.mode === 'sail') this._spawnLegend();
        else this.cooldown = COOLDOWN_ESCAPE;   // player left the water; stand down
      }
      return;
    }

    // watch the live legend: if the fleet AI despawned her (player ran her out
    // of range) she has slipped back into the fog — reset, no reward, no penalty
    if (this.ship) {
      const stillListed = ctx.enemies?.entries?.includes(this.entry);
      const gone = !this.ship.alive && !this.ship.sinking;
      if (gone || !stillListed) {
        if (!this.ship.sinking) {
          ctx.events?.emit('toast', {
            text: `${LEGEND.name} melts back into the fog. Another day, then.`,
            kind: 'info',
          });
          this.ship = null;
          this.entry = null;
          this.cooldown = COOLDOWN_ESCAPE;
        }
      }
      return;
    }

    // autonomous rare rise: only when eligible, and only now and then
    if (this._ready() && Math.random() < AUTO_CHANCE * clamp(dt, 0, 0.1)) {
      this._beginTelegraph('haunt');
    }
  }
}
