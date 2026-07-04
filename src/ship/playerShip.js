// The player's ship: helm controls, follow camera, docking, spyglass, upgrades.
import * as THREE from 'three';
import { SHIP_TUNING } from '../core/constants.js';
import { angleDamp, clamp, damp, knots, lerp, wrapAngle } from '../core/utils.js';

const _camTarget = new THREE.Vector3();
const _camPos = new THREE.Vector3();

const TIER_HULL = [1, 1.35, 1.8];
const TIER_SPEED = [1, 1.12, 1.25];

export class PlayerShip {
  constructor(ctx) {
    this.ctx = ctx;
    this.ship = null;
    this.sailTarget = 0;
    this.anchored = false;
    this.aimSide = null;
    this.heading = 0;
    this.speedKnots = 0;
    this.sailAmount = 0;

    // camera orbit state
    this._camYaw = Math.PI;      // relative to ship heading (π = behind)
    this._camPitch = 0.24;
    this._camDist = 34;
    this._freeLookTimer = 0;
    this._spyglass = false;
    this._baseFov = ctx.state?.settings?.fov ?? 60;
    this._dockNear = null;
    this._docked = false;

    // cinematic follow state (smoothed each frame)
    this._lookAhead = new THREE.Vector3();
    this._camRoll = 0;

    this._rebuild();

    ctx.events?.on('game:start', () => {
      this._rebuild();
      this.applyUpgrades();
      this._docked = false;
      this.anchored = false;
      this.sailTarget = 0.55; // get underway immediately — she's already moving
    });
    ctx.events?.on('ship:upgraded', () => this.applyUpgrades());
    // buying a new hull or repainting rebuilds the ship in place
    ctx.events?.on('ship:changed', () => { this._rebuild(true); });
    ctx.events?.on('ship:undock', () => {
      this._docked = false;
      this.anchored = false;
      if (this.ship) this.ship.physics.anchored = false;
    });
    ctx.events?.on('mode:change', ({ mode }) => {
      if (mode === 'sail') this.ctx.input?.exitPointerLock?.();
    });
  }

  _rebuild(force = false) {
    const data = this.ctx.state?.data?.ship ?? { type: 'sloop' };
    if (!force && this.ship && this.ship.typeKey === data.type) return;
    // preserve where the old ship was so a new hull appears at the dock, not origin
    let px = 0, pz = 0, ph = 0;
    if (this.ship) {
      px = this.ship.group.position.x;
      pz = this.ship.group.position.z;
      ph = this.ship.physics.heading;
      this.ctx.ships?.remove(this.ship);
    }
    this.ship = this.ctx.ships?.createShip(data.type, {
      player: true,
      faction: 'corsairs',
      paint: data.paint === 'default' ? undefined : data.paint,
      name: data.name ?? 'White Gull',
    });
    if (this.ship && (px || pz)) this.ship.physics.placeAt(px, pz, ph);
    this.applyUpgrades();
  }

  applyUpgrades() {
    const ship = this.ship;
    const data = this.ctx.state?.data?.ship;
    if (!ship || !data) return;
    const hullMult = TIER_HULL[(data.hullTier ?? 1) - 1] ?? 1;
    const prevMax = ship.hullMax;
    ship.hullMax = ship.type.hullMax * hullMult;
    if (data.hull != null) ship.hull = Math.min(data.hull, ship.hullMax);
    else if (prevMax !== ship.hullMax) ship.hull = ship.hullMax;
    const nav = this.ctx.crew?.speedBonus?.() ?? 1;
    ship.physics.speedMult = (TIER_SPEED[(data.sailTier ?? 1) - 1] ?? 1) * nav;
  }

  placeAt(x, z, heading) {
    this.ship?.physics.placeAt(x, z, heading);
    this._camYaw = Math.PI;
    this._camPitch = 0.24;
  }

