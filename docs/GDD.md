# WhiteFlagPirates — Game Design Document

An open-world pirate action-adventure set in **the Meridian Verge**, an original
fantasy archipelago. The player is **Captain Wren Kestrel**, last signatory of the
**Pale Accord** — a brotherhood of corsairs who burned their letters of marque and
sail under a white flag that means *no masters*, not surrender.

## Pillars

1. **The ocean is the main character.** Waves, wind, and weather are simulated and
   drive every system: sailing speed, combat positioning, mood, music.
2. **One world, no seams.** Sail from the open sea to a dock, step off the ship,
   walk into a tavern, duel in an alley — no loading screens.
3. **Emergence over scripting.** Economy, factions, weather, and encounters
   interact: a storm scatters a convoy, prices spike, pirates gather, the navy
   responds.
4. **A handcrafted-feeling procedural world.** Every island is authored as data
   (name, biome, faction, story) and realized procedurally with care.

## The Setting — The Meridian Verge

A crescent of volcanic and coral islands far from the old continents. Three powers
contest it; a fourth remembers when it was free.

### Factions

| Faction | Identity | Attitude to player |
|---|---|---|
| **The Aldervane Crown** | A colonial empire of grey stone forts, navy squadrons, and tax stamps. Colors: royal blue / white. | Hostile to piracy; bounties, hunters. |
| **The Vermillion Concern** | A merchant cartel richer than the Crown. Convoys, auction houses, black ledgers. Colors: deep red / gold. | Transactional. Will trade with anyone; will bury anyone. |
| **The Free Corsairs** | The white-flag brotherhood. Havens, shanties, a rough code: no slaves, no navies, shares for all. Colors: white / storm grey. | The player's people. |
| **The Tidebound** | Islander confederation, readers of currents and stars. Keepers of the old ruins. Colors: teal / bone. | Wary; earned trust opens secrets. |

### Key Islands (12 authored)

- **Gullhaven** — Free Corsair haven built into a wrecked galleon fleet. Player start. Tavern *The Drowned Lantern*.
- **Port Meridian** — Crown capital. Stone fort, lighthouse, naval shipyard. High law.
- **Fort Ruin (Drownedman's Anchorage)** — half-sunk sea fort, contested.
- **Cinderpeak** — active volcano, ash beaches, glassy obsidian coves.
- **Verdantine** — dense jungle, waterfalls, hidden temple of the Tidebound.
- **Saltmarsh Shallows** — mangrove maze, smuggler stashes, crocodiles.
- **Bonecay** — bone-white atoll, famous buried hoards.
- **Mistral Rock** — lone lighthouse crag in the windiest strait.
- **Bloomvale** — Concern plantation island, wealthy and rotten.
- **Coralline Reach** — reef labyrinth, shipwreck diving.
- **The Old Teeth** — cliff pillars and ancient ruins, seabird colonies.
- **Whisperwind Isle** — Tidebound village, star-tower, night markets.

### Main story — "The Pale Accord" (chapters)

1. **A Flag Without a King** — prove yourself at Gullhaven; first ship, first prize.
2. **The Ledger of Names** — the Concern is selling Accord signatories to the Crown.
3. **Iron Tide** — the Crown commissions a hunter squadron; break the blockade of Mistral Rock.
4. **What the Tide Keeps** — the Tidebound reveal the Verge's oldest secret beneath Coralline Reach.
5. **The White Wake** — unite the havens; the final battle at Drownedman's Anchorage.

## Core Loops

- **Sail** → discover islands / encounters → **fight or trade** → earn sovereigns & reputation → **upgrade ship, hire crew, learn skills** → sail further into danger.
- **Port loop**: dock → trade goods (dynamic prices) → tavern (crew, rumors) → shipwright (upgrades) → quest board → depart.
- **Treasure loop**: find map (loot/tavern/bottle) → read the sketch & riddle → find island & spot → dig → hoard.

## Currency & Economy

Currency: **sovereigns** (gold). Goods: sugar, rum, timber, iron, silk, spice, dyes,
salted fish, gunpowder, medicine, pearls, relics (contraband in Crown ports).
Each port has supply/demand modifiers that drift and react to world events.

## Modes

- `sail` — commanding the ship (default at sea).
- `foot` — third-person on land, docks, and decks.
- `menu` — title/pause/map/trade screens.

## Controls (default)

| Input | Sail | Foot |
|---|---|---|
| W/S | more/less sail | move forward/back |
| A/D | rudder port/starboard | strafe |
| Mouse | free look camera | camera / aim |
| LMB | fire aimed broadside | sword attack (hold = heavy) |
| RMB (hold) | aim cannons | parry/block |
| Space | — | jump / dodge (with direction) |
| Shift | — | sprint |
| F | — | fire pistol |
| E | dock / interact / collect | interact / talk / dig |
| Q | spyglass | — |
| Tab | crew & cargo | crew & cargo |
| M | world map | world map |
| J | journal | journal |
| K | skills | skills |
| Esc | pause | pause |

## Tone & Art Direction

Painterly-realistic: strong physically-plausible lighting (ACES), warm lanterns
against cold sea, readable silhouettes, parchment-and-brass UI. The white flag
motif recurs: sails, UI accents, the title screen.

**Everything is procedural** — geometry, textures (canvas-generated), audio
(synthesized). No external asset files, ever.
