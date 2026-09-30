// Light-mode correctness gate: hashes N inputs in light mode (cache only, no
// dataset) with the threaded interpreter + the embedded superscalar item
// function (rxjit_run_program_light), then again with the JIT disabled
// (portable interpreter + initDatasetItem), and requires bit-identical results.
// Also re-keys the cache once to check the item function follows the cache,
// then flips light_mlp (0 <-> 2) on the second key: the item function and the
// module must follow the mode too.
//
// Usage:
//   node bench/light_mode_check.mjs [--count 16] [--profile arm|x86|auto] [--feature-base 3]
//        [--light-mlp 0|1|2]   step 7: probe (1) or item pairing (2); the second key
//                              also exercises the light fn's regen key with the mode
//   RX_BUILD=st node bench/light_mode_check.mjs      # single-thread no-SAB build

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseProfileArgs, applyProfile, profileHeader } from './profile_args.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const createRandomX = require(join(__dirname, '..', 'public', process.env.RX_BUILD === 'st' ? 'randomx_st.js' : 'randomx.js'));

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const COUNT = Number(arg('--count', '16'));
const FEATURE_EXTRA = Number(arg('--feature-extra', '0'));
const PROF = parseProfileArgs(args);
const KEYS = ['gh-distro bench key', 'light mode second key'];

const Module = await createRandomX();
let maxPages = 65536;
try { const d = Module.wasmMemory.type(); if (d && d.maximum) maxPages = d.maximum; } catch (_) {}
Module._rxjit_set_max_memory_pages(maxPages);
const feature = (Number(arg('--feature-base', '3')) | FEATURE_EXTRA) | 4;
Module._rxjit_set_use_threaded_interp(1);
Module._rxjit_set_regs_in_memory(1);
Module._rxjit_set_split_inner_dispatch(1);
Module._rxjit_set_feature(feature);
applyProfile(Module, PROF);

const c = (n, r, a) => Module.cwrap(n, r, a);
const alloc_cache = c('randomx_alloc_cache', 'number', ['number']);
const init_cache = c('randomx_init_cache', null, ['number', 'number', 'number']);
const create_vm = c('randomx_create_vm', 'number', ['number', 'number', 'number']);
const set_cache = c('randomx_vm_set_cache', null, ['number', 'number']);
const calc_hash = c('randomx_calculate_hash', null, ['number', 'number', 'number', 'number']);
const destroy_vm = c('randomx_destroy_vm', null, ['number']);

const cache = alloc_cache(0);
const keyPtr = Module._malloc(256);
const setKey = (k) => { const b = Buffer.from(k); Module.HEAPU8.set(b, keyPtr); init_cache(cache, keyPtr, b.length); };
setKey(KEYS[0]);
const vm = create_vm(0, cache, 0);
if (!vm) throw new Error('create_vm failed');

const inPtr = Module._malloc(256);
const outPtr = Module._malloc(32);
const inputs = [];
let seed = 0x9e3779b9;
for (let i = 0; i < COUNT; i++) {
  const len = 43 + (i * 7) % 90;
  const b = new Uint8Array(len);
  for (let j = 0; j < len; j++) { seed = (seed * 1103515245 + 12345) >>> 0; b[j] = seed >>> 24; }
  inputs.push(b);
}
const hashAll = (list) => list.map((b) => {
  Module.HEAPU8.set(b, inPtr);
  calc_hash(vm, inPtr, b.length, outPtr);
  return Buffer.from(Module.HEAPU8.slice(outPtr, outPtr + 32)).toString('hex');
});

let bad = 0, jitRuns = 0, total = 0;
let msJit = 0, msRef = 0;
for (const [ki, key] of KEYS.entries()) {
  if (ki > 0) { setKey(key); set_cache(vm, cache); }
  const list = ki === 0 ? inputs : inputs.slice(0, Math.max(2, COUNT >> 2));
  Module._rxSetJitEnabled(1);
  const r0 = Module._rxjit_stat_light_runs() >>> 0;
  let t = performance.now();
  const jit = hashAll(list);
  msJit += performance.now() - t;
  jitRuns += (Module._rxjit_stat_light_runs() >>> 0) - r0;
  Module._rxSetJitEnabled(0);
  t = performance.now();
  const ref = hashAll(list);
  msRef += performance.now() - t;
  total += list.length;
  for (let i = 0; i < list.length; i++) {
    if (jit[i] !== ref[i]) {
      if (bad < 5) console.error(`MISMATCH key#${ki} #${i}\n  jit ${jit[i]}\n  ref ${ref[i]}`);
      bad++;
    }
  }
  if (ki === KEYS.length - 1) { // light_mlp flip on the same cache, then back
    const mlp = Module._rxjit_effective_light_mlp();
    Module._rxjit_set_light_mlp(mlp ? 0 : 2);
    Module._rxSetJitEnabled(1);
    const r1 = Module._rxjit_stat_light_runs() >>> 0;
    const flip = hashAll(list.slice(0, 2));
    jitRuns += (Module._rxjit_stat_light_runs() >>> 0) - r1;
    total += 2;
    Module._rxjit_set_light_mlp(PROF.lightMlp);
    for (let i = 0; i < 2; i++) {
      if (flip[i] !== ref[i]) {
        if (bad < 5) console.error(`MISMATCH key#${ki} light_mlp ${mlp ? 0 : 2} #${i}\n  jit ${flip[i]}\n  ref ${ref[i]}`);
        bad++;
      }
    }
  }
}
destroy_vm(vm);

const mode = `light threaded (feature=${feature} ${profileHeader(Module, PROF)})`;
if (jitRuns < total * 8) {
  console.error(`FAIL ${mode}: light JIT ran only ${jitRuns}/${total * 8} programs (fell back to C)`);
  process.exit(1);
}
if (bad) { console.error(`FAIL ${mode}: ${bad}/${total} hashes differ`); process.exit(1); }
console.log(`OK ${mode}: ${total} light-mode hashes match the portable interpreter over ${KEYS.length} keys + a light_mlp flip (${jitRuns} JIT programs; ~${(msJit / total).toFixed(1)} ms/hash JIT vs ${(msRef / total).toFixed(1)} interp, incl. warm-up)`);
process.exit(0);
