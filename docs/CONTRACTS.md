# Module Contracts — READ THIS FIRST

Every subsystem is a class instantiated by `src/main.js` and stored on a shared
context object `ctx`. **These contracts are law.** Modules that deviate break the
integration build.

## Hard rules

1. **File ownership is exclusive.** You may only create/edit the files assigned to
   your module. Never touch `src/main.js`, `src/core/*`, or another module's files.
2. **Import rules.** A module file may import ONLY:
   - `three` and `three/addons/*`
   - files inside its own module directory that it owns
   - `../core/*.js` (utils, constants, events — these are frozen)
   Everything else is accessed at runtime through `ctx`. **Never import another
   module's files or `../data/*` directly.**
3. **No DOM/WebGL access at module top-level.** `document`/`window` may only be
   touched inside constructors/methods (so modules can be import-checked in Node).
   Run `node scripts/check-module.mjs src/<your>/<files...>` before finishing.
4. **No new npm dependencies.** three@0.185 + what's in `src/core` is everything.
5. **No external assets.** All geometry procedural; all textures generated via
   canvas or DataTexture; all audio synthesized with WebAudio.
6. **Defensive cross-refs.** Other systems may not exist yet when yours constructs.
   Read cross-system refs (`ctx.weather`, `ctx.ocean`, …) lazily inside `update()`
   or event handlers, with sane fallbacks (`ctx.weather?.wind ?? {…default}`).
7. **Units**: meters, seconds, radians. +Y up. Sea level y=0. `ctx.time.t` is
   elapsed game seconds (float), `ctx.time.dayFrac` ∈ [0,1) (0 = midnight,
   0.5 = noon).
8. **Performance**: instanced meshes for repeated props, merged geometry for
   static clusters, object pooling for particles/projectiles. Never allocate
   in `update()` hot loops (reuse scratch Vector3s).
9. Every system class implements `update(dt)` (dt seconds, already clamped) and
   is constructed as `new X(ctx)`. Constructor must add its own objects to
   `ctx.scene` itself.

## The `ctx` object (wired by main.js, in this order)

```js
ctx = {
  // engine-owned (already present before any module constructs)
  scene, camera, renderer,             // three.js basics
  engine,                              // { setQuality(), quality, canvas }
  events,                              // EventBus: on/off/once/emit
  input,                               // see src/core/input.js
  state,                               // GameState: see src/core/state.js
  time: { t, dt, dayFrac, dayLength, paused },
  mode: 'menu' | 'sail' | 'foot',
  setMode(mode),                       // emits 'mode:change' {mode, prev}
  data: { islands, factions, goods, lore, names, quests },   // from src/data
  rng,                                 // seeded mulberry32 for worldgen

  // systems, in construction order:
  ocean, sky, weather, world,
  ships,                               // ship factory + registry
  playerShip,
  effects, combat, enemies,
  character, npcs, animals,
  economy, crew, quests, treasure, progression, encounters,
  audio, music,
  ui,
}
```

Main loop order: input → weather → sky → ocean → world → ships/playerShip →
enemies → combat → effects → character → npcs → animals → economy → quests →
treasure → progression → encounters → audio/music → ui → render.

---

## Module contracts

### Ocean — `src/world/ocean.js` → `ctx.ocean = new Ocean(ctx)`
Files owned: `src/world/ocean.js`, `src/world/oceanShaders.js`.
- Renders the sea: GPU Gerstner waves **using `GERSTNER_WAVES` from
  `core/constants.js` and exactly mirroring `sampleOceanHeight()` in
  `core/utils.js`** (same formula, same params) so physics matches visuals.
  Amplitudes scale with `this.seaState`.
- Deep-water color, sun specular, fresnel sky reflection (reads `ctx.sky?.sunDir`),
  foam on wave crests + shoreline foam (fade by depth: sample
  `ctx.world?.getTerrainHeight(x,z)` if available, or use a depth uniform approach),
  subtle wake support: `addWakeSource(object3d)` may be a no-op stub.
- Follows the camera (recentered grid / rings) so the horizon is always water.
- API: `getHeight(x,z)` → number (world y, delegates to `sampleOceanHeight` with
  its internal time+seaState); `getNormal(x,z)` → THREE.Vector3 (reuse scratch);
  `setSeaState(s)` target ∈ [0.1, 1] (smooth internally over ~10s); `seaState`
  (current smoothed value); `update(dt)`.

