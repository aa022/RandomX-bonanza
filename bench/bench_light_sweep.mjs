// Light-mode sweep driver (`make bench-light`): reruns nosab_bench.mjs in a
// fresh node process per pass and prints a summary in bench_sweep.mjs's
// format. Fixed passes, no knobs:
//   light only        1, 4, 10, 32 workers (the full-mode sweep's thread counts)
//   1 full-dataset    1, 1+3, 1+9, 1+31
//   2 full-dataset    2, 2+2, 2+8, 2+30
// RAM is estimated with the embed's figures (public/embed.js): ~300 MiB per
// worker plus ~2300 MiB per full-dataset worker. A pass whose estimate exceeds
// 60% of total system RAM is skipped.
//
// Usage: node bench/bench_light_sweep.mjs

import { spawn, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { cpus, totalmem, platform, arch, tmpdir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BENCH     = join(__dirname, 'nosab_bench.mjs');

const DURATION_S  = 30;
const WARMUP_S    = 4;
const WORKER_MIB  = 300;   // per worker: 256 MiB cache + module (embed.js WORKER_MIB)
const REPLICA_MIB = 2300;  // per full-dataset worker, on top (embed.js REPLICA_MIB)
const RAM_SHARE   = 0.6;

const PASSES = [
  [0, 1], [0, 4], [0, 10], [0, 32],
  [1, 1], [1, 4], [1, 10], [1, 32],
  [2, 2], [2, 4], [2, 10], [2, 32],
].map(([full, workers]) => ({ full, workers, mib: workers * WORKER_MIB + full * REPLICA_MIB }));

const pad   = (s, w) => String(s).padStart(w, ' ');
const gb    = (mib) => (mib / 1024).toFixed(1) + ' GiB';
const label = ({ full, workers }) => !full ? String(workers)
                                   : full === workers ? String(full) + 'F'
                                   : `${full}F+${workers - full}`;

// Same detection as bench_sweep.mjs.
function detectCpuInfo() {
  const list  = cpus() || [];
  let model   = list[0]?.model || 'unknown';
  try {
    if (platform() === 'darwin') {
      const s = execSync('sysctl -n machdep.cpu.brand_string', { encoding: 'utf8' }).trim();
      if (s) model = s;
    } else if (platform() === 'linux') {
      const m = readFileSync('/proc/cpuinfo', 'utf8').match(/^model name\s*:\s*(.+)$/m);
      if (m) model = m[1].trim();
    }
  } catch (_) { /* keep os.cpus() value */ }
  return { model, cores: list.length, arch: arch(), platform: platform(),
           total_mib: totalmem() / (1 << 20), node: process.version };
}

function runPass({ full, workers }, outPath) {
  return new Promise((resolve, reject) => {
    const argv = [BENCH, '--workers', String(workers), '--full', String(full),
                  '--secs', String(DURATION_S), '--warmup', String(WARMUP_S), '--out', outPath];
    const child = spawn(process.execPath, argv, { stdio: 'inherit' });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`nosab_bench.mjs exited with code ${code}`));
    });
  });
}

async function main() {
  const cpu = detectCpuInfo();
  const budget = cpu.total_mib * RAM_SHARE;
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`  host: ${cpu.model}`);
  console.log(`        ${cpu.cores} logical cores · ${cpu.arch} · ${cpu.platform} · ` +
              `${gb(cpu.total_mib)} RAM · node ${cpu.node}`);
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`  RAM: each worker takes ~${WORKER_MIB} MiB, each full-dataset worker ~${REPLICA_MIB} MiB more.`);
  console.log(`       Passes estimated above ${RAM_SHARE * 100}% of system RAM (${gb(budget)}) are skipped.`);
  console.log(`       NF+M = N full-dataset workers + M light workers.`);

  const tmp = mkdtempSync(join(tmpdir(), 'rxbench-light-'));
  const results = [];
  const t0 = Date.now();

  try {
    for (let i = 0; i < PASSES.length; i++) {
      const p = PASSES[i];
      console.log('');
      console.log('════════════════════════════════════════════════════════════════');
      console.log(`  pass ${i + 1}/${PASSES.length}  —  workers = ${label(p)}  (~${gb(p.mib)} RAM)`);
      console.log('════════════════════════════════════════════════════════════════');
      if (p.mib > budget) {
        console.log(`  skipped: needs ~${gb(p.mib)}, over the ${gb(budget)} budget`);
        results.push({ ...p, skipped: true });
        continue;
      }
      const outPath = join(tmp, `pass-${i}.json`);
      await runPass(p, outPath);
      results.push({ ...p, ...JSON.parse(readFileSync(outPath, 'utf8')) });
    }
  } finally {
    try { rmSync(tmp, { recursive: true, force: true }); } catch (_) {}
  }

  const wall = ((Date.now() - t0) / 1000).toFixed(1);

  console.log('');
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log(`  light sweep summary  —  ${cpu.model}  (${cpu.cores} cores, ${cpu.arch})`);
  console.log(`                    ${DURATION_S}s/pass · profile=auto · RAM cap ${gb(budget)} · wall=${wall}s`);
  console.log('═══════════════════════════════════════════════════════════════════════');
  console.log('   threads    init        hashes    elapsed     H/s      H/s/thread');
  console.log('  ──────────────────────────────────────────────────────────────────');
  for (const r of results) {
    if (r.skipped) {
      console.log(`   ${label(r).padEnd(5)}     skipped (needs ~${gb(r.mib)} RAM)`);
      continue;
    }
    const note = r.full_active < r.full ? `   (${r.full_active}/${r.full} full-dataset)` : '';
    console.log(
      `   ${label(r).padEnd(5)}     ` +
      `${pad(r.init_s.toFixed(2), 6)} s   ` +
      `${pad(r.hashes, 7)}    ` +
      `${pad(r.elapsed_s.toFixed(2), 6)} s   ` +
      `${pad(r.hashrate.toFixed(0), 6)}    ` +
      `${pad(r.per_thread.toFixed(1), 6)}${note}`);
  }
  console.log('═══════════════════════════════════════════════════════════════════════');
}

main().catch((err) => { console.error(err); process.exit(1); });
