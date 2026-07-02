// Name generators. rng is a () => [0,1) function.

const FIRST = [
  'Wren', 'Marlow', 'Isa', 'Tobias', 'Sefa', 'Corin', 'Adair', 'Nerissa',
  'Joss', 'Petra', 'Elias', 'Maren', 'Rook', 'Sable', 'Odette', 'Bram',
  'Kess', 'Falk', 'Yola', 'Dario', 'Imke', 'Silas', 'Tamsin', 'Vero',
  'Halvar', 'Onna', 'Pike', 'Rilla', 'Cormac', 'Zeri',
];

const LAST = [
  'Kestrel', 'Saltbourne', 'Redmoor', 'Vane', 'Harrow', 'Gullwing', 'Marsh',
  'Coppersall', 'Threave', 'Blackcap', 'Windrow', 'Tarran', 'Quill', 'Mott',
  'Seabright', 'Ashvale', 'Corda', 'Vell', 'Brine', 'Halloran', 'Stray',
  'Ferro', 'Lowtide', 'Pellam', 'Rakes', 'Sorrel',
];

const NICK = [
  'Ropes', 'Gunnel', 'Two-Bells', 'Halfhitch', 'the Gull', 'Dry-Boots',
  'Longsplice', 'the Quiet', 'Redhands', 'Leadline', 'Squalls', 'the Cook',
];

const SHIP_A = [
  'White', 'Pale', 'Salt', 'Storm', 'Gull', 'Red', 'Black', 'Grey', 'Wild',
  'Last', 'Bright', 'Bitter', 'Fair', 'Loud', 'Silent',
];
const SHIP_B = [
  'Gull', 'Wake', 'Promise', 'Sister', 'Fortune', 'Answer', 'Wager', 'Lantern',
  'Mercy', 'Reckoning', 'Swallow', 'Tern', 'Cutlass', 'Tide', 'Verse',
];

const STORY_WAS = [
  'a Crown deserter with a musket-ball still in one shoulder',
  'a plantation runaway who swam two miles of reef by night',
  "a fisherman's kid who watched the Concern take the family boat for debts",
  'a temple-sweeper from Verdantine who asked one question too many',
  'a shipyard rigger from Port Meridian, blacklisted for organizing',
  'a smuggler out of Saltmarsh who knows every channel by smell',
  'a whaler who swears off harpoons now and will not say why',
  'a tavern fiddler who stabbed the wrong customs officer',
];
const STORY_WANTS = [
  'wants enough gold to buy back a name',
  'wants to see the far side of the Verge before the Crown maps it',
  'wants one honest captain to sail under, just once',
  'keeps a list of Concern ledger-men and crosses them off',
  'sends every third share home and never says to whom',
  'is saving for a little sloop and a quiet cove',
  'wants the Tidebound to take them in, and is earning it',
  'just wants to be aboard something free',
];

const pickOf = (rng, arr) => arr[Math.floor(rng() * arr.length) % arr.length];

export function crewName(rng) {
  if (rng() < 0.25) return `${pickOf(rng, FIRST)} '${pickOf(rng, NICK)}' ${pickOf(rng, LAST)}`;
  return `${pickOf(rng, FIRST)} ${pickOf(rng, LAST)}`;
}

export function npcName(rng) {
  return `${pickOf(rng, FIRST)} ${pickOf(rng, LAST)}`;
}

export function shipName(rng) {
  return `${pickOf(rng, SHIP_A)} ${pickOf(rng, SHIP_B)}`;
}

export function crewStory(rng) {
  return `Was ${pickOf(rng, STORY_WAS)}; ${pickOf(rng, STORY_WANTS)}.`;
}
