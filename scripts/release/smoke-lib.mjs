// Lifecycle helpers for the release smokes (scripts/release/preview-smoke.mjs): every wait is bounded, and the
// process group is signalled whatever the browser does on close.

/**
 * Resolves with `p`, or with `fallback` once `ms` pass; a rejection of `p` also resolves with `fallback`.
 * @param {unknown} p @param {number} ms @param {unknown} [fallback] @returns {Promise<any>}
 */
export function bounded(p, ms, fallback = null) {
  let t;
  return Promise.race([Promise.resolve(p).catch(() => fallback), new Promise((r) => (t = setTimeout(() => r(fallback), ms)))]).finally(() => clearTimeout(t));
}

/**
 * Stops what a smoke started, in an order that cannot skip the kill: close the browser (bounded; a rejection or a
 * synchronous throw is ignored), SIGINT the process group, wait (bounded) for the wrapper to exit, then — because the
 * wrapper (npm) can exit while a child still listens — ask `portsClosed`; SIGKILL the group when the wrapper did not
 * exit or a port is still held. Returns true only when SIGINT alone stopped everything within `graceMs`.
 */
export async function stopAll({ closeBrowser, signal, exited, portsClosed = async () => true, closeMs = 10_000, graceMs = 15_000 }) {
  try {
    if (closeBrowser) await bounded(Promise.resolve().then(closeBrowser), closeMs);
  } finally {
    signal('SIGINT');
  }
  const stopped = (await bounded(exited, graceMs)) !== null;
  const closed = stopped && (await bounded(Promise.resolve().then(portsClosed), graceMs, false)) === true;
  if (!closed) signal('SIGKILL');
  return closed;
}

/**
 * Cleanup for a signal sent to the smoke itself. Its children run detached (their own process groups), so the
 * terminal's Ctrl-C reaches only the smoke. A group stays registered until the smoke has confirmed it is gone
 * (`finish(pgid, true)`), not merely until its npm wrapper exits — a wrapper can exit while its child still listens,
 * and a phase whose cleanup could not free its port keeps its group (`finish(pgid, false)`). On the first
 * interrupt: SIGINT every registered group, wait (bounded) for the ports to free, SIGKILL every registered group
 * (harmless for one already gone), report the ports still held, exit. Later signals during that run are absorbed.
 */
export function createInterrupt({ signalGroup, portsHeld, wait, exit, report, graceMs = 5_000, stepMs = 200 }) {
  const groups = new Set();
  let running = null;
  return {
    started: (pgid) => void groups.add(pgid),
    /** Unregisters `pgid` only when `closed` is true; returns `closed`. */
    finish(pgid, closed) {
      if (closed) groups.delete(pgid);
      return closed;
    },
    /** The interrupt cleanup when one has started (it ends by calling `exit`), else null: await it before exiting. */
    get pending() {
      return running;
    },
    interrupt() {
      running ??= (async () => {
        for (const g of groups) signalGroup(g, 'SIGINT');
        for (let t = 0; t < graceMs && (await portsHeld()).length; t += stepMs) await wait(stepMs);
        for (const g of groups) signalGroup(g, 'SIGKILL');
        await wait(stepMs);
        report(await portsHeld());
        exit(130);
      })();
      return running;
    },
  };
}

/**
 * Settles process groups after a smoke case: a group counts as gone only when `alive(pgid)` says so (a signal-0
 * probe of the group, not a command-line match — a wrapper started with a relative path never matches an absolute
 * folder). Each still-alive group is SIGKILLed via `kill(pgid)`, then polled (bounded) until it is gone.
 * Returns the groups still alive afterwards; the caller keeps those registered.
 * @param {{ groups: number[], alive: (pgid: number) => boolean, kill: (pgid: number) => void, wait: (ms: number) => Promise<unknown>, graceMs?: number, stepMs?: number }} o
 * @returns {Promise<number[]>}
 */
export async function reapGroups({ groups, alive, kill, wait, graceMs = 5_000, stepMs = 100 }) {
  for (const g of groups) if (alive(g)) kill(g);
  let left = groups.filter(alive);
  for (let t = 0; left.length && t < graceMs; t += stepMs) {
    await wait(stepMs);
    left = left.filter(alive);
  }
  return left;
}
