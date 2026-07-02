// Frozen shared input system. See docs/CONTRACTS.md.
// Key codes are KeyboardEvent.code strings ('KeyW', 'Space', 'ShiftLeft', ...).

export class Input {
  constructor(target = window) {
    this._down = new Set();
    this._pressed = new Set();
    this._released = new Set();
    this.mouse = {
      dx: 0, dy: 0,
      x: 0, y: 0,
      wheel: 0,
      buttons: new Set(),
      _pressed: new Set(),
      _released: new Set(),
      pressed: (b) => this.mouse.buttons.has(b),
      wasPressed: (b) => this.mouse._pressed.has(b),
      wasReleased: (b) => this.mouse._released.has(b),
    };
    this.pointerLocked = false;
    this.enabled = true;
    this._target = target;
    this._bind();
  }

  _bind() {
    const t = this._target;
    t.addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this._down.add(e.code);
      this._pressed.add(e.code);
      // keep browser shortcuts out of the game
      if (['Space', 'Tab', 'KeyQ'].includes(e.code)) e.preventDefault();
    });
    t.addEventListener('keyup', (e) => {
      this._down.delete(e.code);
      this._released.add(e.code);
    });
    t.addEventListener('blur', () => {
      this._down.clear();
      this.mouse.buttons.clear();
    });
    t.addEventListener('mousemove', (e) => {
      this.mouse.x = e.clientX;
      this.mouse.y = e.clientY;
      if (this.pointerLocked) {
        this.mouse.dx += e.movementX;
        this.mouse.dy += e.movementY;
      }
    });
    t.addEventListener('mousedown', (e) => {
      this.mouse.buttons.add(e.button);
      this.mouse._pressed.add(e.button);
    });
    t.addEventListener('mouseup', (e) => {
      this.mouse.buttons.delete(e.button);
      this.mouse._released.add(e.button);
    });
    t.addEventListener('wheel', (e) => {
      this.mouse.wheel += Math.sign(e.deltaY);
    }, { passive: true });
    t.addEventListener('contextmenu', (e) => e.preventDefault());
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement != null;
    });
  }

  requestPointerLock(el) {
    if (!this.pointerLocked) el.requestPointerLock?.({ unadjustedMovement: true });
  }

  exitPointerLock() {
    if (this.pointerLocked) document.exitPointerLock?.();
  }

  isDown(code) { return this.enabled && this._down.has(code); }
  wasPressed(code) { return this.enabled && this._pressed.has(code); }
  wasReleased(code) { return this.enabled && this._released.has(code); }

  /** Any of WASD/arrows as a {x, z} axis pair in [-1, 1]. */
  moveAxis() {
    const x = (this.isDown('KeyD') || this.isDown('ArrowRight') ? 1 : 0) -
      (this.isDown('KeyA') || this.isDown('ArrowLeft') ? 1 : 0);
    const z = (this.isDown('KeyS') || this.isDown('ArrowDown') ? 1 : 0) -
      (this.isDown('KeyW') || this.isDown('ArrowUp') ? 1 : 0);
    return { x, z };
  }

  /** Called by the engine at the END of each frame. */
  endFrame() {
    this._pressed.clear();
    this._released.clear();
    this.mouse._pressed.clear();
    this.mouse._released.clear();
    this.mouse.dx = 0;
    this.mouse.dy = 0;
    this.mouse.wheel = 0;
  }
}
