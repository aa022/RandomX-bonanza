#!/usr/bin/env python3
"""Per-arm cost table for the threaded inner_dispatch (x64, V8 jitdump + perf).

arms.py JITDUMP PERFDATA SKIP_S FUSE_N
  SKIP_S: ignore samples in the first SKIP_S seconds (dataset init)
Cycles/exec = arm samples * period / expected executions (kind-model simulation).
"""
import struct, sys, subprocess, collections, bisect, re, random
from fractions import Fraction as F

REPO = '/mnt/vault/dny/RandomX-bonanza'
PERIOD = 400009
jd, pd, skip, fuse_n = sys.argv[1], sys.argv[2], float(sys.argv[3]), int(sys.argv[4])

def loads(path):
    f = open(path, 'rb').read()
    _m, _v, hsize = struct.unpack_from('<III', f, 0)
    off, out = hsize, []
    while off + 16 <= len(f):
        rid, tsize, _ts = struct.unpack_from('<IIQ', f, off)
        if tsize == 0: break
        if rid == 0:
            _p, _t, _vma, caddr, csize, _i = struct.unpack_from('<IIQQQQ', f, off + 16)
            p = off + 56; e = f.index(b'\0', p)
            out.append((caddr, csize, f[p:e].decode(errors='replace'), f[e + 1:e + 1 + csize]))
        off += tsize
    return out

L = loads(jd)
fn = max([l for l in L if 'wasm-function[22]-22-turbofan' in l[2]], key=lambda l: l[1])
base, size, _, code = fn
# disassemble to find the jump table
open('/tmp/rxprof/fn.bin', 'wb').write(code)
dis = subprocess.run(['objdump', '-D', '-b', 'binary', '-mi386:x86-64', '-M', 'intel', '/tmp/rxprof/fn.bin'],
                     capture_output=True, text=True).stdout.splitlines()
tab = nent = None
for i, ln in enumerate(dis):
    m = re.search(r'jmp\s+QWORD PTR \[r10\+r\w+\*8\]', ln)
    if m and tab is None:
        for back in dis[i - 6:i]:
            mm = re.search(r'#\s*0x([0-9a-f]+)', back)
            if 'lea' in back and mm: tab = int(mm.group(1), 16)
            mc = re.search(r'cmp\s+r\w+,0x([0-9a-f]+)', back)
            if mc: nent = int(mc.group(1), 16)
print(f'# fn22 {size} B at {base:#x}; jump table at +{tab:#x}, {nent} entries')
arm_off = [struct.unpack_from('<Q', code, tab + 8 * k)[0] - base for k in range(nent)]
order = sorted(range(nent), key=lambda k: arm_off[k])
starts = [arm_off[k] for k in order]

# samples of the busiest thread after SKIP_S
lines = subprocess.run(['perf', 'script', '-i', pd, '-F', 'tid,time,ip'], capture_output=True, text=True).stdout.splitlines()
per_tid = collections.defaultdict(list)
t0 = None
for ln in lines:
    p = ln.split()
    if len(p) < 3: continue
    t = float(p[1].rstrip(':'))
    t0 = t if t0 is None else t0
    if t - t0 < skip: continue
    per_tid[p[0]].append(int(p[2], 16))
tid = max(per_tid, key=lambda t: sum(1 for ip in per_tid[t] if base <= ip < base + size))
ips = per_tid[tid]
tot = len(ips)
hdr = arm = 0
per_arm = collections.Counter()
for ip in ips:
    if not (base <= ip < base + size): continue
    o = ip - base
    if o >= tab: continue
    j = bisect.bisect_right(starts, o) - 1
    if j < 0: hdr += 1; continue
    per_arm[order[j]] += 1
print(f'# mining tid {tid}: {tot} samples; fn22 header/prologue {hdr}, arms {sum(per_arm.values())}')

# kind model + greedy pairing simulation (same as gen_fuse_table.py)
src = open(f'{REPO}/wasm/tools/gen_fuse_table.py').read()
g = {'re': re, 'os': __import__('os'), 'F': F, 'SRC': f'{REPO}/wasm/src/src'}
exec(src[src.index('hdr = open('):src.index('\nN = min(') if '\nN = min(' in src else src.index('\nN =')], g)
p, names = g['p'], g['names']
K = len(names)
hdrtxt = open(f'{REPO}/wasm/src/src/wasm_jit_fuse_table.h').read()
m = re.search(r'rxjit_fuse_pairs\[[^\]]*\]\[2\]\s*=\s*\{(.*?)\};', hdrtxt, re.S)
pairs = [(names.index(a), names.index(b)) for a, b in re.findall(r'\{RXJIT_K_(\w+), RXJIT_K_(\w+)\}', m.group(1))][:fuse_n]
pidx = {pr: K + i for i, pr in enumerate(pairs)}
ks = [names.index(k) for k in p]; ws = [float(p[names[k]]) for k in ks]
random.seed(7)
cnt = collections.Counter(); ndisp = 0
for _ in range(3000):
    pr = random.choices(ks, ws, k=256)
    i = 0
    while i < 256:
        if i < 255 and (pr[i], pr[i + 1]) in pidx:
            cnt[pidx[(pr[i], pr[i + 1])]] += 1; i += 2
        else:
            cnt[pr[i]] += 1; i += 1
        ndisp += 1
print(f'# simulated dispatches/op {ndisp / 3000 / 256:.3f}')
cyc_total = tot * PERIOD
disp_total = cyc_total / 18.3 * (sum(per_arm.values()) + hdr) / tot  # rough, see below
# better: executions share * total dispatches, total dispatches = measured cycles/dispatch
tot_disp = cyc_total / 18.3
def nm(k):
    if k < K: return names[k]
    a, b = pairs[k - K]; return f'{names[a]}+{names[b]}'
rows = []
for k in range(nent):
    share = cnt[k] / ndisp
    execs = share * tot_disp
    cyc = per_arm[k] * PERIOD
    rows.append((cyc / execs if execs else 0.0, share, per_arm[k] / tot, nm(k), k))
print(f'{"cyc/exec":>8} {"exec%":>6} {"time%":>6}  arm')
agg = collections.defaultdict(lambda: [0.0, 0.0])
for c, s, t, n, k in rows:
    agg['pairs' if k >= K else n][0] += s; agg['pairs' if k >= K else n][1] += t
for c, s, t, n, k in sorted(rows, key=lambda r: -r[2])[:25]:
    print(f'{c:8.1f} {100*s:6.2f} {100*t:6.2f}  {n}')
print('# base kinds by time (exec% / time% / cyc per exec):')
for n, (s, t) in sorted(agg.items(), key=lambda kv: -kv[1][1])[:30]:
    ce = (t * cyc_total) / (s * tot_disp) if s else 0
    print(f'{ce:8.1f} {100*s:6.2f} {100*t:6.2f}  {n}')
