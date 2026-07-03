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

    this._rebuild();

    ctx.events?.on('game:start', () => {
      this._rebuild();
      this.applyUpgrades();
      this._docked = false;
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
      // sail trim
      if (input.isDown('KeyW')) this.sailTarget = clamp(this.sailTarget + dt * 0.65, 0, 1);
      if (input.isDown('KeyS')) this.sailTarget = clamp(this.sailTarget - dt * 0.8, 0, 1);
      ship.sailAmount = damp(ship.sailAmount, this.anchored ? 0 : this.sailTarget, 2.5, dt);

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

      this._updateDocking();
      this._updateCamera(dt);
    }

    this.heading = ship.physics.heading;
    this.speedKnots = knots(ship.physics.speed);
    this.sailAmount = ship.sailAmount;

    // persist current hull for save
    if (ctx.state?.data?.ship) ctx.state.data.ship.hull = ship.hull;
  }

  _updateDocking() {
    const { ctx, ship } = this;
    const near = ctx.world?.getNearestPort?.(ship.group.position);
    const canDock = near && near.distance < SHIP_TUNING.DOCK_RANGE &&
      Math.abs(ship.physics.speed) < SHIP_TUNING.DOCK_MAX_SPEED && !this._docked;
    if (canDock) {
      this._dockNear = near;
      ctx.events?.emit('prompt', { id: 'dock', text: `E — Dock at ${near.port.name}` });
      if (ctx.input.wasPressed('KeyE')) {
        this._docked = true;
        this.anchored = true;
        ship.physics.anchored = true;
        this.sailTarget = 0;
        ctx.events?.emit('prompt', { id: 'dock', text: null });
        ctx.events?.emit('ship:dock', { port: near.port, island: near.island });
      }
    } else if (this._dockNear) {
      this._dockNear = null;
      ctx.events?.emit('prompt', { id: 'dock', text: null });
    }
  }

  _updateCamera(dt) {
    const { ctx, ship } = this;
    const cam = ctx.camera;
    const g = ship.group;

    const yaw = ship.physics.heading + this._camYaw;
    // aiming pulls the camera abeam for a gun-deck view
    let dist = this._camDist;
    let pitch = this._camPitch;
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

    const k = 1 - Math.exp(-dt * 7);
    cam.position.lerp(_camPos, k);
    _camTarget.copy(g.position);
    _camTarget.y += ship.type.freeboard + 3.2;
    cam.lookAt(_camTarget);

    // spyglass fov
    const targetFov = this._spyglass ? 20 : this._baseFov;
    if (Math.abs(cam.fov - targetFov) > 0.1) {
      cam.fov = lerp(cam.fov, targetFov, 1 - Math.exp(-dt * 9));
      cam.updateProjectionMatrix();
    }
  }
}
