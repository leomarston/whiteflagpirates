// Analytic island terrain — single source of truth for meshes AND queries.
import { clamp01, fbm2, lerp, SimplexNoise, smoothstep } from '../core/utils.js';

export const SEABED = -38;

const BIOME_PARAMS = {
  tropical: { peak: 74, detail: 14, ridged: false },
  jungle: { peak: 118, detail: 22, ridged: false },
  volcanic: { peak: 205, detail: 26, ridged: true },
  mangrove: { peak: 11, detail: 4, ridged: false },
  atoll: { peak: 7, detail: 2, ridged: false },
  rock: { peak: 104, detail: 30, ridged: true },
};

export class TerrainField {
  constructor(islandDefs) {
    this.islands = islandDefs.map((def) => ({
      def,
      cx: def.position[0],
      cz: def.position[1],
      r: def.radius,
      bound: def.radius * 1.75,
      noise: new SimplexNoise(def.seed),
      params: BIOME_PARAMS[def.biome] ?? BIOME_PARAMS.tropical,
    }));
  }

  /** World-space ground height (negative = seabed). Fast: early-out per island. */
  heightAt(x, z) {
    let h = SEABED;
    for (let i = 0; i < this.islands.length; i++) {
      const isl = this.islands[i];
      const dx = x - isl.cx;
      const dz = z - isl.cz;
      if (Math.abs(dx) > isl.bound || Math.abs(dz) > isl.bound) continue;
      const d = Math.sqrt(dx * dx + dz * dz);
      if (d > isl.bound) continue;
      const hi = this._islandHeight(isl, dx, dz, d);
      if (hi > h) h = hi;
    }
    return h;
  }

  _islandHeight(isl, dx, dz, d) {
    const { noise, params, r, def } = isl;
    // fbm-warped coastline so no island is a circle
    const ang = Math.atan2(dz, dx);
    const warp = fbm2(noise, Math.cos(ang) * 1.6 + 10.7, Math.sin(ang) * 1.6 + 3.1, 3);
    const rr = r * (1 + 0.24 * warp);

    if (d >= rr) {
      // underwater skirt down to the seabed
      const t = clamp01((d - rr) / (rr * 0.62));
      return lerp(-0.8, SEABED, smoothstep(0, 1, t));
    }

    const t = 1 - d / rr;              // 0 at coast → 1 at center
    const f = t * t * (3 - 2 * t);     // smoothed falloff

    let detail = fbm2(noise, (isl.cx + dx) * 0.008, (isl.cz + dz) * 0.008, 4);
    if (params.ridged) detail = 1 - Math.abs(detail) * 2; // sharp ridells

    let h;
    if (def.biome === 'atoll') {
      // ring reef with a lagoon dip in the middle
      const ring = Math.exp(-((t - 0.42) ** 2) / 0.028);
      h = ring * params.peak + detail * params.detail * ring;
      if (t > 0.7) h -= (t - 0.7) * 14; // lagoon
    } else {
      h = Math.pow(f, 1.35) * params.peak + detail * params.detail * f;
      if (def.biome === 'volcanic' && f > 0.8) {
        h -= ((f - 0.8) / 0.2) * params.peak * 0.42; // crater
      }
    }

    // gentle beaches: compress the band around the waterline
    if (h > -2 && h < 5) h *= 0.55;

    // ease into the water at the very coast
    if (t < 0.06) h = lerp(-0.8, h, t / 0.06);
    return h;
  }

  /** Approximate slope (rise over 2m run). */
  slopeAt(x, z) {
    const e = 2;
    const hx = this.heightAt(x + e, z) - this.heightAt(x - e, z);
    const hz = this.heightAt(x, z + e) - this.heightAt(x, z - e);
    return Math.sqrt(hx * hx + hz * hz) / (2 * e);
  }
}