### Sky & Weather — `src/world/sky.js`, `src/world/weather.js`, `src/world/clouds.js`
`ctx.sky = new Sky(ctx)`, `ctx.weather = new Weather(ctx)` (sky first).
- **Sky**: skydome ShaderMaterial — atmospheric gradient driven by sun elevation
  (dawn/dusk color ramps), visible sun disc + glow, moon + stars at night
  (procedural), horizon haze. Owns `THREE.DirectionalLight` (`this.sunLight`,
  casts shadows, shadow camera ~220m box following `ctx.camera`), ambient/hemi
  light, and `ctx.scene.fog` (FogExp2, density modulated by weather). Day cycle
  from `ctx.time.dayFrac`. API: `sunDir` (unit Vector3, updated), `sunLight`,
  `update(dt)`.
- **Clouds**: volumetric-looking cloud layer (impostor billboards with noise
  shader or a domed cloud shader). Coverage 0–1 settable: `setCoverage(c)`.
- **Weather**: state machine `clear → fair → overcast → rain → storm` with
  weighted transitions every 2–5 min, smooth blends. Owns rain particle system
  (follows camera), lightning (random flashes + `ctx.events.emit('thunder', {delay})`),
  wind: `this.wind = { angle, speed, vector: THREE.Vector3 }` (angle radians,
  speed 2–16 m/s by condition; drifts slowly). Drives `ctx.ocean?.setSeaState()`,
  `ctx.sky` fog/haze, cloud coverage. API: `condition` (string), `intensity` 0–1,
  `wind`, `update(dt)`. Emits `'weather:change' {condition}`.

### World — `src/world/worldgen.js` (+ `terrain.js`, `vegetation.js`, `ports.js`, `props.js`)
`ctx.world = new World(ctx)`.
- Builds every island from `ctx.data.islands` (array of defs — see Data contract):
  heightmap terrain via `fbm2` noise from `core/utils.js` seeded per island,
  biome-colored (vertex colors + procedural detail textures): beaches → grass →
  rock → (snow/ash). Shorelines must reach below sea level smoothly (underwater
  skirt) — no floating edges.
- Vegetation per biome (instanced: palms, broadleaf, mangroves, cacti, grass
  tufts), rocks, cliffs. Wind sway in vertex shader reading a time uniform
  (update from `ctx.weather?.wind.speed`).
- **Ports**: for islands with `port` in their def, build a dock (piers extending
  to ≥4m water depth), a small town (procedural buildings: walls, roofs,
  windows with emissive glow at night via `dayFrac`), lanterns, crates, market
  stalls, a tavern & shipwright building (flagged in returned data), defensive
  towers for crown ports. Style varies by island faction.
- API:
  - `getTerrainHeight(x,z)` → world y of ground (negative = seabed). **Fast**
    (analytic noise, no raycasts), consistent with rendered meshes.
  - `islands` → `[{ def, center: Vector3, radius, port?: { name, position: Vector3,
    dockPosition: Vector3, dockHeading, buildings: [{kind, position, ...}] } }]`
  - `getNearestIsland(pos)`, `getNearestPort(pos)` → `{island, port, distance}`.
  - `getSpotHeight` alias ok; `update(dt)` for sway/LOD.
- Ambient props: floating debris/barrels near wreck sites, buoys near docks.

### Ships — `src/ship/` (`shipTypes.js`, `shipFactory.js`, `ship.js`, `sailing.js`, `playerShip.js`)
`ctx.ships = new ShipManager(ctx)`; `ctx.playerShip = new PlayerShip(ctx)`.
- **shipTypes.js**: `SHIP_TYPES` = sloop, cutter, brig, merchantman, frigate,
  galleon — each `{ name, length, beam, draft, maxSpeed (m/s), turnRate,
  hullMax, cannonsPerSide, cargoCapacity, crewMax, sailArea, cost }`. Distinct
  handling per class.
