// Mining-context gate (perf step 4, in-batch nonce claiming, no run-ahead):
// every rxMineBatchContext call returns nonceCount; with an all-0xFF target
// the reported share's nonce lies in the call's range and its hash equals the
// JIT-off (portable C) recomputation; with an all-0x00 target nothing is found.
// Usage: node bench/mine_ctx_check.mjs [--threads 10] [--init-threads 10]
//          [--profile auto|arm|x86] [--fuse-n N] [--triples-n N] [--unroll2 [0|1]]
//          [--shared-code 0|1]   (bench/profile_args.mjs)
// Also prints the module-bytes identity stat: with shared_code, every
// thread's module must equal the first (mismatch=0), else the gate fails.

import { createRequire } from 'module';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { parseProfileArgs, applyProfile, profileHeader, moduleHashLine } from './profile_args.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const createRandomX = require(join(__dirname, '..', 'public', process.env.RX_BUILD === 'st' ? 'randomx_st.js' : 'randomx.js'));
const args = process.argv.slice(2);
const arg = (n, d) => { const i = args.indexOf(n); return i < 0 ? d : args[i + 1]; };
const THREADS = Number(arg('--threads', '10'));
const INIT_THREADS = Number(arg('--init-threads', '10'));
const PROF = parseProfileArgs(args);
const FULL_MEM = 4, BLOB_LEN = 76, NONCE_OFFSET = 39;

const M = await createRandomX();
let maxPages = 65536;
try { const d = M.wasmMemory.type(); if (d && d.maximum) maxPages = d.maximum; } catch (_) {}
M._rxjit_set_max_memory_pages(maxPages);
M._rxjit_set_use_threaded_interp(1);
M._rxjit_set_regs_in_memory(1);
M._rxjit_set_split_inner_dispatch(1);
M._rxjit_set_feature(7);
applyProfile(M, PROF);
M._rxjit_set_supjit_enabled(1);
M._rxSetJitEnabled(1);

const c = (n, r, a) => M.cwrap(n, r, a);
const N = 'number';
const cache = c('randomx_alloc_cache', N, [N])(FULL_MEM);
const key = Buffer.from('gh-distro bench key');
const keyPtr = M._malloc(key.length); M.HEAPU8.set(key, keyPtr);
c('randomx_init_cache', null, [N, N, N])(cache, keyPtr, key.length);
const dataset = c('randomx_alloc_dataset', N, [N])(FULL_MEM);
const items = c('randomx_dataset_item_count', N, [])();
if (!c('rxInitDatasetStart', N, [N, N, N, N, N])(cache, dataset, 0, items, INIT_THREADS)) throw new Error('init');
while ((c('rxInitDatasetProgress', N, [])() >>> 0) < items) await new Promise((r) => setTimeout(r, 100));
c('rxInitDatasetJoin', N, [])();

const ctx = c('rxCreateMiningContext', N, [N, N, N, N])(FULL_MEM, 0, dataset, THREADS);
if (!ctx) throw new Error('rxCreateMiningContext failed');
const mine = c('rxMineBatchContext', N, [N, N, N, N, N, N, N, N]);
const blobPtr = M._malloc(BLOB_LEN), tgtPtr = M._malloc(32), resPtr = M._malloc(40);
const blob = new Uint8Array(BLOB_LEN).map((_, i) => (i * 37 + 11) & 0xff);
M.HEAPU8.set(blob, blobPtr);

let bad = 0;
const fail = (m) => { if (bad++ < 8) console.error('FAIL ' + m); };
const shares = [];
const counts = [1, 3, THREADS, THREADS + 1, 4 * THREADS, 4 * THREADS + 3, 17, 2];
let start = 1000;
for (const [ci, count] of counts.entries()) {
  M.HEAPU8.fill(0xff, tgtPtr, tgtPtr + 32);
  const done = mine(ctx, blobPtr, BLOB_LEN, tgtPtr, NONCE_OFFSET, start, count, resPtr) >>> 0;
  if (done !== count) fail(`call ${ci}: returned ${done}, want ${count}`);
  const r = M.HEAPU8.slice(resPtr, resPtr + 40);
  const nonce = (r[4] | (r[5] << 8) | (r[6] << 16) | (r[7] << 24)) >>> 0;
  if (r[0] !== 1) fail(`call ${ci}: no share with 0xFF target`);
  else if (nonce < start || nonce >= start + count) fail(`call ${ci}: nonce ${nonce} outside [${start},${start + count})`);
  else shares.push({ ci, nonce, hash: Buffer.from(r.slice(8, 40)).toString('hex') });
  start += count;
  M.HEAPU8.fill(0x00, tgtPtr, tgtPtr + 32);
  const done0 = mine(ctx, blobPtr, BLOB_LEN, tgtPtr, NONCE_OFFSET, start, count, resPtr) >>> 0;
  if (done0 !== count) fail(`call ${ci}/0: returned ${done0}, want ${count}`);
  if (M.HEAPU8[resPtr] !== 0) fail(`call ${ci}/0: share reported with 0x00 target`);
  start += count;
}
c('rxDestroyMiningContext', null, [N])(ctx);

M._rxSetJitEnabled(0);
const vm = c('randomx_create_vm', N, [N, N, N])(FULL_MEM, cache, dataset);
const calc = c('randomx_calculate_hash', null, [N, N, N, N]);
const inPtr = M._malloc(BLOB_LEN), outPtr = M._malloc(32);
for (const s of shares) {
  const b = blob.slice();
  b[NONCE_OFFSET] = s.nonce & 0xff; b[NONCE_OFFSET + 1] = (s.nonce >>> 8) & 0xff;
  b[NONCE_OFFSET + 2] = (s.nonce >>> 16) & 0xff; b[NONCE_OFFSET + 3] = s.nonce >>> 24;
  M.HEAPU8.set(b, inPtr);
  calc(vm, inPtr, BLOB_LEN, outPtr);
  const ref = Buffer.from(M.HEAPU8.slice(outPtr, outPtr + 32)).toString('hex');
  if (ref !== s.hash) fail(`call ${s.ci}: nonce ${s.nonce} hash ${s.hash} != ref ${ref}`);
}
const gen = profileHeader(M, PROF);
console.log(moduleHashLine(M));
if (M._rxjit_effective_shared_code() && (M._rxjit_stat_module_hash_mismatch() >>> 0))
  fail('shared_code: threads generated different module bytes');
if (bad) { console.error(`FAIL mine_ctx_check (${THREADS}T ${gen}): ${bad} problems`); process.exit(1); }
console.log(`OK mine_ctx_check (${THREADS}T ${gen}): ${counts.length * 2} calls returned nonceCount, ${shares.length} shares match the portable interpreter`);
process.exit(0);
