# ⚑ WhiteFlagPirates

*No masters. No surrender. The Verge is free.*

**WhiteFlagPirates** is an original open-world pirate action-adventure set in the
**Meridian Verge** — a vast procedurally-realized fantasy archipelago of twelve
authored islands, contested by four factions. You are **Captain Wren Kestrel**,
last signatory of the Pale Accord, sailing under a white flag that means freedom,
not surrender.

Built entirely with **three.js** — every mesh, texture, sound, and note of music
is generated procedurally at runtime. No asset files.

![Title screen](docs/screenshots/title.png)

| | |
|---|---|
| ![Golden hour at sea](docs/screenshots/golden-hour.png) | ![A storm rising](docs/screenshots/storm.png) |
| *Golden hour on the open sea* | *A squall darkens the Verge* |
| ![Harbor at night](docs/screenshots/night-harbor.png) | ![The tavern](docs/screenshots/tavern.png) |
| *Lantern-lit dock after dark* | *Hiring crew at the Drowned Lantern* |

## Play

```bash
npm install
npm run dev      # then open the printed URL
```

## Production / deploy

```bash
npm run build    # emits dist/
npm start        # serves dist/ on $PORT (default 8080) via server.js
```

`server.js` is a zero-dependency static server that binds to `0.0.0.0:$PORT`,
sets correct MIME types, caches hashed assets, and revalidates `index.html`.

**Railway / Docker** — deployment uses the included `Dockerfile` (a multi-stage
build: install all deps → `vite build` → ship a slim runtime image that serves
`dist/` with `server.js`). `railway.json` points Railway at the Dockerfile and
sets a `/` healthcheck; Railway injects `PORT` automatically. Just point Railway
at this repo and deploy.

> The Dockerfile installs dev dependencies explicitly (`npm ci --include=dev`)
> so the `vite` build step works even under `NODE_ENV=production` — the common
> cause of "works locally, blank on the host" for Vite apps.

The game is fully self-contained (no external assets, APIs, or network calls),
so it runs on any static host: `npm run build` then serve `dist/`.

## What's in the game

- **A living ocean** — GPU Gerstner wave simulation (physics-matched on CPU so
  ships truly ride the swells), crest and shoreline foam, sun glint, storm seas.
- **Dynamic sky & weather** — full day/night cycle, atmospheric dawn/dusk,
  procedural stars and moon, clouds, rain, storms with lightning and thunder.
- **Twelve islands** — volcanic peaks, jungles, mangrove mazes, bone-white
  atolls, reef labyrinths — each with authored lore, and five living ports with
  distinct faction architecture.
- **Six ship classes** — sloop to galleon, procedurally modeled with billowing
  cloth sails, rigging, and faction flags; wind-aware sailing physics with
  tacking, heel, and anchor work.
- **Naval combat** — round/chain/grape shot, staggered broadsides, enemy
  captains that patrol, trade, hunt, flee, and turn to present their guns. Ships
  are crewed and take visible harm: sails tatter and darken, hulls smoke, crews
  thin under grape. A target readout names the enemy, its faction, hull and crew,
  and flags when a prize is ready to board.
- **Playable boarding melee** — cripple a prize and grapple alongside: leap onto
  her deck on foot and fight her surviving crew hand-to-hand. Clear the deck to
  take her; get beaten back and she breaks away.
- **On-foot adventure** — third-person exploration of ports and islands, sword
  combat with a soft lock-on, execution finishers, parries, dodges and pistol,
  NPCs with roles and rumors, treasure maps you pace out from the landmark
  (warmer/colder, not a GPS pin), and tense breath-limited shipwreck diving where
  the sharks bite.
- **Viewpoints & the chart** — climb a lighthouse or high point and survey to
  unveil the surrounding shores, the way a real navigator fills a chart.
- **The Ashen Verdict** — a rumoured black-sailed legend that looms out of a cold
  fog once you've made a name; hunt her for a fortune, or run.
- **Hunting & the outfitter** — harpoon whales and sharks for oil, hide and
  ambergris, then craft permanent riggings at the chandler — a second,
  craft-based progression track beside gold.
- **Systems that talk to each other** — dynamic port economies, crew hiring and
  morale, faction reputation (anger the Crown and hunters sail), skill trees,
  ship upgrades, dynamic encounters, five-chapter main story.
- **A nautical interface** — parchment world chart with viewpoint fog, captain's
  journal, compass ribbon, world-space objective and port beacons, trading posts,
  taverns, shipwrights, the outfitter.
- **Procedural audio** — synthesized ocean/wind/rain ambience, cannon thunder, a
  generative score, and wordless sea shanties sung by the crew under sail (they
  fall quiet for a fight and bark on the broadside).

## Controls

| Input | At sea | On foot |
|---|---|---|
| W / S | trim sails up / down | move |
| A / D | rudder | strafe |
| Mouse | camera | camera |
| RMB (hold) | aim broadside | parry |
| LMB | fire | sword (hold = heavy) |
| 1 / 2 / 3 | round / chain / grape shot | — |
| Space | anchor | jump / dodge |
| Shift | — | sprint |
| F | harpoon a surfaced whale | pistol |
| H | — | harpoon a circling shark |
| R | — | execution finisher (when prompted) |
| G | — | outfitter (at a port) |
| E | dock / board / collect / survey | interact / dig / go ashore |
| Q | spyglass | — |
| M / J / K / Tab | chart / journal / skills / crew & cargo | same |
| Esc | pause | pause |

## Project layout

```
src/core/      engine, input, events, state, shared math (frozen contracts)
src/data/      islands, factions, goods, quests, lore — the authored world
src/world/     ocean, sky, weather, clouds, terrain, vegetation, ports
src/ship/      ship classes, procedural shipwright, sailing physics, deck crew
src/combat/    effects, naval combat, enemy fleet AI, boarding melee, the legend
src/character/ humanoid rig, player controller, sword combat, NPCs, wildlife
src/systems/   economy, crew, quests, treasure, progression, encounters,
               viewpoints, hunting & the outfitter
src/ui/        HUD (+ target panel & nav beacons), chart, menus, trading, journal
src/audio/     synthesized SFX, ambience, generative music, sung sea shanties
docs/          game design document & module contracts
```

## Development docs

- [Game Design Document](docs/GDD.md)
- [Module Contracts](docs/CONTRACTS.md)

Headless smoke test (requires Chromium): `npm run build && npm run preview &`
then `node scripts/playtest.mjs http://localhost:4173/ shots`.