  update(dt) {
    const { ctx, ship } = this;
    if (!ship?.alive) return;
    const input = ctx.input;
    const sailMode = ctx.mode === 'sail';

    if (sailMode && !ctx.time.paused) {
      // sail trim — quick to answer the helm
      if (input.isDown('KeyW')) this.sailTarget = clamp(this.sailTarget + dt * 1.1, 0, 1);
      if (input.isDown('KeyS')) this.sailTarget = clamp(this.sailTarget - dt * 1.3, 0, 1);
      ship.sailAmount = damp(ship.sailAmount, this.anchored ? 0 : this.sailTarget, 4, dt);

      // rudder with spring return
      let rudderIn = 0;
      if (input.isDown('KeyA')) rudderIn -= 1;
      if (input.isDown('KeyD')) rudderIn += 1;
      ship.physics.rudder = damp(ship.physics.rudder, rudderIn, rudderIn !== 0 ? 4 : 2.5, dt);

      // anchor
      if (input.wasPressed('Space')) {
        this.anchored = !this.anchored;
        ship.physics.anchored = this.anchored;
        ctx.events?.emit('toast', {
          text: this.anchored ? 'Anchor down.' : 'Anchor aweigh!',
          kind: 'info',
        });
      }

      // aiming side
      if (input.mouse.pressed(2)) {
        const camAz = this._camYaw;
        this.aimSide = Math.sin(camAz) > 0 ? 'L' : 'R';
      } else {
        this.aimSide = null;
      }

      // spyglass
      this._spyglass = input.isDown('KeyQ');

      // camera orbit from mouse (pointer lock or drag)
      const dragging = input.pointerLocked || input.mouse.pressed(0) || input.mouse.pressed(2);
      if (dragging && (input.mouse.dx || input.mouse.dy)) {
        const invert = ctx.state?.settings?.invertY ? -1 : 1;
        this._camYaw -= input.mouse.dx * 0.0032;
        this._camPitch = clamp(this._camPitch + input.mouse.dy * 0.0026 * invert, -0.1, 1.15);
        this._freeLookTimer = 2.4;
      } else {
        this._freeLookTimer -= dt;
        if (this._freeLookTimer < 0 && !this.aimSide) {
          this._camYaw = angleDamp(this._camYaw, Math.PI, 0.9, dt);
        }
      }
      if (input.mouse.wheel) {
        this._camDist = clamp(this._camDist * (1 + input.mouse.wheel * 0.12), 9, 95);
      }

      // pointer lock on click for smooth free look
      if (input.mouse.wasPressed(0) && !input.pointerLocked && !ctx.time.paused) {
        input.requestPointerLock(ctx.engine.canvas);
      }

      this._updateLandfall();
      this._updateCamera(dt);
    }

    this.heading = ship.physics.heading;
    this.speedKnots = knots(ship.physics.speed);
    this.sailAmount = ship.sailAmount;

    // persist current hull for save
    if (ctx.state?.data?.ship) ctx.state.data.ship.hull = ship.hull;
  }

  _updateLandfall() {
    const { ctx, ship } = this;
    const pos = ship.group.position;

    // 1. Formal port dock takes priority (opens market/tavern/shipwright menu).
    //    Speed-tolerant now — pressing E anchors her, so a fast approach is fine.
    const port = ctx.world?.getNearestPort?.(pos);
    if (port && port.distance < 60 && !this._docked) {
      this._landfall = 'dock';
      ctx.events?.emit('prompt', { id: 'landfall', text: `E — Dock at ${port.port.name}` });
      if (ctx.input.wasPressed('KeyE')) {
        this._docked = true;
        this.anchored = true;
        ship.physics.anchored = true;
        this.sailTarget = 0;
        ctx.events?.emit('prompt', { id: 'landfall', text: null });
        ctx.events?.emit('ship:dock', { port: port.port, island: port.island });
      }
      return;
    }

    // 2. Otherwise, go ashore on ANY nearby island — the only way onto non-port
    //    islands (treasure, ruins, wildlife). Drops anchor and puts you on foot
    //    at the beach.
    const isl = ctx.world?.getNearestIsland?.(pos);
    const shoreGap = isl ? isl.distance - isl.island.radius : Infinity;
    if (isl && shoreGap < 110) {
      this._landfall = 'shore';
      ctx.events?.emit('prompt', { id: 'landfall', text: 'E — Drop anchor & go ashore' });
      if (ctx.input.wasPressed('KeyE')) {
        this.anchored = true;
        ship.physics.anchored = true;
        this.sailTarget = 0;
        ctx.events?.emit('prompt', { id: 'landfall', text: null });
        const shore = this._findShorePoint(pos, isl.island);
        ctx.events?.emit('ship:goashore', { island: isl.island, shore });
      }
      return;
    }

    if (this._landfall) {
      this._landfall = null;
      ctx.events?.emit('prompt', { id: 'landfall', text: null });
    }
  }

