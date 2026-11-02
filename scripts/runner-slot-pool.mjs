// A fixed-size pool of execution slots. `acquireLock(index)` claims the on-disk lock for a slot and
// resolves with its release function, or undefined when another process holds it.
export function createSlotPool({ size, acquireLock }) {
  const held = new Array(size).fill(false);
  const listeners = new Set();
  let exclusive = false;
  const notify = () => listeners.forEach((listener) => listener());

  const claim = async (index, takesAll) => {
    held[index] = true;
    if (takesAll) exclusive = true;
    const fail = () => {
      held[index] = false;
      if (takesAll) exclusive = false;
    };
    let release;
    try {
      release = await acquireLock(index);
    } catch (error) {
      fail();
      throw error;
    }
    if (!release) {
      fail();
      return undefined;
    }
    notify();
    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await release();
      } finally {
        fail();
        notify();
      }
    };
  };

  return {
    size,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // An exclusive hold needs an idle pool and blocks every other acquisition until released.
    async tryAcquire({ exclusive: wantsExclusive = false } = {}) {
      if (exclusive) return undefined;
      if (wantsExclusive && held.some(Boolean)) return undefined;
      // The exclusive hold uses slot 0, the lock that standalone `actions run` also honors.
      for (let index = 0; index < (wantsExclusive ? 1 : size); index++) {
        if (exclusive) return undefined;
        if (held[index]) continue;
        const release = await claim(index, wantsExclusive);
        if (release) return release;
      }
      return undefined;
    },
    busy() {
      return exclusive ? size : held.filter(Boolean).length;
    },
  };
}
