// Ship classes of the Verge. length/beam/draft in meters, speeds in m/s.

export const SHIP_TYPES = {
  sloop: {
    key: 'sloop', name: 'Sloop', length: 18, beam: 5.2, draft: 2.2,
    freeboard: 1.9, maxSpeed: 19, turnRate: 0.9, hullMax: 100,
    cannonsPerSide: 3, cargoCapacity: 30, crewMax: 8, masts: 1,
    cost: 900, accel: 1.3,
    blurb: 'Darting single-master. Nothing outsails her on a reach.',
  },
  cutter: {
    key: 'cutter', name: 'Cutter', length: 15, beam: 4.4, draft: 1.8,
    freeboard: 1.6, maxSpeed: 20, turnRate: 1.0, hullMax: 80,
    cannonsPerSide: 2, cargoCapacity: 20, crewMax: 6, masts: 1,
    cost: 600, accel: 1.45,
    blurb: 'A revenue-dodger: tiny, quick, and hard to hit.',
  },
  brig: {
    key: 'brig', name: 'Brig', length: 26, beam: 7.2, draft: 3.1,
    freeboard: 2.5, maxSpeed: 16.5, turnRate: 0.68, hullMax: 180,
    cannonsPerSide: 6, cargoCapacity: 60, crewMax: 16, masts: 2,
    cost: 2600, accel: 1.1,
    blurb: 'The corsair workhorse — teeth and legs in equal measure.',
  },
  merchantman: {
    key: 'merchantman', name: 'Merchantman', length: 30, beam: 9.4, draft: 3.6,
    freeboard: 3.0, maxSpeed: 13.5, turnRate: 0.5, hullMax: 220,
    cannonsPerSide: 4, cargoCapacity: 140, crewMax: 14, masts: 2,
    cost: 3400, accel: 0.85,
    blurb: 'A floating warehouse. Slow, stubborn, and worth boarding.',
  },
  frigate: {
    key: 'frigate', name: 'Frigate', length: 38, beam: 10.2, draft: 4.4,
    freeboard: 3.4, maxSpeed: 15.5, turnRate: 0.5, hullMax: 320,
    cannonsPerSide: 10, cargoCapacity: 90, crewMax: 28, masts: 3,
    cost: 7800, accel: 0.95,
    blurb: 'Navy iron: a gun deck with a bow wave.',
  },
  galleon: {
    key: 'galleon', name: 'Galleon', length: 46, beam: 12.6, draft: 5.2,
    freeboard: 4.4, maxSpeed: 13, turnRate: 0.38, hullMax: 460,
    cannonsPerSide: 12, cargoCapacity: 200, crewMax: 40, masts: 3,
    cost: 14000, accel: 0.7,
    blurb: 'A castle under canvas. Turns like a grudge, hits like one too.',
  },
};