- **shipFactory.js**: `buildShip(typeKey, { faction, paint })` → THREE.Group with
  full procedural model: planked hull (canvas texture), keel, stern castle &
  bow, masts + yards + rigging (Line2 or thin cylinders), **cloth sails that
  billow** (vertex displacement by wind/sail amount uniform), ratlines, ship's
  wheel, cannons poking from ports, stern lanterns (PointLight optional, emissive
  always), faction flag (animated cloth, White Flag for player), figurehead,
  wake foam anchor points. `userData.parts = { sails, flag, cannonsL, cannonsR,
  wheel, hullMesh, deckY (walkable deck height), firePointsL/R: Vector3[] (local) }`.
- **ship.js**: `class Ship` — entity wrapper: `{ group, type, physics, hull,
  hullMax, sailAmount, faction, alive, sink(), applyDamage(amount, point?),
  update(dt) }`. Sinking = slow tilt + descend + foam, then removal. Emits
  `'ship:sunk' {ship, byPlayer}`.
- **sailing.js**: `class ShipPhysics` — buoyancy: sample `ctx.ocean.getHeight` at
  bow/stern/port/starboard → y, pitch, roll (spring-damped); propulsion:
  windSpeed × sailAmount × sailEfficiency(angle between heading & wind — dead
  zone ~30° into wind, best on broad reach), quadratic drag, rudder yaw scaled
  by speed, keel lateral resistance. Run-aground: if `ctx.world.getTerrainHeight`
  at bow > -draft → stop + minor hull damage + event `'ship:aground'`.
