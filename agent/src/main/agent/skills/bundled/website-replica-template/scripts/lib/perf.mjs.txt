/**
 * Shared throughput helpers for the browser-driven verification stages
 * (`viewport-check.mjs`, `compare-live.mjs`).
 *
 * Both of those scripts used to be almost entirely serial, and roughly half of
 * their wall clock was a `setTimeout` doing nothing: settle after load, settle
 * after each scroll, one page at a time, one viewport at a time. That is the
 * cheapest kind of time to win back, because sleeping in parallel costs no CPU
 * and changes nothing about what gets measured.
 *
 * Three primitives live here:
 *
 *   runLanes()      bounded-concurrency worker pool over a task list
 *   waitForSettle() adaptive "is the page done painting yet" wait
 *   createPipeline() keep encode/write work off the critical path
 *
 * Why lanes are CAPPED rather than "one per viewport"
 * --------------------------------------------------
 * Every settle in these scripts is measured in WALL CLOCK: "wait 1200ms, then
 * look". That is only a valid proxy for "the animation has finished" while the
 * renderer is keeping up. Oversubscribe the CPU and a page gets fewer frames
 * per millisecond, so a perfectly working reveal can still be mid-fade when the
 * sampler looks — a false positive in the hidden-content gate, and extra noise
 * in the pixel diff. So the default is deliberately conservative (see
 * resolveLanes), `--lanes=1` always restores the old fully-serial behaviour for
 * a tie-breaking re-run, and both scripts record the lane count in their JSON
 * report so a suspicious number can be explained later.
 */
import os from 'node:os';

/**
 * How many tasks to run at once.
 *
 * Defaults to half the machine's cores (leaving one for the Node process and
 * the dev server) and never more than `max`, because each lane in
 * compare-live.mjs drives THREE pages: local, live, and its own diff worker.
 *
 * @param {object} o
 * @param {string|number|undefined} o.requested  explicit --lanes value, if any
 * @param {number} o.taskCount                   never exceed the work available
 * @param {number} [o.cpuCount]
 * @param {number} [o.max]
 * @returns {number} lane count, always >= 1
 */
export function resolveLanes({ requested, taskCount, cpuCount, max = 4 }) {
  const tasks = Math.max(0, Math.floor(taskCount ?? 0));
  if (tasks <= 1) return 1;

  if (requested != null && requested !== '') {
    const n = Math.floor(Number(requested));
    // An explicit request wins, including the deliberate `--lanes=1`. Only a
    // nonsense value falls through to the automatic choice.
    if (Number.isFinite(n) && n >= 1) return Math.min(n, tasks);
  }

  const cores = Math.max(1, Math.floor(cpuCount ?? os.cpus().length));
  const byCpu = Math.max(1, Math.floor((cores - 1) / 2));
  return Math.max(1, Math.min(max, byCpu, tasks));
}

/**
 * Run `worker` over `items` with at most `lanes` in flight, preserving input
 * order in the returned array.
 *
 * `worker` is expected to handle its own expected failures (both callers turn a
 * per-viewport error into a record in the report rather than aborting the run).
 * If one does throw anyway, every other lane is still allowed to finish before
 * the error is rethrown — an abandoned lane would leak a browser context and,
 * worse, leave a half-written report behind.
 *
 * @template T, R
 * @param {T[]} items
 * @param {(item: T, index: number, lane: number) => Promise<R>} worker
 * @param {number} lanes
 * @returns {Promise<R[]>}
 */
export async function runLanes(items, worker, lanes) {
  const results = new Array(items.length);
  const laneCount = Math.max(1, Math.min(Math.floor(lanes), items.length || 1));
  let cursor = 0;

  const runner = async (lane) => {
    for (;;) {
      // Single-threaded JS: this claim-and-increment needs no lock.
      const index = cursor;
      cursor += 1;
      if (index >= items.length) return;
      results[index] = await worker(items[index], index, lane);
    }
  };

  const settled = await Promise.allSettled(
    Array.from({ length: laneCount }, (_unused, lane) => runner(lane)),
  );
  const failed = settled.find((s) => s.status === 'rejected');
  if (failed) throw failed.reason;
  return results;
}

/**
 * Wait until the page looks visually finished, or `capMs`, whichever comes
 * first. Returns how long it actually waited, in ms.
 *
 * This replaces a flat `waitForTimeout(3500)`. The flat wait was chosen for the
 * slowest plausible page and then paid on every page, twice per viewport. The
 * adaptive version asks the page directly:
 *
 *   - `document.fonts.ready` resolved (webfont swap is the classic late repaint
 *     and a guaranteed source of diff noise if sampled early),
 *   - no `<img>` still loading,
 *   - document height unchanged across consecutive samples.
 *
 * `capMs` is the OLD flat value, so nothing ever waits longer than it used to;
 * `minMs` is a floor, because plenty of sites kick off a hero animation a beat
 * after load and "nothing has changed yet" is indistinguishable from "nothing
 * has started yet".
 *
 * THE FALSE-SETTLE TRAP (found by benchmarking this against a live site, do not
 * remove the guard): an un-hydrated page shell satisfies all three signals
 * trivially. It has no <img> yet, `document.fonts.ready` resolves against the
 * fonts it hasn't requested, and its height sits at exactly the viewport height
 * and stays there. On the first run of this helper, dropbox.com at the ipad-mini
 * viewport "settled" in 666ms at a height of 1024px against a local replica of
 * 10926px — a 966% height delta, one comparable slice instead of eleven, and a
 * sweep that diffed a blank page and reported it as a finding.
 *
 * So early exit additionally requires the page to look SUBSTANTIAL: readyState
 * complete and a document meaningfully taller than the viewport. A genuinely
 * short page never qualifies and simply waits out `capMs`, which is exactly the
 * behaviour it had before this helper existed — the slow path is the OLD path,
 * so the worst case of this heuristic is "no speedup", never "wrong pixels".
 * That asymmetry is the whole design: the parallelism in these scripts is where
 * the wall-clock win actually comes from, and it costs nothing in fidelity.
 *
 * Note the rAF race: a throttled or never-firing `requestAnimationFrame` (a
 * backgrounded renderer) must not be able to stall the wait, so each frame wait
 * is raced against a short timeout.
 */
