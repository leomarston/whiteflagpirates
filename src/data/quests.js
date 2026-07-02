// The Pale Accord — main story chapters + side quest templates. Pure data.
// Objectives are machine-checkable:
//   {type:'sink', faction, count} {type:'visit', islandId}
//   {type:'deliver', good, qty, toPort} {type:'dig'} {type:'talk', role, port}

export const QUESTS = {
  chapters: [
    {
      id: 'ch1',
      chapter: 1,
      title: 'A Flag Without a King',
      giver: 'gullhaven',
      text:
        'Mera Halloran runs the Drowned Lantern and remembers every signature on the Accord — ' +
        "yours is still wet. Prove the White Gull is more than paint: there's Concern coin " +
        'moving through the middle lane with too few guns watching it.',
      objective: { type: 'sink', faction: 'concern', count: 1 },
      rewards: { gold: 200, xp: 120, rep: { corsairs: 10, concern: -10 } },
      next: 'ch2',
    },
    {
      id: 'ch2',
      chapter: 2,
      title: 'The Ledger of Names',
      giver: 'gullhaven',
      text:
        'A page of the Concern black ledger reached the Lantern: signatories of the Accord, ' +
        'priced and sold to the Crown. The current-readers at Whisperwind can tell a true page ' +
        'from a forgery. Carry it south and ask.',
      objective: { type: 'talk', role: 'questgiver', port: 'Whisperwind' },
      rewards: { gold: 150, xp: 140, rep: { tidebound: 10 } },
      next: 'ch3',
    },
    {
      id: 'ch3',
      chapter: 3,
      title: 'Iron Tide',
      giver: 'whisperwind',
      text:
        'The page is true, and the Crown paid in commissions: hunter squadrons under naval ' +
        'colors, choking the Mistral strait. Break the blockade — send two of their hulls to ' +
        'explain themselves to the drowned garrison.',
      objective: { type: 'sink', faction: 'crown', count: 2 },
      rewards: { gold: 450, xp: 260, rep: { corsairs: 15, crown: -20 } },
      next: 'ch4',
    },
    {
      id: 'ch4',
      chapter: 4,
      title: 'What the Tide Keeps',
      giver: 'whisperwind',
      text:
        'For breaking the Iron Tide, the Tidebound offer what they offer no outsider: a bearing. ' +
        'Under the reefs of Coralline Reach lies the thing the Crown truly hunts. Sail the ' +
        'labyrinth and look on it yourself.',
      objective: { type: 'visit', islandId: 'coralline' },
      rewards: { gold: 250, xp: 300, rep: { tidebound: 20 } },
      next: 'ch5',
    },
    {
      id: 'ch5',
      chapter: 5,
      title: 'The White Wake',
      giver: 'gullhaven',
      text:
        "The havens have voted with their anchors: they'll follow the White Gull. The Crown is " +
        "massing at Drownedman's Anchorage to end the Accord in one afternoon. End theirs " +
        'instead — clear the anchorage and raise the white flag over the old fort.',
      objective: { type: 'sink', faction: 'crown', count: 3 },
      rewards: { gold: 1200, xp: 600, rep: { corsairs: 30, crown: -30 } },
      next: null,
    },
  ],

  sideTemplates: [
    {
      id: 'hunt-pirate',
      type: 'hunt',
      title: 'Rival Colors',
      textTemplate:
        'A rival crew has been working our waters near {island} and sharing nothing. ' +
        'The code is the code. Sink them.',
      objective: { type: 'sink', faction: 'pirate', count: 1 },
      rewards: { gold: 180, xp: 90, rep: { corsairs: 5 } },
    },
    {
      id: 'hunt-navy',
      type: 'hunt',
      title: 'Thin the Patrols',
      textTemplate:
        'Crown patrols have doubled on the {island} lane. Every hull you put down is a ' +
        'convoy of ours that gets through.',
      objective: { type: 'sink', faction: 'crown', count: 1 },
      rewards: { gold: 220, xp: 110, rep: { corsairs: 5, crown: -8 } },
    },
    {
      id: 'deliver-medicine',
      type: 'deliver',
      title: 'Fever Season',
      textTemplate:
        'Fever is walking through {port} and the Concern wants triple for quinine. ' +
        'Bring {qty} crates of physic and name a fair price.',
      objective: { type: 'deliver', good: 'medicine', qty: 3, toPort: null },
      rewards: { gold: 320, xp: 100, rep: {} },
    },
    {
      id: 'deliver-powder',
      type: 'deliver',
      title: 'Dry Powder',
      textTemplate:
        'The magazine at {port} is down to sweepings. {qty} barrels of gunpowder, ' +
        'no questions, no Crown stamps.',
      objective: { type: 'deliver', good: 'gunpowder', qty: 2, toPort: null },
      rewards: { gold: 280, xp: 90, rep: { corsairs: 4 } },
    },
    {
      id: 'find-treasure',
      type: 'find',
      title: 'The Old Mark',
      textTemplate:
        'An old hand left a map behind the bar against a debt. The debt is yours for the ' +
        'buying — and so is whatever the mark still covers.',
      objective: { type: 'dig' },
      rewards: { gold: 0, xp: 130, rep: {} },
    },
  ],
};