- **ShipManager**: `createShip(typeKey, opts)` → Ship (registered, added to
  scene); `remove(ship)`; `list` (all live ships incl. player's); `update(dt)`.
- **PlayerShip**: wraps a Ship for the player. Sail-mode controls (see GDD table),
  smooth follow-orbit camera **only when `ctx.mode==='sail'`** (mouse orbit,
  wheel zoom 8–90m, subtle sway), anchor drop/raise, dock detection: within 30m
  of a port's dockPosition & slow → HUD prompt via `ctx.events.emit('prompt', …)`,
  `E` → emits `'ship:dock' {port, island}`. Applies upgrades from
  `ctx.state.data.ship` (hullTier/sailTier/cannonTier multipliers). Exposes
  `ship`, `speedKnots`, `sailAmount`, `heading`. Spyglass on Q (FOV zoom).

### Combat — `src/combat/` (`effects.js`, `naval.js`, `enemyAI.js`)
`ctx.effects = new Effects(ctx)`; `ctx.combat = new NavalCombat(ctx)`;
`ctx.enemies = new EnemyFleet(ctx)`.
- **Effects**: pooled particle systems — cannon muzzle flash + smoke plumes,
  explosions (flash/fireball/sparks/smoke), water splashes + rings, wood debris,
  ship fire with smoke columns, blood-free hit sparks. API:
  `explosion(pos, scale)`, `splash(pos, scale)`, `muzzleFlash(pos, dir)`,
  `woodBurst(pos)`, `fire(attachTo, localPos)` → handle `{stop()}`,
  `sparks(pos)`, `update(dt)`.
- **NavalCombat**: projectile simulation (pooled cannonballs, gravity arcs,
  ~260 m/s? no — pirate-ball ~120 m/s with drag; visible arcs), types: roundshot
  (hull dmg), chainshot (sail/speed dmg), grapeshot (crew dmg, short range).
  `fireBroadside(ship, side ('L'|'R'), { type, spreadRad, targetPoint? })` —
  staggered per-cannon timing, muzzle effects, reload timers per ship side.
  Hit detection vs ship hulls (OBB approx) and terrain; splashes on miss.
  Player aiming: hold RMB in sail mode → camera shifts to the aimed side +
  reticle arc preview via `ctx.events.emit('aim:update', {...})`; LMB fires.
  Applies damage via `ship.applyDamage`. Emits `'cannon:fire'`, `'ship:hit'`.
  When an enemy ship's hull < 25% and within 40m: emit
  `'boarding:offer' {ship}` (UI/crew resolve it; on `'boarding:resolve'`
  {victory} → loot or crew loss).
- **EnemyFleet**: spawns AI ships by region + faction (navy patrols near Crown
  waters, merchants on trade lanes between ports, pirate rivals in open sea) —
  respects `ctx.encounters` requests via event `'spawn:ship' {typeKey, faction,
  pos, role}`. Sailing AI: waypoint patrol / flee / attack (keep 100–200m,
  turn broadside, fire when reloaded & in arc, ±accuracy). Merchants flee &
  drop cargo. Sunk ships spawn floating loot crates (collect within 12m:
  gold/goods → `ctx.state`). Cap ~8 live AI ships. `update(dt)`.

### Character — `src/character/` (`player.js`, `sword.js`, `npc.js`, `animals.js`)
`ctx.character = new Character(ctx)`; `ctx.npcs = new NPCManager(ctx)`;
`ctx.animals = new Animals(ctx)`.
- **Character**: third-person controller, active only in `foot` mode: WASD +
  sprint + jump, ground = `max(ctx.world.getTerrainHeight, deck/dock heights
  via simple registered walk surfaces)`; swim when below sea level+0.5 (slower,
  stamina drain); step up ledges ≤0.6m, climb short cliffs (hold forward+jump).
  Orbit camera w/ pointer lock **only in foot mode**. Procedural humanoid model
  (articulated: torso/head/arms/legs, tricorne hat, coat) with programmatic
  walk/run/idle/swim animation. Health/stamina on `this.hp/this.stamina`,
  regen; death → `'player:death'`. API: `spawnAt(pos, heading)`, `position`,
  `update(dt)`. Interact: nearest interactable within 2.5m → `'prompt'` event,
  E → `'interact' {target}`.
- **sword.js**: melee for player: LMB light (3-hit combo), hold heavy, RMB
  parry window (0.35s, staggers attacker), Space+dir dodge roll (i-frames),
  F pistol (1 shot, 6s reload, 25 dmg). Hit arcs vs `ctx.npcs.hostiles` in
  range 2.2m. Hit-stop, camera kick via events. Damage numbers optional.
- **NPCManager**: same humanoid rig, palette per role. Civilians wander port
  paths & chat lines; merchants/tavernkeep/shipwright/questgiver stand at their
  buildings — interacting emits `'npc:interact' {npc}` (role opens UI screens
  via UI module). Guards patrol Crown ports (aggro if wanted/reputation low).
  Hostiles: bandits at ruins/treasure sites, boarding parties. Combat AI:
  approach, circle, telegraphed attacks (0.5s windup), block chance; drop small
  loot. `spawnHostile(pos, kind)`, `hostiles` (array), `populatePort(port)`
  (called lazily when player near), `update(dt)`.
- **Animals**: gulls (boids around cliffs/ports, cries), dolphins (leap near
  the bow at sea), sharks (circle when player swims in deep water, bite →
  damage), crabs on beaches. Instanced/pooled, ≤ 60 active. `update(dt)`.

### Systems — `src/systems/` (`economy.js`, `crew.js`, `quests.js`, `treasure.js`, `progression.js`, `encounters.js`)
Each a class on ctx (`ctx.economy` etc., constructed in that order).
- **Economy**: per-port market from `ctx.data.goods` × island modifiers; prices
  drift (sin + rng walk), respond to events (`'ship:sunk'` merchant → nearby
  price bumps). API: `getMarket(portName)` → `[{key, name, buy, sell, stock,
  contraband}]`, `buy(portName, key, qty)`, `sell(...)` (mutate `ctx.state`
  gold/cargo, emit `'trade'`), `cargoUsed()`, `cargoCapacity()`.
- **Crew**: roster in `ctx.state.data.crew` `[{name, role, skill 1-5, morale
  0-100, wage, story}]`. Wages tick daily (dayFrac wraps); low morale →
  desertion warnings via captain's log. Role bonuses (gunner→reload, carpenter→
  passive hull repair at sea, surgeon→player regen, navigator→speed, cook→
  morale). `hire(candidate)`, `dismiss(i)`, `candidatesFor(portName)`,
  `boardingStrength()`, resolves `'boarding:offer'` when UI confirms:
  strength vs enemy → `'boarding:resolve' {victory, lootGold, casualties}`.
