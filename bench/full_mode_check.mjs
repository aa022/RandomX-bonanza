// Full-mode correctness gate: hashes N inputs with the production WASM JIT
// path (full dataset), then again with the JIT disabled (portable C
// interpreter + softround), and requires bit-identical results.
//
// Usage:
//   node bench/full_mode_check.mjs                       # threaded interp (webui defaults)
//   node bench/full_mode_check.mjs --no-threaded         # per-program JIT
//   node bench/full_mode_check.mjs --no-threaded --feature-extra 16   # PJIT2
//   node bench/full_mode_check.mjs --regs locals --count 64
//   node bench/full_mode_check.mjs --profile x86 --fuse-n 2704   # generator profile / knobs (bench/profile_args.mjs)

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseProfileArgs, applyProfile, profileHeader, staticDispatchesPerOp } from './profile_args.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const createRandomX = require(join(__dirname, '..', 'public', process.env.RX_BUILD === 'st' ? 'randomx_st.js' : 'randomx.js'));

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const flag = (n) => args.includes(n);

const COUNT = Number(arg('--count', '48'));
const INIT_THREADS = Number(arg('--init-threads', '10'));
const KEY = arg('--key', 'gh-distro bench key');
const NO_THREADED = flag('--no-threaded');
const REGS_MODE = arg('--regs', 'mem');
const FEATURE_EXTRA = Number(arg('--feature-extra', '0'));
const PROF = parseProfileArgs(args);
const FULL_MEM = 4;

const Module = await createRandomX();

let maxPages = 65536;
try { const d = Module.wasmMemory.type(); if (d && d.maximum) maxPages = d.maximum; } catch (_) {}
Module._rxjit_set_max_memory_pages(maxPages);
let feature = Number(arg('--feature-base', '3')) | FEATURE_EXTRA;
if (!NO_THREADED) {
  Module._rxjit_set_use_threaded_interp(1);
  feature |= 4;
  const inMem = REGS_MODE !== 'locals' ? 1 : 0;
  Module._rxjit_set_regs_in_memory(inMem);
  Module._rxjit_set_split_inner_dispatch(inMem);
}
Module._rxjit_set_feature(feature);
applyProfile(Module, PROF);
Module._rxjit_set_supjit_enabled(1);
Module._rxSetJitEnabled(1);

const c = (n, r, a) => Module.cwrap(n, r, a);
const alloc_cache = c('randomx_alloc_cache', 'number', ['number']);
const init_cache = c('randomx_init_cache', null, ['number', 'number', 'number']);
const alloc_dataset = c('randomx_alloc_dataset', 'number', ['number']);
const item_count = c('randomx_dataset_item_count', 'number', []);
const ds_start = c('rxInitDatasetStart', 'number', ['number', 'number', 'number', 'number', 'number']);
const ds_progress = c('rxInitDatasetProgress', 'number', []);
const ds_join = c('rxInitDatasetJoin', 'number', []);
const create_vm = c('randomx_create_vm', 'number', ['number', 'number', 'number']);
const calc_hash = c('randomx_calculate_hash', null, ['number', 'number', 'number', 'number']);
const destroy_vm = c('randomx_destroy_vm', null, ['number']);

const keyBytes = Buffer.from(KEY);
const keyPtr = Module._malloc(keyBytes.length);
Module.HEAPU8.set(keyBytes, keyPtr);
const cache = alloc_cache(FULL_MEM);
init_cache(cache, keyPtr, keyBytes.length);
const dataset = alloc_dataset(FULL_MEM);
const items = item_count();
if (!ds_start(cache, dataset, 0, items, INIT_THREADS)) throw new Error('rxInitDatasetStart failed');
while ((ds_progress() >>> 0) < items) await new Promise((r) => setTimeout(r, 100));
ds_join();

const vm = create_vm(FULL_MEM, cache, dataset);
if (!vm) throw new Error('create_vm failed');

const inPtr = Module._malloc(256);
const outPtr = Module._malloc(32);
const inputs = [];
let seed = 0x12345678;
for (let i = 0; i < COUNT; i++) {
  const len = 43 + (i * 7) % 90;
  const b = new Uint8Array(len);
  for (let j = 0; j < len; j++) { seed = (seed * 1103515245 + 12345) >>> 0; b[j] = seed >>> 24; }
  inputs.push(b);
}
const hashAll = () => inputs.map((b) => {
  Module.HEAPU8.set(b, inPtr);
  calc_hash(vm, inPtr, b.length, outPtr);
  return Buffer.from(Module.HEAPU8.slice(outPtr, outPtr + 32)).toString('hex');
});

const runsBefore = Module._rxjit_stat_runs() >>> 0;
const jit = hashAll();
const jitRuns = (Module._rxjit_stat_runs() >>> 0) - runsBefore;
Module._rxSetJitEnabled(0);
const ref = hashAll();
destroy_vm(vm);

let bad = 0;
for (let i = 0; i < COUNT; i++) {
  if (jit[i] !== ref[i]) {
    if (bad < 5) console.error(`MISMATCH #${i}\n  jit ${jit[i]}\n  ref ${ref[i]}`);
    bad++;
  }
}
const mode = NO_THREADED ? `per-program (feature=${feature})`
  : `threaded regs=${REGS_MODE} (feature=${feature} ${profileHeader(Module, PROF)} dispatches/op=${staticDispatchesPerOp(Module).toFixed(3)})`;
if (jitRuns < COUNT * 8) {
  console.error(`FAIL ${mode}: JIT ran only ${jitRuns}/${COUNT * 8} programs (fell back to C)`);
  process.exit(1);
}
if (bad) { console.error(`FAIL ${mode}: ${bad}/${COUNT} hashes differ`); process.exit(1); }
console.log(`OK ${mode}: ${COUNT} full-mode hashes match the portable interpreter (${jitRuns} JIT programs)`);
process.exit(0);
