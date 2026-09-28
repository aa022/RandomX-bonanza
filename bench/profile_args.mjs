// Threaded-module generator profile flags shared by the Node benches/gates
// (wasm/src/src/wasm_jit_profile.h):
//   --profile auto|arm|x86   default auto = x86 on process.arch x64, else arm
//   --fuse-n N               fused pairs, overrides the profile's
//   --triples-n N            fused triples, overrides the profile's
//   --unroll2 [0|1]          2x dispatch replication (bare = 1), overrides the profile's
//
//   const prof = parseProfileArgs(args);
//   ... _rxjit_set_feature(...) ...
//   applyProfile(Module, prof);  // after the last set_feature, before the first hash
//   profileHeader(Module, prof)  // 'profile=x86 (auto) fuse_n=200 triples_n=0 unroll2=0 kind16=0'

export const PROFILE_NAMES = ['arm', 'x86']; // index = RXJIT_PROFILE_*

export function parseProfileArgs(args) {
  const arg = (n) => { const i = args.indexOf(n); return i < 0 ? '' : String(args[i + 1] ?? ''); };
  const bad = (m) => { console.error(m); process.exit(2); };
  const req = arg('--profile') || 'auto';
  if (req !== 'auto' && !PROFILE_NAMES.includes(req)) bad(`--profile must be one of auto|${PROFILE_NAMES.join('|')}`);
  const knob = (n) => { // -1: the profile's value
    const s = arg(n);
    if (s === '') return -1;
    if (!/^\d+$/.test(s)) bad(`${n} wants a non-negative integer, got '${s}'`);
    return Number(s);
  };
  const u = args.indexOf('--unroll2'); // bare flag = 1; an optional 0|1 value follows
  const uv = u < 0 ? -1 : (args[u + 1] === '0' || args[u + 1] === '1') ? Number(args[u + 1]) : 1;
  return {
    name: req === 'auto' ? (process.arch === 'x64' ? 'x86' : 'arm') : req,
    mode: req === 'auto' ? 'auto' : 'forced',
    fuseN: knob('--fuse-n'),
    triplesN: knob('--triples-n'),
    unroll2: uv,
  };
}

export function applyProfile(Module, prof) {
  Module._rxjit_set_profile(PROFILE_NAMES.indexOf(prof.name));
  Module._rxjit_set_fuse_n(prof.fuseN);
  Module._rxjit_set_triples_n(prof.triplesN);
  Module._rxjit_set_unroll2(prof.unroll2);
}

// Effective values read back from C (the feature's NO_FUSE bit included).
export function profileHeader(Module, prof) {
  return `profile=${PROFILE_NAMES[Module._rxjit_get_profile()]} (${prof.mode})` +
    ` fuse_n=${Module._rxjit_effective_fuse_n()} triples_n=${Module._rxjit_effective_triples_n()}` +
    ` unroll2=${Module._rxjit_effective_unroll2()} kind16=${Module._rxjit_effective_kind16()}`;
}

// Static dispatches/op: dispatch records per decoded 256-op program.
export function staticDispatchesPerOp(Module) {
  const progs = Module._rxjit_stat_decoded_programs();
  return progs ? Module._rxjit_stat_dispatches() / (256 * progs) : NaN;
}