- **Quests**: definitions from `ctx.data.quests` (main chapters + side
  templates: hunt, deliver, escort... at least hunt/deliver/find working).
  Track objectives via events (`'ship:sunk'`, `'trade'`, `'treasure:dug'`,
  `'ship:dock'`). Journal model: `active`, `completed`, `available(portName)`.
  `accept(id)`, `turnIn(id)`. Rewards: gold/xp/reputation. Auto-start chapter 1.
- **Treasure**: map items in `ctx.state.data.maps` `[{islandId, x, z, riddle,
  found}]`; sources: tavern purchase, loot drops, message bottles. When on
  the right island within 6m of the spot in foot mode → prompt → hold E 2s dig
  → `'treasure:dug' {value}` → gold/relics + effects. Underwater wrecks near
  Coralline Reach: glint markers, dive to collect.
- **Progression**: xp from kills/quests/discovery (`'island:discovered'`), level
  curve, +1 skill point/level; skills tree data (3 branches × 4 tiers:
  Corsair(sword), Captain(ship), Freetrader(economy)) — modifiers exposed as
  `getMod(key)` (e.g. 'swordDamage', 'reloadSpeed', 'priceEdge', multiplier
  default 1). Ship upgrades applied via events. Reputation helpers:
  `addRep(faction, d)`; crown ≤ -50 → hunter spawns (emit `'spawn:ship'`).
- **Encounters**: timer-based dynamic events by region/state: merchant convoy,
  navy patrol, rival pirate, castaway (rescue → crew candidate/rumor), message
  bottle (treasure map), floating cargo, whale pod sighting (xp). Emits
  `'spawn:ship'` / spawns pickups; announces via `'toast'` events.

### UI — `src/ui/` (`ui.js`, `hud.js`, `map.js`, `menus.js`, `trading.js`, `journal.js`, `styles.css`)
`ctx.ui = new UI(ctx)` (constructed LAST). DOM overlay in `#ui` root (already in
index.html). Import the CSS via `import './styles.css'`.
- **ui.js**: orchestrates screens, key routing for UI toggles (M/J/K/Tab/Esc),
  exposes `toast(text, kind)`, `prompt(text|null)` (bottom-center key hint),
  listens `'prompt'`, `'toast'`. Only one modal screen at a time; opening one
  sets `ctx.time.paused=true` except HUD; Esc closes / opens pause.
- **hud.js**: compass ribbon (N/E/S/W + wind arrow + port markers + quest
  marker), ship panel (speed knots, sail %, rudder, hull bar, reload pips L/R),
  foot panel (health/stamina bars), gold + date readout, objective tracker
  (active quest), aim reticle (on `'aim:update'`), damage vignette, subtle
  letterbox during boarding. Update from ctx each frame (cheap DOM writes only
  on change).
- **map.js**: fullscreen parchment chart (canvas): island silhouettes from
  `ctx.data.islands` (noise-blob shapes), names in serif, player ship marker +
  heading, discovered-only reveal, quest Xs, click to set waypoint (compass
  shows it). M toggles.
- **menus.js**: **title screen** (handsome: name, animated white flag motif via
  CSS/canvas, New Voyage / Continue / Settings / Credits), pause menu, settings
  (quality Low/Med/High → `ctx.engine.setQuality`, volumes, invert Y, fov),
  death screen (respawn at last port), credits. Title shows until New/Continue →
  `ctx.setMode('sail')` + `'game:start' {fresh}`.
- **trading.js**: dock screens on `'npc:interact'` roles or dock menu event
  `'port:menu'`: Market (buy/sell grid, price coloring vs base, qty via
  shift/ctrl), Shipwright (repair, tier upgrades, buy new ship classes, paint),
  Tavern (hire crew candidates w/ portraits (canvas), rumors for gold, buy
  treasure maps), Quest board (accept side quests; turn-ins).