  /** March from the ship toward the island to find the beach; returns a spawn. */
  _findShorePoint(from, island) {
    const world = this.ctx.world;
    const dx = island.center.x - from.x;
    const dz = island.center.z - from.z;
    const dist = Math.hypot(dx, dz) || 1;
    const nx = dx / dist, nz = dz / dist;
    for (let d = 0; d < dist; d += 3) {
      const x = from.x + nx * d;
      const z = from.z + nz * d;
      if (world.getTerrainHeight(x, z) > 0.4) {
        // step a couple meters onto the dry beach
        const sx = x + nx * 2.5;
        const sz = z + nz * 2.5;
        const sy = world.getWalkHeight ? world.getWalkHeight(sx, sz) : world.getTerrainHeight(sx, sz);
        return { point: { x: sx, y: sy, z: sz }, heading: Math.atan2(nx, nz) };
      }
    }
    // fallback: just inside the island edge
    const x = island.center.x - nx * island.radius * 0.9;
    const z = island.center.z - nz * island.radius * 0.9;
    return {
      point: { x, y: Math.max(world.getTerrainHeight(x, z), 0.3), z },
      heading: Math.atan2(nx, nz),
    };
  }

  _updateCamera(dt) {
    const { ctx, ship } = this;
    const cam = ctx.camera;
    const g = ship.group;
    const phys = ship.physics;

    const yaw = phys.heading + this._camYaw;
    const spd = phys.speed;
    const speedFrac = clamp(spd / (ship.type.maxSpeed * 1.15), 0, 1);

    // she pulls the camera back a touch as she takes up speed — a sense of rush
    let dist = this._camDist * (1 + speedFrac * 0.12);
    let pitch = this._camPitch;
    // aiming pulls the camera abeam for a gun-deck view
    if (this.aimSide) {
      dist = Math.min(dist, 46);
      pitch = Math.max(pitch, 0.18);
    }

    const ch = Math.cos(pitch);
    _camPos.set(
      g.position.x + Math.sin(yaw) * ch * dist,
      g.position.y + Math.sin(pitch) * dist + 3,
      g.position.z + Math.cos(yaw) * ch * dist,
    );

    // never dip under the sea
    const waterY = ctx.ocean ? ctx.ocean.getHeight(_camPos.x, _camPos.z) : 0;
    if (_camPos.y < waterY + 1.6) _camPos.y = waterY + 1.6;

    // spring-damped follow (frame-rate independent)
    const k = 1 - Math.exp(-dt * 7);
    cam.position.lerp(_camPos, k);

    // look-ahead: lead the bow with speed and bank the aim into the turn (yaw
    // rate), so the camera anticipates where she's driving, not just her stern.
    const sh = Math.sin(phys.heading), cs = Math.cos(phys.heading);
    const swing = phys.yawRate * spd;
    const leadX = clamp(sh * spd * 0.2 + cs * swing * 0.4, -11, 11);
    const leadZ = clamp(cs * spd * 0.2 - sh * swing * 0.4, -11, 11);
    this._lookAhead.x = damp(this._lookAhead.x, leadX, 2.4, dt);
    this._lookAhead.z = damp(this._lookAhead.z, leadZ, 2.4, dt);

    _camTarget.copy(g.position);
    _camTarget.x += this._lookAhead.x;
    _camTarget.z += this._lookAhead.z;
    _camTarget.y += ship.type.freeboard + 3.2;
    cam.lookAt(_camTarget);

    // gentle horizon roll tied to her heel — the deck leans, the world tilts
    this._camRoll = damp(this._camRoll, phys._heel * 0.32, 3, dt);
    cam.rotateZ(this._camRoll);

    // FOV: widens with speed (faster = wider); spyglass overrides to a tight zoom
    const baseFov = ctx.state?.settings?.fov ?? this._baseFov ?? 60;
    const targetFov = this._spyglass ? 20 : baseFov + speedFrac * 11;
    if (Math.abs(cam.fov - targetFov) > 0.05) {
      cam.fov = lerp(cam.fov, targetFov, 1 - Math.exp(-dt * (this._spyglass ? 9 : 4)));
      cam.updateProjectionMatrix();
    }
  }
}
