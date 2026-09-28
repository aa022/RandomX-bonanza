// Sweep driver: reruns bench_webui.mjs in a fresh node process per thread
// count, captures the per-pass JSON result, and prints a summary table.
//
// Why a fresh process per pass? Sharing a single Module across multiple
// rxCreateMiningContext / rxInitDatasetStart cycles leaks Emscripten
// pthread-pool state — the final pass at 32 threads ends up at ~230 H/s
// instead of the ~540 H/s a cold-start run delivers. Forking sidesteps
// the whole problem.
//
// Usage:
//   node bench/bench_sweep.mjs                              # 1,4,32 @ 30s
//   node bench/bench_sweep.mjs --sweep 1,8,16,32            # custom set
//   node bench/bench_sweep.mjs --duration 15                # 15s per pass
//   node bench/bench_sweep.mjs --init-threads 16            # init at 16 thr
//   node bench/bench_sweep.mjs --extra "--no-supjit"        # forward args
//   node bench/bench_sweep.mjs --profile x86                # generator profile auto|arm|x86

import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { cpus, totalmem, platform, arch, tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH     = join(__dirname, 'bench_webui.mjs');

const args = process.argv.slice(2);
function arg(name, dflt) { const i = args.indexOf(name); return i < 0 ? dflt : args[i + 1]; }

const SWEEP_RAW   = arg('--sweep', '1,4,10,32');
const SWEEP       = SWEEP_RAW.split(',')
                              .map((s) => Math.max(1, Math.min(32, Number(s.trim()))))
                              .filter((n) => Number.isFinite(n) && n > 0);
const INIT_THREADS = arg('--init-threads', '32');
const DURATION_S   = arg('--duration', '30');
const EXTRA        = arg('--extra', ''); // forwarded raw to bench_webui.mjs
const PROFILE      = arg('--profile', 'auto'); // forwarded to bench_webui.mjs (profile_args.mjs)

if (SWEEP.length === 0) {
  console.error(`bad --sweep value: "${SWEEP_RAW}"`);
  process.exit(1);
}

const pad = (s, w) => String(s).padStart(w, ' ');

// os.cpus()[0].model gives generic names on Apple Silicon ("Apple M1"). On
// darwin the real marketing string lives in sysctl; on linux it's in
// /proc/cpuinfo's "model name". Fall back to os.cpus() otherwise.
function detectCpuInfo() {
  const list  = cpus() || [];
  const cores = list.length;
  let model   = list[0]?.model || 'unknown';
  try {
    if (platform() === 'darwin') {
      const s = execSync('sysctl -n machdep.cpu.brand_string', { encoding: 'utf8' }).trim();
      if (s) model = s;
    } else if (platform() === 'linux') {
      const s = readFileSync('/proc/cpuinfo', 'utf8');
      const m = s.match(/^model name\s*:\s*(.+)$/m);
      if (m) model = m[1].trim();
    }
  } catch (_) { /* keep os.cpus() value */ }
  return {
    model,
    cores,
    arch:    arch(),
    platform: platform(),
    total_ram_gb: Number((totalmem() / (1 << 30)).toFixed(2)),
    node:    process.version,
  };
}

function runPass(threads, outPath) {
  return new Promise((resolve, reject) => {
    const extra = EXTRA ? EXTRA.split(/\s+/).filter(Boolean) : [];
    const argv = [
      BENCH,
      '--threads',      String(threads),
      '--init-threads', String(INIT_THREADS),
      '--duration',     String(DURATION_S),
      '--out',          outPath,
      ...extra,
      '--profile',      PROFILE, // after extra: a --profile inside --extra wins
    ];
    const child = spawn(process.execPath, argv, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`bench_webui.mjs exited with code ${code}`));
    });
  });
}

async function main() {
  const cpu = detectCpuInfo();
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`  host: ${cpu.model}`);
  console.log(`        ${cpu.cores} logical cores · ${cpu.arch} · ${cpu.platform} · ` +
              `${cpu.total_ram_gb} GiB RAM · node ${cpu.node}`);
  console.log('═══════════════════════════════════════════════════════════════════════');

  const tmp = mkdtempSync(join(tmpdir(), 'rxbench-'));
  const results = [];
  const t0 = Date.now();

  try {
    for (let i = 0; i < SWEEP.length; i++) {
      const T = SWEEP[i];
      console.log('');
      console.log(`════════════════════════════════════════════════════════════════`);
      console.log(`  pass ${i + 1}/${SWEEP.length}  —  mining threads = ${T}`);
      console.log(`════════════════════════════════════════════════════════════════`);
      const outPath = join(tmp, `pass-${T}.json`);
      await runPass(T, outPath);
      results.push(JSON.parse(readFileSync(outPath, 'utf8')));
    }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  const wall = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`  sweep summary  —  ${cpu.model}  (${cpu.cores} cores, ${cpu.arch})`);
  console.log(`                    init=${INIT_THREADS} threads · ${DURATION_S}s/pass · profile=${PROFILE} · wall=${wall}s`);
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('   threads    init        hashes    elapsed     H/s      H/s/thread');
  console.log('  ──────────────────────────────────────────────────────────────────');
  for (const r of results) {
    console.log(
      `   ${pad(r.threads, 3)}       ` +
      `${pad(r.init_s.toFixed(2), 6)} s   ` +
      `${pad(r.hashes, 7)}    ` +
      `${pad(r.elapsed_s.toFixed(2), 6)} s   ` +
      `${pad(r.hashrate.toFixed(0), 6)}    ` +
      `${pad(r.per_thread.toFixed(1), 6)}`);
  }
  console.log('═══════════════════════════════════════════════════════════════════════');
}

main().catch((err) => { console.error(err); process.exit(1); });
