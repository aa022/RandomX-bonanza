#!/usr/bin/env python3
"""Instruction-level profile of one JIT function from a V8 jitdump + perf.data.

  jd.py list JITDUMP                       largest code objects
  jd.py prof JITDUMP PERFDATA NAME_SUBSTR  bucket samples into the largest code
                                           object whose name contains NAME_SUBSTR
                                           (plus all instances with the same name)
"""
import struct, sys, subprocess, collections, bisect

def loads(path):
    f = open(path, 'rb').read()
    _magic, _ver, hsize = struct.unpack_from('<III', f, 0)
    off, out = hsize, []
    while off + 16 <= len(f):
        rid, tsize, _ts = struct.unpack_from('<IIQ', f, off)
        if tsize == 0:
            break
        if rid == 0:  # JIT_CODE_LOAD
            _pid, _tid, _vma, caddr, csize, _idx = struct.unpack_from('<IIQQQQ', f, off + 16)
            p = off + 16 + 40
            e = f.index(b'\0', p)
            out.append((f[p:e].decode(errors='replace'), caddr, csize, f[e + 1:e + 1 + csize]))
        off += tsize
    return out

def disasm(code, addr):
    open('/tmp/rxprof/fn.bin', 'wb').write(code)
    r = subprocess.run(['objdump', '-D', '-b', 'binary', '-mi386:x86-64', '-M', 'intel',
                        f'--adjust-vma={addr:#x}', '/tmp/rxprof/fn.bin'],
                       capture_output=True, text=True).stdout
    ins = []
    for line in r.splitlines():
        parts = line.split('\t')
        if len(parts) >= 3 and parts[0].strip().endswith(':'):
            ins.append((int(parts[0].strip()[:-1], 16), parts[2].strip()))
    return ins

cmd = sys.argv[1]
L = loads(sys.argv[2])
if cmd == 'list':
    for n, a, s, _ in sorted(L, key=lambda l: -l[2])[:15]:
        print(f'{s:8d} {a:#x} {n}')
    sys.exit()

name = sys.argv[4]
cands = [l for l in L if name in l[0]]
big = max(cands, key=lambda l: l[2])
same = [l for l in cands if l[2] == big[2]]
print(f'# {big[0]}: {big[2]} B, {len(same)} instance(s)')
ips = subprocess.run(['perf', 'script', '-i', sys.argv[3], '-F', 'ip'],
                     capture_output=True, text=True).stdout.split()
ips = [int(x, 16) for x in ips if x]
total = len(ips)
# fold every instance onto offsets of the function
hist = collections.Counter()
infn = 0
for ip in ips:
    for _, a, s, _c in same:
        if a <= ip < a + s:
            hist[ip - a] += 1
            infn += 1
            break
print(f'# samples: total {total}, in function {infn} ({100.0 * infn / max(total, 1):.1f}%)')
ins = disasm(big[3], 0)
offs = [o for o, _ in ins]
per = collections.Counter()
for o, c in hist.items():
    i = bisect.bisect_right(offs, o) - 1
    per[i] += c
json_out = sys.argv[5] if len(sys.argv) > 5 else None
rows = [(i, ins[i][0], ins[i][1], per[i]) for i in range(len(ins))]
if json_out:
    with open(json_out, 'w') as fo:
        for i, o, t, c in rows:
            fo.write(f'{o:6x} {c:7d}  {t}\n')
top = sorted(rows, key=lambda r: -r[3])[:40]
for i, o, t, c in top:
    print(f'{o:6x} {c:7d} {100.0 * c / max(infn, 1):5.2f}%  {t}')
