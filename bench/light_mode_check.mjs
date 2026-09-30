// Light-mode correctness gate: hashes N inputs in light mode (cache only, no
// dataset) with the threaded interpreter + the embedded superscalar item
// function (rxjit_run_program_light), then again with the JIT disabled
// (portable interpreter + initDatasetItem), and requires bit-identical results.
// Also re-keys the cache once to check the item function follows the cache.
// --light-vms 2: the JIT side hashes pairs of inputs on two VMs in lockstep
// (rxLightHash2, main_loop2 + item2), alternating which VM is A, plus a single
// hash through the same module when the count is odd; both hashes of each pair
// must equal the portable interpreter, and the pairs must really run in
// lockstep (rxjit_stat_light_pair_runs).
//
// Usage:
//   node bench/light_mode_check.mjs [--count 16] [--profile arm|x86|auto] [--feature-base 3]
//                                   [--light-vms 1|2]
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
const LIGHT_VMS = Number(arg('--light-vms', '1'));
if (LIGHT_VMS !== 1 && LIGHT_VMS !== 2) { console.error('--light-vms wants 1|2'); process.exit(2); }
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
if (LIGHT_VMS === 2) {
  if (!Module._rxjit_set_light_vms) { console.error('FAIL: this build has no rxjit_set_light_vms'); process.exit(1); }
  Module._rxjit_set_light_vms(2);
}

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
const vm2 = LIGHT_VMS === 2 ? create_vm(0, cache, 0) : 0;
if (LIGHT_VMS === 2 && !vm2) throw new Error('create_vm failed');
const hash2 = LIGHT_VMS === 2 ? c('rxLightHash2', null, ['number', 'number', 'number', 'number', 'number', 'number', 'number', 'number']) : null;

const inPtr = Module._malloc(256);
const outPtr = Module._malloc(32);
const inPtr2 = Module._malloc(256);
const outPtr2 = Module._malloc(32);
const inputs = [];
let seed = 0x9e3779b9;
for (let i = 0; i < COUNT; i++) {
  const len = 43 + (i * 7) % 90;
  const b = new Uint8Array(len);
  for (let j = 0; j < len; j++) { seed = (seed * 1103515245 + 12345) >>> 0; b[j] = seed >>> 24; }
  inputs.push(b);
}
const hex = (p) => Buffer.from(Module.HEAPU8.slice(p, p + 32)).toString('hex');
const hashAll = (list) => list.map((b) => {
  Module.HEAPU8.set(b, inPtr);
  calc_hash(vm, inPtr, b.length, outPtr);
  return hex(outPtr);
});
// Pairs through rxLightHash2 (A = vm, then vm2, alternating), an odd last one
// through calc_hash on the light_vms 2 module.
const hashPairs = (list) => {
  const res = [];
  for (let i = 0; i < list.length; i += 2) {
    if (i + 1 === list.length) { res.push(...hashAll([list[i]])); break; }
    const [a, b] = [list[i], list[i + 1]];
    Module.HEAPU8.set(a, inPtr);
    Module.HEAPU8.set(b, inPtr2);
    const [va, vb] = (i >> 1) & 1 ? [vm2, vm] : [vm, vm2];
    hash2(va, inPtr, a.length, outPtr, vb, inPtr2, b.length, outPtr2);
    res.push(hex(outPtr), hex(outPtr2));
  }
  return res;
};

let bad = 0, jitRuns = 0, total = 0, pairRuns = 0, pairsWanted = 0;
let msJit = 0, msRef = 0;
for (const [ki, key] of KEYS.entries()) {
  if (ki > 0) { setKey(key); set_cache(vm, cache); if (vm2) set_cache(vm2, cache); }
  const list = ki === 0 ? inputs : inputs.slice(0, Math.max(2, COUNT >> 2));
  Module._rxSetJitEnabled(1);
  const r0 = Module._rxjit_stat_light_runs() >>> 0;
  const p0 = LIGHT_VMS === 2 ? Module._rxjit_stat_light_pair_runs() >>> 0 : 0;
  let t = performance.now();
  const jit = LIGHT_VMS === 2 ? hashPairs(list) : hashAll(list);
  msJit += performance.now() - t;
  jitRuns += (Module._rxjit_stat_light_runs() >>> 0) - r0;
  if (LIGHT_VMS === 2) {
    pairRuns += (Module._rxjit_stat_light_pair_runs() >>> 0) - p0;
    pairsWanted += (list.length >> 1) * 8;
  }
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
}
destroy_vm(vm);
if (vm2) destroy_vm(vm2);

const mode = `light threaded (feature=${feature} ${profileHeader(Module, PROF)} light_vms=${LIGHT_VMS})`;
if (jitRuns < total * 8) {
  console.error(`FAIL ${mode}: light JIT ran only ${jitRuns}/${total * 8} programs (fell back to C)`);
  process.exit(1);
}
if (pairRuns < pairsWanted) {
  console.error(`FAIL ${mode}: only ${pairRuns}/${pairsWanted} program pairs ran in lockstep`);
  process.exit(1);
}
if (bad) { console.error(`FAIL ${mode}: ${bad}/${total} hashes differ`); process.exit(1); }
console.log(`OK ${mode}: ${total} light-mode hashes match the portable interpreter over ${KEYS.length} keys (${jitRuns} JIT programs${LIGHT_VMS === 2 ? `, ${pairRuns} lockstep pairs` : ''}; ~${(msJit / total).toFixed(1)} ms/hash JIT vs ${(msRef / total).toFixed(1)} interp, incl. warm-up)`);
process.exit(0);
