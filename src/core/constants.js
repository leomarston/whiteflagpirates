// Frozen tuning tables shared by every module. See docs/CONTRACTS.md.

export const WORLD = {
  SEA_SIZE: 16000,     // playable square, meters (±8000)
  SEA_LEVEL: 0,
  DAY_LENGTH: 720,     // seconds per full day-night cycle
  GRAVITY: 9.81,
  START_DAYFRAC: 0.34, // morning light at boot
};

// Canonical Gerstner wave set at seaState = 1.0. The CPU sampler in
// core/utils.js and the ocean GLSL must both use exactly these parameters.
// steepness here is Q*a*k-normalized: amplitude = steepness / k.
export const GERSTNER_WAVES = [
  { dir: [1.0, 0.35], steepness: 0.11, wavelength: 74.0 },
  { dir: [0.68, -0.73], steepness: 0.09, wavelength: 37.0 },
  { dir: [-0.22, 0.97], steepness: 0.07, wavelength: 19.0 },
  { dir: [0.87, 0.78], steepness: 0.055, wavelength: 10.5 },
  { dir: [-0.58, -0.81], steepness: 0.042, wavelength: 5.6 },
  { dir: [0.31, -0.95], steepness: 0.03, wavelength: 2.9 },
];

// Sea-state amplitude floor: effective amplitude scale = lerp(0.16, 1.0, seaState)
export const SEA_STATE_MIN_SCALE = 0.16;

export const COLORS = {
  deepWater: 0x0a2e44,
  shallowWater: 0x1d6f6d,
  foam: 0xeef4f2,
  sand: 0xd8c496,
  grass: 0x4d7a3a,
  jungle: 0x2e5d2f,
  rock: 0x6b6157,
  ash: 0x4a4442,
  snowcap: 0xe8e8ea,
  hullWood: 0x5c4028,
  deckWood: 0x8a6a44,
  sailCloth: 0xe9e2d0,
  lantern: 0xffb45e,
  uiBrass: 0xc9a24b,
};

export const PLAYER = {
  WALK_SPEED: 4.2,
  RUN_SPEED: 7.6,
  SWIM_SPEED: 2.6,
  JUMP_SPEED: 5.4,
  HP_MAX: 100,
  STAMINA_MAX: 100,
  HEIGHT: 1.75,
};

export const SHIP_TUNING = {
  BUOY_SPRING: 4.2,        // buoyancy spring stiffness
  BUOY_DAMP: 0.85,
  WIND_POWER: 0.85,        // thrust = windSpeed * sailArea-normalized * this
  DRAG_K: 0.028,           // quadratic drag
  RUDDER_AUTH: 0.7,
  AGROUND_DAMAGE: 4,
  DOCK_RANGE: 34,          // m to dockPosition to allow docking
  DOCK_MAX_SPEED: 3.0,     // m/s
};

export const COMBAT = {
  BALL_SPEED: 95,          // m/s muzzle
  BALL_GRAVITY: 9.81,
  RELOAD_TIME: 6.5,        // s per side, modified by crew/skills
  ROUNDSHOT_DMG: 11,
  CHAINSHOT_DMG: 5,
  GRAPESHOT_DMG: 3,
  MAX_RANGE: 620,
  BOARD_RANGE: 42,
  SWORD_LIGHT_DMG: 12,
  SWORD_HEAVY_DMG: 26,
  PISTOL_DMG: 30,
};

export const ECONOMY = {
  START_GOLD: 350,
  PRICE_DRIFT: 0.22,       // max fractional drift of prices
  SELL_MARGIN: 0.82,       // ports buy at this fraction of local price
};

export const FACTION_KEYS = ['corsairs', 'crown', 'concern', 'tidebound'];

export const SAVE_KEY = 'whiteflagpirates_save_v1';
