// Frozen shared EventBus. See docs/CONTRACTS.md.

export class EventBus {
  constructor() {
    this._map = new Map();
  }

  on(name, fn) {
    let set = this._map.get(name);
    if (!set) this._map.set(name, (set = new Set()));
    set.add(fn);
    return () => this.off(name, fn);
  }

  once(name, fn) {
    const wrap = (payload) => {
      this.off(name, wrap);
      fn(payload);
    };
    return this.on(name, wrap);
  }

  off(name, fn) {
    this._map.get(name)?.delete(fn);
  }

  emit(name, payload) {
    const set = this._map.get(name);
    if (!set) return;
    for (const fn of [...set]) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[events] handler for "${name}" threw:`, err);
      }
    }
  }
}
