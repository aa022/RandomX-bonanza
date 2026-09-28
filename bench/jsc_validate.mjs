// JSC validation gate: generates the threaded-interpreter module for a given
// feature set (same setup as full_mode_check.mjs), copies its bytes out of
// wasm memory and runs WebAssembly.validate() in Safari's JavaScriptCore
// shell. JSC has no relaxed SIMD, so feature 4/5 (--feature-base 0/1) modules
// must validate there; feature 7 (--feature-base 3) is expected to FAIL.
//
// Usage:
//   node bench/jsc_validate.mjs --feature-base 0          # Safari path (feature 4)
//   node bench/jsc_validate.mjs --feature-base 1          # relaxed, no FMA (feature 5)
//   node bench/jsc_validate.mjs --feature-base 0 --out m.wasm   # keep the module

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdtempSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { execFileSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const createRandomX = require(join(__dirname, '..', 'public', 'randomx.js'));

const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };

const JSC = arg('--jsc', '/System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc');
const INIT_THREADS = Number(arg('--init-threads', '10'));
const KEY = arg('--key', 'gh-distro bench key');
const FULL_MEM = 4;

const Module = await createRandomX();
let maxPages = 65536;
try { const d = Module.wasmMemory.type(); if (d && d.maximum) maxPages = d.maximum; } catch (_) {}
Module._rxjit_set_max_memory_pages(maxPages);
const feature = (Number(arg('--feature-base', '0')) | Number(arg('--feature-extra', '0'))) | 4;
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
const len = Module._rxjit_stat_threaded_module_size() >>> 0; // single-threaded here: this thread's module
if (!ptr || !len) { console.error(`FAIL feature=${feature}: no threaded module was generated`); process.exit(1); }
const bytes = Module.HEAPU8.slice(ptr, ptr + len);
const nodeOk = WebAssembly.validate(bytes);

const dir = mkdtempSync(join(tmpdir(), 'rxjsc-'));
const wasmPath = arg('--out', join(dir, `threaded_f${feature}.wasm`));
writeFileSync(wasmPath, bytes);
const jsPath = join(dir, 'validate.js');
writeFileSync(jsPath,
  `var b = readFile(${JSON.stringify(wasmPath)}, "binary");\n` +
  `print(WebAssembly.validate(b) ? "VALID" : "INVALID");\n`);
let out;
try { out = execFileSync(JSC, [jsPath], { encoding: 'utf8' }).trim(); }
catch (e) { out = `jsc error: ${e.message}`; }

const ok = out === 'VALID';
console.log(`${ok ? 'OK' : 'FAIL'} feature=${feature}: threaded module ${len} B, jsc ${out}, node validate=${nodeOk} (${wasmPath})`);
process.exit(ok ? 0 : 1);
