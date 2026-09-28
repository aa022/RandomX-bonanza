import { createRequire } from 'module';
const require = createRequire(import.meta.url);
// AES gate: T-table (aes_simd 0, aes_relaxed 0) vs the relaxed side module
// (aes_relaxed 1) on single hashes and a first/next/last chain (hashAndFill).
// FAILs on any mismatch, a canonical-vector miss, or 0 side-module calls in
// the relaxed run (= silent fallback). Usage: node bench/aes_check.mjs
const createRandomX = require('../public/randomx.js');
const M = await createRandomX();
M._rxjit_set_feature(7); // relaxed allowed
const t0 = Date.now();
const N = 1 << 20;
console.log('selftest enc', M._rx_aes_selftest(N, 0), 'dec', M._rx_aes_selftest(N, 1), `(${Date.now() - t0} ms)`);
const c = (n, r, a) => M.cwrap(n, r, a);
const alloc_cache = c('randomx_alloc_cache', 'number', ['number']);
const init_cache = c('randomx_init_cache', null, ['number', 'number', 'number']);
const create_vm = c('randomx_create_vm', 'number', ['number', 'number', 'number']);
const calc = c('randomx_calculate_hash', null, ['number', 'number', 'number', 'number']);
const first = c('randomx_calculate_hash_first', null, ['number', 'number', 'number']);
const next = c('randomx_calculate_hash_next', null, ['number', 'number', 'number', 'number']);
const last = c('randomx_calculate_hash_last', null, ['number', 'number']);
const put = (s) => { const p = M._malloc(s.length); for (let i = 0; i < s.length; i++) M.HEAPU8[p + i] = s.charCodeAt(i); return p; };
const hex = (p) => Array.from(M.HEAPU8.subarray(p, p + 32), (b) => b.toString(16).padStart(2, '0')).join('');
const key = 'RandomX example key\0';
const kp = put(key);
const cache = alloc_cache(0);
init_cache(cache, kp, key.length);
const vm = create_vm(0, cache, 0);
const hp = M._malloc(32);
const inputs = ['RandomX example input\0', '', 'a', 'abc', 'x'.repeat(76), '\xff'.repeat(200), '\0'.repeat(64)];
function run(simd, relaxed) {
  M._rxjit_set_aes_simd(simd);
  M._rxjit_set_aes_relaxed(relaxed);
  const eff = `${M._rxjit_effective_aes_simd()}/${M._rxjit_effective_aes_relaxed()}`;
  const c0 = M._rx_aes_relaxed_calls();
  const out = [];
  for (const s of inputs) { const p = put(s); calc(vm, p, s.length, hp); out.push(hex(hp)); M._free(p); }
  // chained first/next/last (hashAndFillAes1Rx4 path)
  const ps = inputs.map(put);
  first(vm, ps[0], inputs[0].length);
  for (let i = 1; i < inputs.length; i++) { next(vm, ps[i], inputs[i].length, hp); out.push('chain' + (i - 1) + ':' + hex(hp)); }
  last(vm, hp); out.push('last:' + hex(hp));
  ps.forEach((p) => M._free(p));
  return { eff, out, calls: M._rx_aes_relaxed_calls() - c0 };
}
const t1 = Date.now();
const a = run(0, 0), b = run(1, 1);
console.log(`eff aes_simd/aes_relaxed: T-table run=${a.eff} relaxed run=${b.eff} (${Date.now() - t1} ms for ${a.out.length * 2} hashes)`);
console.log(`rx_aes_relaxed_calls: T-table run=${a.calls} relaxed run=${b.calls}`);
const nocalls = b.calls === 0 || a.calls !== 0;
if (nocalls) console.log('FAIL: relaxed run made no side-module calls (silent fallback) or T-table run used it');
let bad = 0;
for (let i = 0; i < a.out.length; i++) if (a.out[i] !== b.out[i]) { bad++; console.log('MISMATCH', i, a.out[i], b.out[i]); }
const canon = '8a48e5f9db45ab79d9080574c4d81954fe6ac63842214aff73c244b26330b7c9';
const canonBad = a.out[0] !== canon || b.out[0] !== canon;
console.log('canonical T-table', a.out[0] === canon ? 'PASS' : 'FAIL', 'relaxed', b.out[0] === canon ? 'PASS' : 'FAIL');
// chained vs single: chain i must equal calc of inputs[i]
let cbad = 0;
for (let i = 0; i < inputs.length - 1; i++) if (b.out[inputs.length + i].split(':')[1] !== b.out[i]) cbad++;
if (b.out[b.out.length - 1].split(':')[1] !== b.out[inputs.length - 1]) cbad++;
console.log(`relaxed vs T-table mismatches=${bad} of ${a.out.length}; chain-vs-single mismatches (relaxed)=${cbad}`);
M._rxjit_set_aes_simd(-1); M._rxjit_set_aes_relaxed(-1);
M._rxjit_set_profile(1); console.log('x86 profile, feature 7 -> aesr', M._rxjit_effective_aes_relaxed());
M._rxjit_set_feature(0); console.log('x86 profile, feature 0 -> aesr', M._rxjit_effective_aes_relaxed());
M._rxjit_set_feature(7); M._rxjit_set_profile(0); console.log('arm profile, feature 7 -> aesr', M._rxjit_effective_aes_relaxed());
const fail = bad || cbad || canonBad || nocalls;
console.log(fail ? 'AES CHECK FAIL' : 'AES CHECK PASS');
process.exit(fail ? 1 : 0);
