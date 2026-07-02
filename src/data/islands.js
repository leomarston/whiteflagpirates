// The 12 authored islands of the Meridian Verge. Pure data — see docs/CONTRACTS.md.
//
// Layout notes (hand-placed, painterly):
//   - Central cluster & main shipping lane: Bloomvale ↔ Gullhaven ↔ Fort Ruin ↔
//     Mistral Rock ↔ Port Meridian. Concern convoys and Crown patrols run this
//     line; corsairs hunt the middle of it.
//   - Southern arc (Tidebound waters): Verdantine → Whisperwind → Saltmarsh →
//     Coralline Reach — a gentler lane of villages and reefs.
//   - Lonely outposts: Bonecay far to the southeast, Cinderpeak and The Old
//     Teeth brooding in the northwest.
//   - All centers ≥ 1600 m apart; positions within ±6000 m; radii 350–900 m.

export const ISLANDS = [
  {
    id: 'gullhaven',
    name: 'Gullhaven',
    position: [-1500, 600],
    radius: 520,
    seed: 4111,
    biome: 'tropical',
    faction: 'corsairs',
    port: {
      name: 'Gullhaven',
      size: 'haven',
      hasTavern: true,
      hasShipwright: true,
      hasQuests: true,
    },
    description:
      'A free haven raised on the bones of a wrecked treasure fleet — hulls for houses, ' +
      'masts for bell towers, and The Drowned Lantern pouring at all hours. Every white ' +
      'flag in the Verge calls it home at least once a year.',
    loreHints: [
      "The Drowned Lantern's cellar is an upturned galleon older than the Accord itself.",
      'Locals swear the harbor bell rings by itself the night before a bad storm.',
      "Old Captain Herrol's chair still sits empty at the Lantern; nobody has dared take it.",
    ],
  },
  {
    id: 'portmeridian',
    name: 'Port Meridian',
    position: [3600, -2200],
    radius: 780,
    seed: 4122,
    biome: 'tropical',
    faction: 'crown',
    port: {
      name: 'Port Meridian',
      size: 'capital',
      hasTavern: true,
      hasShipwright: true,
      hasQuests: true,
    },
    description:
      "The Aldervane Crown's grey fist in the Verge: a stone fort, a naval shipyard, and a " +
      'lighthouse that never blinks. Everything here is taxed, stamped, weighed, and watched.',
    loreHints: [
      "The fort's guns are named for Aldervane queens, and the gunners swear each one has her temper.",
      'Contraband found at the customs house buys you a short walk and a long drop.',
      'The lighthouse keeper logs every sail she sees — and is paid twice over for white ones.',
    ],
  },
  {
    id: 'fortruin',
    name: "Drownedman's Anchorage",
    position: [200, -700],
    radius: 380,
    seed: 4133,
    biome: 'rock',
    faction: 'crown',
    description:
      'A half-sunk sea fort slumping into its own moat, held this season by whoever last ' +
      'bothered to raise a flag over it. Its flooded galleries are a warren of eels, ' +
      'powder rooms, and older bones.',
    loreHints: [
      'The fort sank in a single night, and no two survivors told the same story about why.',
      'On a still tide you can hear the drowned garrison bell knocking somewhere below the waterline.',
      'Every power in the Verge has planted a flag here; the anchorage has outlasted all of them.',
    ],
  },
  {
    id: 'cinderpeak',
    name: 'Cinderpeak',
    position: [-3400, -3800],
    radius: 860,
    seed: 4144,
    biome: 'volcanic',
    faction: 'corsairs',
    description:
      'An active volcano wearing a shawl of ash, ringed by black-sand beaches and coves of ' +
      'glassy obsidian. The mountain grumbles in its sleep, and the wise keep a spring line ready.',
    loreHints: [
      'Corsairs careen their hulls in the obsidian coves — the black glass scrapes barnacles like a razor.',
      'The mountain is said to swallow a ship a decade. Locals leave it a cask of rum to stay ahead on the ledger.',
      'Ash falls here like grey snow; old hands can read the wind for a week in how it drifts.',
    ],
  },
  {
    id: 'verdantine',
    name: 'Verdantine',
    position: [-2900, 3300],
    radius: 880,
    seed: 4155,
    biome: 'jungle',
    faction: 'tidebound',
    description:
      'Jungle so dense the rain takes a full minute to reach the ground, cut by white waterfalls ' +
      'and stairways older than any chart. Somewhere under all that green stands a temple the ' +
      'Tidebound still sweep.',
    loreHints: [
      'The Tidebound keep the temple paths swept but will not say for whom.',
      'Birds here mimic ship bells and boatswain whistles — more than one crew has answered them.',
      'The waterfalls run warm after Cinderpeak grumbles, though the islands sit half a sea apart.',
    ],
  },
  {
    id: 'saltmarsh',
    name: 'Saltmarsh Shallows',
    position: [1900, 3900],
    radius: 720,
    seed: 4166,
    biome: 'mangrove',
    faction: 'corsairs',
    port: {
      name: 'Saltmarsh Stilts',
      size: 'village',
      hasTavern: true,
      hasShipwright: false,
      hasQuests: false,
    },
    description:
      'A mangrove maze where the channels move with the tide and the village moves with the ' +
      'channels — taverns on stilts, walkways of lashed planks, and stashes sunk in the mud ' +
      'that only smugglers can find twice.',
    loreHints: [
      'The crocodiles here are named and fed like harbor cats. Do not swim regardless.',
      'Half the contraband in the Verge sleeps under this mud, tied to markers only smugglers can read.',
      "Crown cutters won't follow past the second channel bend. There's a reason it's called Widow's Bend.",
    ],
  },
  {
    id: 'bonecay',
    name: 'Bonecay',
    position: [4900, 4800],
    radius: 480,
    seed: 4177,
    biome: 'atoll',
    faction: 'corsairs',
    description:
      'A bone-white atoll far out on the southeastern rim, famous for buried hoards and the ' +
      'diggers who never sailed home to spend them. The sand is blinding at noon and silver at night.',
    loreHints: [
      'More gold is rumored under Bonecay than in the Crown mint — and more shovels than gold.',
      'Old crews buried their hoards at high-water mark; the high-water mark has moved since.',
      'The cay is littered with whale bones no whale could have carried there.',
    ],
  },
  {
    id: 'mistralrock',
    name: 'Mistral Rock',
    position: [1600, -2300],
    radius: 350,
    seed: 4188,
    biome: 'rock',
    faction: 'crown',
    description:
      'A lone lighthouse crag in the windiest strait of the Verge, where the gale never fully ' +
      'sleeps and the sea stands up in ranks. Ships pass close to read the light — or wreck trying.',
    loreHints: [
      'The strait wind has a name — the Mistral — and sailors apologize to it out of habit.',
      'Three keepers have gone mad in that tower; the fourth brought a dog and does fine.',
      'When the light burns blue, Crown hunters are in the strait. That is not in any almanac.',
    ],
  },
  {
    id: 'bloomvale',
    name: 'Bloomvale',
    position: [-4400, -300],
    radius: 740,
    seed: 4199,
    biome: 'tropical',
    faction: 'concern',
    port: {
      name: 'Bloomvale Landing',
      size: 'town',
      hasTavern: true,
      hasShipwright: true,
      hasQuests: false,
    },
    description:
      'A Vermillion Concern plantation island, wealthy and rotten — sugar rows combed to the ' +
      'horizon, a landing town of red warehouses, and ledgers balanced in ways nobody sober ' +
      'discusses aloud.',
    loreHints: [
      "The Concern's black ledgers are said to hold a page for every soul in the Verge, priced.",
      'Bloomvale rum is the finest afloat; the fieldhands who cut its cane never taste it.',
      "The auction bell rings at dawn. What's sold before breakfast is not always cargo.",
    ],
  },
  {
    id: 'coralline',
    name: 'Coralline Reach',
    position: [4300, 2400],
    radius: 620,
    seed: 4200,
    biome: 'atoll',
    faction: 'tidebound',
    description:
      'A reef labyrinth of impossible colors with more ships under the water than ever sailed ' +
      'above it. Divers come for pearls and wreck-silver; the Tidebound come for something ' +
      'older, and do not say what.',
    loreHints: [
      'The reef rearranges itself — channels open and close like a hand slowly making a fist.',
      'Wreck-divers speak of a light far below the deepest hulls, steady as a lamp, cold as a star.',
      'The Tidebound sail the labyrinth without charts and anchor nowhere inside it.',
    ],
  },
  {
    id: 'oldteeth',
    name: 'The Old Teeth',
    position: [-5300, -2200],
    radius: 560,
    seed: 4211,
    biome: 'rock',
    faction: 'tidebound',
    description:
      'Cliff pillars rising sheer from deep water, screaming with seabird colonies and crowned ' +
      'by ruins that nobody built twice. The stones are older than the Verge has names for.',
    loreHints: [
      'The ruins atop the pillars align with no star anyone living can point to.',
      'Gulls nest in the eye-sockets of carved faces taller than a mainmast.',
      'Tidebound crews lower their voices in the channel between the Teeth. Ask them why and they change course.',
    ],
  },
  {
    id: 'whisperwind',
    name: 'Whisperwind Isle',
    position: [-700, 4600],
    radius: 540,
    seed: 4222,
    biome: 'tropical',
    faction: 'tidebound',
    port: {
      name: 'Whisperwind',
      size: 'village',
      hasTavern: true,
      hasShipwright: false,
      hasQuests: true,
    },
    description:
      'A Tidebound village beneath a star-tower, where the markets open at moonrise and the ' +
      'currents are read like letters from a relative. Outsiders are welcome to trade, watched ' +
      'while they do, and remembered after they leave.',
    loreHints: [
      'The star-tower has no door at ground level and lights no lamp — yet is never dark.',
      'Night-market vendors accept sovereigns but prefer stories, and pay better for true ones.',
      'The current-readers knew the great storm of the last decade was coming a month early. They told no one who did not ask.',
    ],
  },
];