export async function waitForSettle(page, capMs, opts = {}) {
  const cap = Math.max(0, Math.floor(capMs ?? 0));
  if (cap === 0) return 0;
  const minMs = Math.min(Math.max(0, Math.floor(opts.minMs ?? 900)), cap);
  const quietSamples = Math.max(1, Math.floor(opts.quietSamples ?? 2));
  const sampleMs = Math.max(30, Math.floor(opts.sampleMs ?? 120));

  return page.evaluate(
    async ({ cap: capIn, minMs: floor, quietSamples: needQuiet, sampleMs: step }) => {
      const t0 = performance.now();
      const elapsed = () => performance.now() - t0;
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const frame = () =>
        new Promise((resolve) => {
          let settled = false;
          const done = () => {
            if (settled) return;
            settled = true;
            resolve();
          };
          requestAnimationFrame(done);
          setTimeout(done, 100);
        });

      try {
        await Promise.race([document.fonts.ready, sleep(capIn)]);
      } catch {
        // No document.fonts in this context: fall through to the height probe.
      }

      // Evidence that there is a real, laid-out page here at all — without
      // this, a page shell reads as "finished". See the FALSE-SETTLE TRAP note.
      const substantial = () =>
        document.readyState === 'complete' &&
        document.documentElement.scrollHeight > window.innerHeight * 1.2;

      let quiet = 0;
      let lastHeight = -1;
      while (elapsed() < capIn) {
        await frame();
        await sleep(step);
        const height = document.documentElement.scrollHeight;
        const imagesPending = Array.from(document.images).filter((i) => !i.complete).length;
        quiet = height === lastHeight && imagesPending === 0 ? quiet + 1 : 0;
        lastHeight = height;
        if (quiet >= needQuiet && elapsed() >= floor && substantial()) break;
      }
      return Math.round(elapsed());
    },
    { cap, minMs, quietSamples, sampleMs },
  );
}

/**
 * A tiny bounded queue for work that nothing downstream is waiting on.
 *
 * In compare-live.mjs the per-slice composite (diff maths + image encode +
 * disk write) does not feed the next slice, so awaiting it puts it squarely on
 * the critical path for no reason. Pushed through here instead, it overlaps
 * with the next slice's scroll-and-settle and effectively becomes free.
 *
 * Bounded (rather than unbounded fire-and-forget) because each queued item
 * holds two full-viewport screenshots in memory.
 */
export function createPipeline(maxInFlight = 2) {
  const limit = Math.max(1, Math.floor(maxInFlight));
  const pending = new Set();
  const all = [];

  return {
    /** Queue `taskFn`, waiting first if the queue is already full. */
    async push(taskFn) {
      while (pending.size >= limit) await Promise.race(pending);
      const task = Promise.resolve().then(taskFn);
      all.push(task);
      // Track a never-rejecting twin: Promise.race above must not see a
      // rejection (it would surface as an unhandled one), and the real error
      // still reaches the caller through drain().
      const tracked = task.then(
        () => undefined,
        () => undefined,
      );
      pending.add(tracked);
      tracked.then(() => pending.delete(tracked));
      return task;
    },

    /** Resolve once everything queued has finished, in push order. */
    async drain() {
      return Promise.all(all);
    },
  };
}

/**
 * A counting semaphore, used to throttle work against the LIVE origin
 * independently of the lane count.
 *
 * FOUND BY BENCHMARKING, DO NOT REMOVE. With 4 lanes each cold-loading
 * dropbox.com at once, one of the seven live loads reliably failed to lay out:
 * the live page reported a document height of 1024px — exactly the viewport —
 * after using its FULL 3500ms settle, against a local replica of 10926px. The
 * sweep then compared one slice instead of eleven and reported a 966% height
 * delta as though the replica were broken. The same viewport loads correctly at
 * `--lanes=1`, correctly under the pre-lane version of these scripts, and
 * correctly in a two-viewport run, so the cause is concurrent cold loads of a
 * heavy third-party page — not the settle heuristic (which had spent its whole
 * cap) and not the replica.
 *
 * Only the initial navigation is gated. Once a page is loaded it just scrolls
 * and screenshots, which is local and cheap, so lanes keep full parallelism
 * over the part of the run that actually dominates the wall clock.
 */
export function createGate(max) {
  const limit = Math.max(1, Math.floor(max));
  let active = 0;
  const waiting = [];

  return {
    async run(fn) {
      // A released slot is handed to exactly one waiter, which is why the
      // woken waiter does not need to re-check the limit.
      if (active >= limit) await new Promise((resolve) => waiting.push(resolve));
      active += 1;
      try {
        return await fn();
      } finally {
        active -= 1;
        const next = waiting.shift();
        if (next) next();
      }
    },
  };
}