- **journal.js**: tabbed screen — Quests, Captain's Log (auto entries pushed via
  `'log'` events), Crew roster (morale bars, dismiss), Cargo hold, Skills tree
  (spend points, shows branches), Reputation standings, Treasure maps
  (renders each map's island sketch + riddle).
- Aesthetic: parchment/brass/rope nautical theme, serif display font stack,
  consistent with GDD. Fully keyboard+mouse navigable, readable at 1280×720+.

### Audio — `src/audio/` (`audio.js`, `sfx.js`, `music.js`)
`ctx.audio = new AudioEngine(ctx)`; `ctx.music = new Music(ctx)`.
- **AudioEngine**: WebAudio (unlock on first gesture), buses (master/sfx/music/
  ambience), `setVolumes({...})` (read initial from state settings), 3D pan by
  listener = camera. Ambience beds synthesized: layered filtered-noise ocean
  (intensity ↔ seaState), wind (↔ wind.speed), rain layer, creaking aboard
  (random, ↔ heel angle), port ambience (gulls, chatter murmur), tavern room
  tone. Crossfade by context.
- **sfx.js**: `play(name, {pos?, vel?, vol?})` — synthesized: cannon (sub thump
  + noise crack + tail), distant cannon variant, splash, wood hit/break, sword
  swing/clash/hit, parry ring, pistol, footsteps (surface-aware), coins, ui
  clicks, paper, dig shovel, thunder (on `'thunder'` w/ delay), gull, bell,
  level-up chime. Subscribe to game events so systems don't call audio directly
  where events exist.
- **music.js**: generative score — modal sea-shanty themes (pentatonic/dorian
  melodies over drone + rhythm), contexts: title, exploration-calm,
  exploration-tense (storm), combat (drums + urgency), port/tavern (jig),
  night-quiet. Crossfade 4s. Tasteful & sparse; volume from settings.

### Data — `src/data/` (`islands.js`, `factions.js`, `goods.js`, `names.js`, `quests.js`, `lore.js`)
Pure data modules (arrays/objects + tiny pure helpers). No three.js, no DOM.
- **islands.js**: the 12 GDD islands: `{ id, name, position:[x,z], radius (350–900),
  seed, biome ('tropical'|'volcanic'|'mangrove'|'atoll'|'rock'|'jungle'),
  faction, port?: { name, size ('haven'|'town'|'capital'|'village'), hasTavern,
  hasShipwright, hasQuests }, description, loreHints }` — positions spread
  across ±6000m, shipping-lane friendly, Gullhaven nearish center-west.
- **factions.js**: the 4 factions: colors (hex), flag pattern descriptor, ship
  name prefixes, disposition rules.
- **goods.js**: 12 goods `{ key, name, basePrice, weight, contraband?, tags }`
  + per-biome production/demand hints.
- **names.js**: name pools + `shipName(rng)`, `crewName(rng)`, `crewStory(rng)`.
- **quests.js**: chapter quests 1–5 (see GDD) with objective descriptors
  `{ type:'sink'|'deliver'|'visit'|'dig'|'talk', ... }` + side quest templates.
- **lore.js**: world lore paragraphs, tavern rumors, captain's log flavor,
  loading tips, credits text.

---

## Shared core (frozen — read, never edit)

- `core/constants.js`: `WORLD` (SEA_SIZE, DAY_LENGTH…), `GERSTNER_WAVES`,
  `COLORS`, tuning tables.
- `core/utils.js`: `mulberry32(seed)`, `hashSeed(str)`, `SimplexNoise` (2D,
  seedable), `fbm2(noise,x,y,oct)`, `clamp/lerp/damp/smoothstep/wrapAngle/
  angleLerp`, `sampleOceanHeight(x,z,t,seaState)` (canonical CPU Gerstner —
  ocean GLSL must mirror), `sampleOceanNormal(x,z,t,seaState,out)`.
- `core/events.js`: EventBus.
- `core/input.js`: `isDown(code)`, `wasPressed(code)`, `mouse {dx,dy,wheel,
  buttons, pressed(btn), wasPressed(btn)}`, pointer-lock helpers.
- `core/state.js`: `ctx.state.data` (see file for shape), `save()/load()/
  reset()`, `addGold(n)`, `settings`.

## Event glossary (emit exactly these names)

`mode:change` `game:start` `weather:change` `thunder` `ship:dock` `ship:undock`
`ship:aground` `ship:sunk` `ship:hit` `cannon:fire` `aim:update`
`boarding:offer` `boarding:resolve` `spawn:ship` `npc:interact` `interact`
`prompt` `toast` `log` `trade` `treasure:dug` `island:discovered`
`player:death` `player:respawn` `quest:accept` `quest:complete` `level:up`
`port:menu` `loot:collect`
