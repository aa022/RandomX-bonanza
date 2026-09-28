// Dump the threaded-interpreter module this build generates, for a given
// feature set, so two builds can be compared (wasm2wat + diff). Same setup as
// jsc_validate.mjs: full dataset, one hash on this thread, then copy the
// module bytes out of wasm memory.
//
// Usage:
//   node bench/prof/dump_module.mjs --feature-base 3 --out bench/results/ref_f7.wasm
//   node bench/prof/dump_module.mjs --feature-base 0 --out bench/results/ref_f4.wasm
//
// Compare (baked pointers differ between builds, so normalise numbers >= 1e6):
//   wasm2wat --enable-all A.wasm | sed -E 's/\b[0-9]{7,}\b/P/g' > a.wat  (same for B), then diff a.wat b.wat

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { writeFileSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const createRandomX = require(join(__dirname, '..', '..', 'public', 'randomx.js'));

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };

const INIT_THREADS = Number(arg('--init-threads', '10'));
const KEY = arg('--key', 'gh-distro bench key');
const OUT = arg('--out', '');
const FULL_MEM = 4;
if (!OUT) { console.error('usage: dump_module.mjs [--feature-base N] [--feature-extra N] --out F.wasm'); process.exit(2); }

const Module = await createRandomX();
let maxPages = 65536;
try { const d = Module.wasmMemory.type(); if (d && d.maximum) maxPages = d.maximum; } catch (_) {}
Module._rxjit_set_max_memory_pages(maxPages);
const feature = (Number(arg('--feature-base', '3')) | Number(arg('--feature-extra', '0'))) | 4;
Module._rxjit_set_use_threaded_interp(1);
Module._rxjit_set_regs_in_memory(1);
Module._rxjit_set_split_inner_dispatch(1);
Module._rxjit_set_feature(feature);
Module._rxjit_set_supjit_enabled(1);
Module._rxSetJitEnabled(1);

const c = (n, r, a) => Module.cwrap(n, r, a);
const cache = c('randomx_alloc_cache', 'number', ['number'])(FULL_MEM);
const keyBytes = Buffer.from(KEY);
const keyPtr = Module._malloc(keyBytes.length);
Module.HEAPU8.set(keyBytes, keyPtr);
c('randomx_init_cache', null, ['number', 'number', 'number'])(cache, keyPtr, keyBytes.length);
const dataset = c('randomx_alloc_dataset', 'number', ['number'])(FULL_MEM);
const items = c('randomx_dataset_item_count', 'number', [])();
if (!c('rxInitDatasetStart', 'number', ['number', 'number', 'number', 'number', 'number'])(cache, dataset, 0, items, INIT_THREADS))
  throw new Error('rxInitDatasetStart failed');
const progress = c('rxInitDatasetProgress', 'number', []);
while ((progress() >>> 0) < items) await new Promise((r) => setTimeout(r, 100));
c('rxInitDatasetJoin', 'number', [])();
const vm = c('randomx_create_vm', 'number', ['number', 'number', 'number'])(FULL_MEM, cache, dataset);
if (!vm) throw new Error('create_vm failed');

// Hash one input on this thread so it generates its threaded module.
const inPtr = Module._malloc(64), outPtr = Module._malloc(32);
Module.HEAPU8.fill(7, inPtr, inPtr + 43);
c('randomx_calculate_hash', null, ['number', 'number', 'number', 'number'])(vm, inPtr, 43, outPtr);

const ptr = Module._rxjit_threaded_module_ptr() >>> 0;
const len = Module._rxjit_stat_threaded_module_size() >>> 0;
if (!ptr || !len) { console.error(`FAIL feature=${feature}: no threaded module was generated`); process.exit(1); }
const bytes = Module.HEAPU8.slice(ptr, ptr + len);
writeFileSync(OUT, bytes);
console.log(`OK feature=${feature}: threaded module ${len} B, node validate=${WebAssembly.validate(bytes)} -> ${OUT}`);
process.exit(0);
