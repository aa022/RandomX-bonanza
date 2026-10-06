import sys, subprocess, collections, bisect
sys.path.insert(0, '/tmp/rxprof')
import importlib.util
spec = importlib.util.spec_from_file_location('jd', '/tmp/rxprof/jd.py')
# reuse loader without running main: copy the function
import struct
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
            out.append((caddr, csize, f[p:e].decode(errors='replace')))
        off += tsize
    return out
L = sorted(loads(sys.argv[1]))
starts = [a for a, _, _ in L]
lines = subprocess.run(['perf', 'script', '-i', sys.argv[2], '-F', 'tid,time,ip,dso'], capture_output=True, text=True).stdout.splitlines()
bytid = collections.defaultdict(collections.Counter)
for ln in lines:
    p = ln.split()
    if len(p) < 2: continue
    tid, t, ip = p[0], float(p[1].rstrip(':')), int(p[2], 16)
    dso = p[3] if len(p) > 3 else '?'
    T0 = globals().setdefault('T0', t)
    if t - T0 < float(sys.argv[3]): continue
    i = bisect.bisect_right(starts, ip) - 1
    if i >= 0 and ip < L[i][0] + L[i][1]:
        n = L[i][2].replace('JS:', '')
    else:
        n = 'native:' + dso.strip('()').split('/')[-1]
    bytid[tid][n] += 1
tid = max(bytid, key=lambda t: bytid[t].get('wasm-function[22]-22-turbofan', 0))
c = bytid[tid]; tot = sum(c.values())
print(f'mining tid {tid}: {tot} samples')
for n, k in c.most_common(14):
    print(f'{100.0*k/tot:6.2f}%  {n}')
