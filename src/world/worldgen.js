// World: island meshes, colors, and the registry every other system queries.
import * as THREE from 'three';
import { clamp01, mulberry32, SimplexNoise } from '../core/utils.js';
import { SEABED, TerrainField } from './terrain.js';
import { buildVegetation } from './vegetation.js';
import { buildProps } from './props.js';
import { buildPorts } from './ports.js';

const BIOME_COLORS = {
  tropical: { low: 0xd8c496, mid: 0x4d7a3a, high: 0x6b6157, top: 0x7a7168 },
  jungle: { low: 0xcbb98c, mid: 0x2e5d2f, high: 0x3f5a35, top: 0x6b6157 },
  volcanic: { low: 0x8a8078, mid: 0x4a4442, high: 0x3a3532, top: 0x2c2826 },
  mangrove: { low: 0x5d4f3a, mid: 0x48633a, high: 0x3f5a35, top: 0x48633a },
  atoll: { low: 0xe8ddc0, mid: 0xd8c496, high: 0xc9b285, top: 0xd8c496 },
  rock: { low: 0x9a938a, mid: 0x6b6157, high: 0x59524b, top: 0x8a857e },
};

const _c1 = new THREE.Color();
const _c2 = new THREE.Color();
const _underwater = new THREE.Color(0x2e5548);
const _deepbed = new THREE.Color(0x1c2f33);

export class World {
  constructor(ctx) {
    this.ctx = ctx;
    this.field = new TerrainField(ctx.data.islands);
    this.islands = [];
    this.diveSpots = [];
    this.group = new THREE.Group();
    this.group.name = 'world';
    ctx.scene.add(this.group);

    const material = new THREE.MeshStandardMaterial({
      vertexColors: true,
      roughness: 0.95,
      metalness: 0,
    });

    for (const def of ctx.data.islands) {
      const record = this._buildIsland(def, material);
      this.islands.push(record);
    }

    this.vegetation = buildVegetation(ctx, this);
    this.props = buildProps(ctx, this);
    const ports = buildPorts(ctx, this);
    for (const port of ports) {
      const rec = this.islands.find((i) => i.def.id === port.islandId);
      if (rec) rec.port = port;
    }
    this.ports = ports;
  }

  _buildIsland(def, material) {
    const size = def.radius * 3.3;
    const segs = 132;
    const geo = new THREE.PlaneGeometry(size, size, segs, segs);
    geo.rotateX(-Math.PI / 2);

    const [cx, cz] = def.position;
    const pos = geo.attributes.position;
    const colors = new Float32Array(pos.count * 3);
    const pal = BIOME_COLORS[def.biome] ?? BIOME_COLORS.tropical;
    const jitter = new SimplexNoise(def.seed + 17);
    const peak = Math.max(8, this.field.islands.find((i) => i.def === def)?.params.peak ?? 60);

    for (let i = 0; i < pos.count; i++) {
      const wx = pos.getX(i) + cx;
      const wz = pos.getZ(i) + cz;
      const h = this.field.heightAt(wx, wz);
      pos.setY(i, h);

      // color by height band + slope + noise jitter
      const slope = this.field.slopeAt(wx, wz);
      if (h < -6) {
        _c1.copy(_deepbed);
      } else if (h < 0.4) {
        _c1.setHex(pal.low).lerp(_underwater, clamp01(-h / 7));
      } else if (h < 3.2) {
        _c1.setHex(pal.low);
      } else {
        const t = clamp01(h / (peak * 0.9));
        _c1.setHex(pal.mid).lerp(_c2.setHex(pal.top), t * t);
        if (slope > 0.55) _c1.lerp(_c2.setHex(pal.high), clamp01((slope - 0.55) / 0.5));
      }
      const j = jitter.noise2D(wx * 0.02, wz * 0.02) * 0.06;
      _c1.offsetHSL(0, 0, j);
      colors[i * 3] = _c1.r;
      colors[i * 3 + 1] = _c1.g;
      colors[i * 3 + 2] = _c1.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geo.computeVertexNormals();

    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(cx, 0, cz);
    mesh.receiveShadow = true;
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    this.group.add(mesh);

    return {
      def,
      center: new THREE.Vector3(cx, 0, cz),
      radius: def.radius,
      mesh,
      port: null,
      rng: mulberry32(def.seed),
    };
  }

  getTerrainHeight(x, z) {
    return this.field.heightAt(x, z);
  }

  getNearestIsland(pos) {
    let best = null;
    let bestD = Infinity;
    for (const isl of this.islands) {
      const d = Math.hypot(pos.x - isl.center.x, pos.z - isl.center.z);
      if (d < bestD) { bestD = d; best = isl; }
    }
    return best ? { island: best, distance: bestD } : null;
  }

  getNearestPort(pos) {
    let best = null;
    let bestD = Infinity;
    for (const isl of this.islands) {
      if (!isl.port) continue;
      const d = pos.distanceTo(isl.port.dockPosition);
      if (d < bestD) { bestD = d; best = isl; }
    }
    return best ? { island: best, port: best.port, distance: bestD } : null;
  }

  /** Highest walkable surface at (x,z): terrain or a port deck rect. */
  getWalkHeight(x, z) {
    let h = this.field.heightAt(x, z);
    for (const port of this.ports) {
      for (const s of port.walkSurfaces) {
        // rotate into surface space
        const dx = x - s.x;
        const dz = z - s.z;
        const cos = Math.cos(-s.rot);
        const sin = Math.sin(-s.rot);
        const lx = dx * cos - dz * sin;
        const lz = dx * sin + dz * cos;
        if (Math.abs(lx) <= s.hw && Math.abs(lz) <= s.hd && s.y > h) h = s.y;
      }
    }
    return h;
  }

  update(dt) {
    this.vegetation?.update?.(dt);
    this.props?.update?.(dt);
    for (const port of this.ports) port.update?.(dt);
  }
}

export { SEABED };
