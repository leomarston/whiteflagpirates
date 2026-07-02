// The four powers of the Meridian Verge. Pure data.

export const FACTIONS = {
  corsairs: {
    key: 'corsairs',
    name: 'The Free Corsairs',
    color: 0xe8e4da,
    accent: 0x5a6672,
    flag: { base: 'white', emblem: 'gull' },
    shipPrefixes: ['', '', 'Free ', 'Pale '],
    disposition: { toPlayerBase: 40 },
    motto: 'No masters. No surrender.',
  },
  crown: {
    key: 'crown',
    name: 'The Aldervane Crown',
    color: 0x1e3a6e,
    accent: 0xdfe3ec,
    flag: { base: 'blue', emblem: 'crown' },
    shipPrefixes: ['HMS ', 'HMS ', 'Royal '],
    disposition: { toPlayerBase: -25 },
    motto: 'One sea, one sovereign.',
  },
  concern: {
    key: 'concern',
    name: 'The Vermillion Concern',
    color: 0x7e2a1e,
    accent: 0xc9a24b,
    flag: { base: 'red', emblem: 'scales' },
    shipPrefixes: ['VC ', 'Good ', ''],
    disposition: { toPlayerBase: 0 },
    motto: 'Everything has a page in the ledger.',
  },
  tidebound: {
    key: 'tidebound',
    name: 'The Tidebound',
    color: 0x1d6f6d,
    accent: 0xe8dcc0,
    flag: { base: 'teal', emblem: 'spiral' },
    shipPrefixes: ['', ''],
    disposition: { toPlayerBase: 0 },
    motto: 'The tide keeps what it is owed.',
  },
};
