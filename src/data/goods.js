// Trade goods of the Verge. Pure data.

export const GOODS = [
  { key: 'sugar', name: 'Sugar', basePrice: 24, weight: 1, contraband: false, tags: ['plantation'] },
  { key: 'rum', name: 'Bloomvale Rum', basePrice: 48, weight: 1, contraband: false, tags: ['plantation', 'vice'] },
  { key: 'timber', name: 'Ship Timber', basePrice: 18, weight: 2, contraband: false, tags: ['raw'] },
  { key: 'iron', name: 'Iron Fittings', basePrice: 36, weight: 2, contraband: false, tags: ['raw', 'naval'] },
  { key: 'silk', name: 'Eastern Silk', basePrice: 120, weight: 1, contraband: false, tags: ['luxury'] },
  { key: 'spice', name: 'Verge Spice', basePrice: 95, weight: 1, contraband: false, tags: ['luxury'] },
  { key: 'dyes', name: 'Coral Dyes', basePrice: 70, weight: 1, contraband: false, tags: ['luxury', 'reef'] },
  { key: 'saltfish', name: 'Salted Fish', basePrice: 12, weight: 1, contraband: false, tags: ['food'] },
  { key: 'gunpowder', name: 'Gunpowder', basePrice: 85, weight: 2, contraband: true, tags: ['naval', 'war'] },
  { key: 'medicine', name: 'Physic & Quinine', basePrice: 105, weight: 1, contraband: false, tags: ['rare'] },
  { key: 'pearls', name: 'Reef Pearls', basePrice: 210, weight: 1, contraband: false, tags: ['luxury', 'reef'] },
  { key: 'relics', name: 'Tide Relics', basePrice: 320, weight: 1, contraband: true, tags: ['ancient'] },
];

// What each biome's ports tend to produce cheap and demand dear.
export const BIOME_ECONOMY = {
  tropical: { produces: ['sugar', 'rum', 'saltfish'], demands: ['iron', 'medicine', 'silk'] },
  jungle: { produces: ['spice', 'timber'], demands: ['iron', 'saltfish', 'medicine'] },
  volcanic: { produces: ['iron'], demands: ['saltfish', 'rum', 'timber'] },
  mangrove: { produces: ['timber', 'saltfish'], demands: ['rum', 'gunpowder', 'medicine'] },
  atoll: { produces: ['pearls', 'dyes', 'saltfish'], demands: ['timber', 'rum', 'iron'] },
  rock: { produces: [], demands: ['saltfish', 'timber', 'rum'] },
};

// Port-size price flavor: bigger markets, tighter spreads, deeper stock.
export const SIZE_STOCK = { haven: 40, town: 55, capital: 80, village: 22 };
