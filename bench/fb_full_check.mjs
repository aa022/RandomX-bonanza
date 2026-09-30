// No-SAB full-replica gate (?fb_full=K): N randomx_st worker_threads build K
// replica datasets cooperatively (nosab_pool.mjs over public/fb_full.js, the
// browser's coordinator and worker code), then every replica must hash in full
// mode (JIT'd) to the RandomX reference vectors and to the same hashes as a
// light worker on the portable interpreter. Then a new seed (epoch): the build
// repeats into the replicas' existing datasets and is checked again.
// Needs ~2.3 GB per replica plus ~300 MB per worker.
//
// Usage: node bench/fb_full_check.mjs [--workers 3] [--full 2] [--profile arm|x86|auto] [--feature-base 3]
import { randomBytes } from 'crypto';
import { parseProfileArgs } from './profile_args.mjs';
import { startNoSabPool } from './nosab_pool.mjs';

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const WORKERS = Number(arg('--workers', '3'));
const FULL = Number(arg('--full', '2'));
const FEATURE_BASE = Number(arg('--feature-base', '3'));
const PROF = parseProfileArgs(args);
if (!(FULL >= 1 && FULL < WORKERS)) { console.error('need 1 <= --full < --workers (one light reference worker)'); process.exit(2); }

// RandomX reference vectors (tests/tests.cpp)
const LOREM = 'sed do eiusmod tempor incididunt ut labore et dolore magna aliqua';
const EPOCHS = [
  { key: 'test key 000', vectors: [
    ['This is a test', '639183aae1bf4c9a35884cb46b09cad9175f04efd7684e7262a0ac1c2f0b4e3f'],
    ['Lorem ipsum dolor sit amet', '300a0adb47603dedb42228ccb2b211104f4da45af709cd7547cd049e9489c969'],
    [LOREM, 'c36d4ed4191e617309867ed66a443be4075014e2b061bcdaf9ce7b721d2b77a8'],
  ] },
  { key: 'test key 001', vectors: [
    [LOREM, 'e9ff4503201c0c2cca26d285c93ae883f9b1d30c9eb240b820756f2d5a7905fc'],
  ] },
];
const fail = (m) => { console.error(`FAIL fb_full: ${m}`); process.exit(1); };

const pool = await startNoSabPool({ workers: WORKERS, full: FULL, key: EPOCHS[0].key, featureBase: FEATURE_BASE, prof: PROF });
const light = WORKERS - 1;
for (const [e, { key, vectors }] of EPOCHS.entries()) {
  const ms = e === 0 ? pool.buildMs : await pool.rekey(key);
  for (let r = 0; r < FULL; r++) if (pool.modes[r] !== 'full') fail(`epoch ${e}: replica ${r} is in ${pool.modes[r]} mode`);
  const inputs = [...vectors.map(([s]) => Buffer.from(s)), randomBytes(76), randomBytes(76), randomBytes(43)];
  const ref = (await pool.request(light, { type: 'hashes', inputs, jit: false }, 'hashes')).hashes;
  vectors.forEach(([s, want], k) => { if (ref[k] !== want) fail(`epoch ${e}: light interpreter '${s}' = ${ref[k]}, want ${want}`); });
  for (let r = 0; r < FULL; r++) {
    const got = await pool.request(r, { type: 'hashes', inputs, jit: true }, 'hashes');
    if (!got.full) fail(`epoch ${e}: replica ${r} did not hash in full mode`);
    if (!got.jitRuns) fail(`epoch ${e}: replica ${r} ran no JIT'd full-mode programs`);
    got.hashes.forEach((h, k) => { if (h !== ref[k]) fail(`epoch ${e}: replica ${r} input ${k}: ${h} != ${ref[k]}`); });
  }
  console.log(`OK fb_full epoch ${e} ('${key}'): ${FULL} replica(s) built by ${WORKERS} workers in ${(ms / 1000).toFixed(1)} s, ` +
    `${inputs.length} full-mode JIT hashes each match the interpreter (${vectors.length} reference vectors)`);
}
pool.terminate();
process.exit(0);
