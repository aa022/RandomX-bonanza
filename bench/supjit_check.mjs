// Supjit gate: dataset items from the SuperscalarHash wasm kernel (rxInitDatasetStart
// with supjit on) must equal the portable initDatasetItem byte for byte. The
// full_mode_check / mine_ctx_check gates can't catch a broken kernel: both of
// their sides read the same (kernel-built) dataset. Also prints the 1T item cost.
// Then rxInitItemsInto (the no-SAB replica chunks: items into a malloc'd buffer)
// must equal randomx_init_dataset on random ranges, kernel and fallback path.
//
// --kernel-k K: K items per kernel loop trip (rxjit_set_kernel_k; default the
// C default, 1); the ranges include counts that are not a multiple of K.
//
// Usage: node bench/supjit_check.mjs [--items 262144] [--start N] [--kernel-k K]
//        RX_BUILD=st node bench/supjit_check.mjs      # single-thread no-SAB build
import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const createRandomX = require(join(__dirname, '..', 'public', process.env.RX_BUILD === 'st' ? 'randomx_st.js' : 'randomx.js'));
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const N = Number(arg('--items', String(1 << 18)));
const START = Number(arg('--start', '12345678'));
const KK = Number(arg('--kernel-k', '-1'));

const M = await createRandomX();
M._rxjit_set_kernel_k(KK);
const kk = M._rxjit_effective_kernel_k();
const c = (n, r, a) => M.cwrap(n, r, a);
const key = Buffer.from('gh-distro bench key'); const kp = M._malloc(key.length); M.HEAPU8.set(key, kp);
const cache = c('randomx_alloc_cache', 'number', ['number'])(4);
c('randomx_init_cache', null, ['number', 'number', 'number'])(cache, kp, key.length);
const ds = c('randomx_alloc_dataset', 'number', ['number'])(4);
if (!ds) throw new Error('alloc_dataset failed');
const mem = c('randomx_get_dataset_memory', 'number', ['number'])(ds) >>> 0;
const start = c('rxInitDatasetStart', 'number', ['number', 'number', 'number', 'number', 'number']);
const run = async (n) => { // 1 thread; the pthread build returns early and needs progress + join
  if (!start(cache, ds, START, n, 1)) throw new Error('rxInitDatasetStart failed');
  while ((M._rxInitDatasetProgress() >>> 0) < n) await new Promise((r) => setTimeout(r, 20));
  M._rxInitDatasetJoin();
};
const lo = mem + START * 64;
M._rxjit_set_supjit_enabled(1);
let t = performance.now();
await run(N);
const ms = performance.now() - t;
if (!M._rxjit_get_supjit_enabled()) { console.error('FAIL supjit: kernel disabled itself (fell back)'); process.exit(1); }
const jit = M.HEAPU8.slice(lo, lo + N * 64);
M._rxjit_set_supjit_enabled(0);
const NI = Math.min(N, 1 << 14);
await run(NI);
const ref = M.HEAPU8.slice(lo, lo + NI * 64);
let bad = 0; for (let i = 0; i < ref.length; i += 64) if (Buffer.compare(ref.subarray(i, i + 64), jit.subarray(i, i + 64))) bad++;
if (bad) { console.error(`FAIL supjit: ${bad}/${NI} items differ from initDatasetItem`); process.exit(1); }
console.log(`OK supjit: ${NI} items match initDatasetItem (kernel_k=${kk}: ${(ms * 1000 / N).toFixed(3)} us/item over ${N} items, 1T)`);

// rxInitItemsInto: random ranges (odd sizes, across the kernel's 16384-item
// sub-calls, the dataset's top end where addresses cross 2 GiB) into a malloc'd
// buffer vs randomx_init_dataset into the dataset.
const into = c('rxInitItemsInto', 'number', ['number', 'number', 'number', 'number']);
const refInit = c('randomx_init_dataset', null, ['number', 'number', 'number', 'number']);
const total = c('randomx_dataset_item_count', 'number', [])();
let seed = 0x9e3779b9;
const rnd = (n) => { seed = (Math.imul(seed ^ (seed >>> 15), 0x2c1b3c6d) + 0x6d2b79f5) >>> 0; return seed % n; };
const ranges = [[0, 1], [total - 3001, 3001], [5 * 65536, 20000], [777, 2], [4099, 5], [65531, 7]];
for (let k = 0; k < 6; k++) { const n = 1 + rnd(4000); ranges.push([rnd(total - n), n]); }
const checkRange = ([s, n], sup) => {
  M._rxjit_set_supjit_enabled(sup);
  const dst = M._malloc(n * 64);
  if (!dst || !into(cache, dst, s, n)) throw new Error('rxInitItemsInto failed');
  if (sup && !M._rxjit_get_supjit_enabled()) { console.error('FAIL itemsInto: kernel disabled itself (fell back)'); process.exit(1); }
  const got = M.HEAPU8.slice(dst, dst + n * 64);
  M._free(dst);
  refInit(ds, cache, s, n);
  const o = mem + s * 64;
  if (Buffer.compare(got, M.HEAPU8.subarray(o, o + n * 64))) {
    console.error(`FAIL itemsInto: items [${s}, ${s + n}) (supjit=${sup}) differ from randomx_init_dataset`); process.exit(1);
  }
  return n;
};
let nItems = 0;
for (const r of ranges) nItems += checkRange(r, 1);
nItems += checkRange([rnd(total - 777), 777], 0);
console.log(`OK itemsInto (kernel_k=${kk}): ${ranges.length + 1} ranges (${nItems} items, top end at 0x${(mem + total * 64 - 1 >>> 0).toString(16)}) match randomx_init_dataset`);
