// No-SAB scaling bench: the browser NoSabPool setup in Node (nosab_pool.mjs).
// N worker_threads, each loading randomx_st.js (non-shared memory, no
// pthreads; no SharedArrayBuffer anywhere), each with its own light cache and
// a light VM on the JIT'd path (threaded interpreter + embedded superscalar
// item fn, configured like light_mode_check), hashing a 76-byte blob over its
// own disjoint nonce slot (nonce = slot + k*N at offset 39, like worker.js).
// --full K: workers 0..K-1 are full-dataset replicas (?fb_full=K), built
// cooperatively by all workers first (public/fb_full.js; build time printed),
// then mining in full mode next to N-K light workers.
//
// All workers start on one wall-clock epoch: warm-up (TurboFan tier-up,
// excluded), then a measured window; each worker times its own hashes inside
// the window (no shared counters without SAB) and the main thread sums them.
//
// Usage:
//   node bench/nosab_bench.mjs [--workers N] [--secs 15] [--warmup 4]
//        [--profile arm|x86|auto] [--feature-base 3] [--key K]
//        [--full K]        K full-dataset replicas (0..2 in the browser; ~2.3 GB each)
//        [--light-mlp 0|1|2] [--kernel-k N]  light step-7 mode / supjit kernel items per trip
//                          (profile_args.mjs; the build time follows kernel_k)
//   default --workers = os.availableParallelism(); always runs randomx_st.

import os from 'os';
import { parseProfileArgs } from './profile_args.mjs';
import { startNoSabPool } from './nosab_pool.mjs';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const WORKERS = Math.max(1, Number(arg('--workers', String(os.availableParallelism()))));
const SECS = Number(arg('--secs', '15'));
const WARMUP = Number(arg('--warmup', '4'));
const FEATURE_BASE = Number(arg('--feature-base', '3'));
const KEY = arg('--key', 'gh-distro bench key');
const FULL = Math.min(WORKERS, Math.max(0, Number(arg('--full', '0'))));
const PROF = parseProfileArgs(args);

const mode = FULL ? `${FULL} full + ${WORKERS - FULL} light` : 'light mode';
console.log(`nosab bench: randomx_st, ${WORKERS} worker_threads, ${mode}, warm-up ${WARMUP}s + ${SECS}s`);
const t0 = performance.now();
const pool = await startNoSabPool({
  workers: WORKERS, full: FULL, key: KEY, featureBase: FEATURE_BASE, prof: PROF,
});
const info = pool.info;
if (FULL) {
  const nFull = pool.modes.filter((m) => m === 'full').length;
  console.log(`caches + dataset build in ${((performance.now() - t0) / 1000).toFixed(1)} s ` +
    `(cooperative build ${(pool.buildMs / 1000).toFixed(1)} s over ${WORKERS} workers, ${nFull}/${FULL} replicas in full mode)`);
} else {
  console.log(`caches ready in ${((performance.now() - t0) / 1000).toFixed(1)} s (Argon2 per worker, concurrent)`);
}
console.log(`light threaded (feature=${FEATURE_BASE | 4} ${info[0].header})`);

const epoch = performance.timeOrigin + performance.now() + 200; // shared start, wall-clock ms
const res = await Promise.all(pool.workers.map((_, i) =>
  pool.request(i, { type: 'go', epoch, warmup: WARMUP, secs: SECS }, 'done')));
let total = 0, hashes = 0, fallback = 0;
for (const [i, r] of res.entries()) {
  const hs = r.hashes / r.secs;
  total += hs; hashes += r.hashes;
  if (r.jitRuns < r.allHashes * 8) fallback++;
  const role = FULL ? ` ${pool.modes[i].padEnd(5)}` : '';
  console.log(`  worker ${String(i).padStart(2)}${role}: ${hs.toFixed(2).padStart(7)} H/s  (${r.hashes} hashes / ${r.secs.toFixed(2)} s, ${(1000 / hs).toFixed(1)} ms/hash)`);
}
if (fallback) console.log(`WARNING: ${fallback} worker(s) fell back to the C interpreter for some programs`);
console.log(`total ${total.toFixed(1)} H/s over ${WORKERS} workers (${(total / WORKERS).toFixed(2)} H/s per worker, ${hashes} hashes)`);
pool.terminate();
process.exit(0);
