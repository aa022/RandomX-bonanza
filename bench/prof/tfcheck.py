#!/usr/bin/env python3
"""tfcheck.py DUMP [--index N] [--header] [--grep REGEX ...]

Summarise the TurboFan inner_dispatch in a `node --print-wasm-code` dump.
Picks the largest TurboFan block whose wasm function index is N (default 22 =
the production inner_dispatch; pass --index 6 for the synth probes, or
--index -1 for "largest TurboFan function containing br x16"). Reports:
  - total instructions
  - dispatch sites (`br x16`), calls (`bl`/`blr`), [sp] loads/stores
  - `movk` count (materialised >16-bit constants, e.g. the vm_state base)
  - `mov wN, wM` count (zero-extension moves; should be ~0 in the header)
  - the header listing (stack check .. first `br x16`) with --header
  - counts of any --grep regex
Usage example (1T, real module):
  node --print-wasm-code bench/bench_webui.mjs --threads 1 --init-threads 10 \
       --duration 20 --quiet > /tmp/code.txt 2>&1
  python3 tfcheck.py /tmp/code.txt --header
"""
import re, sys

args = sys.argv[1:]
path = args[0]
idx = int(args[args.index('--index') + 1]) if '--index' in args else 22
if idx < 0: idx = None
greps = [args[i + 1] for i, a in enumerate(args) if a == '--grep']
txt = open(path, errors='replace').read()
best = None
for b in txt.split('--- WebAssembly code ---')[1:]:
    m = re.search(r'^index: (\d+)', b, re.M)
    c = re.search(r'compiler: (\S+)', b)
    if not (m and c and c.group(1) == 'TurboFan'):
        continue
    rows = [t.strip() for t in re.findall(r'^0x[0-9a-f]+\s+[0-9a-f]+\s+[0-9a-f]{8}\s+(.*)$', b, re.M)]
    if idx is not None:
        if int(m.group(1)) == idx and (best is None or len(rows) > len(best[1])):
            best = (int(m.group(1)), rows)
        continue
    if any(re.match(r'br x16', r) for r in rows) and (best is None or len(rows) > len(best[1])):
        best = (int(m.group(1)), rows)
if best is None:
    sys.exit('no matching TurboFan function')
fi, rows = best
n = len(rows)
cnt = lambda rx: sum(1 for r in rows if re.search(rx, r))
print(f'function index {fi}: {n} instructions')
print(f'  dispatch sites (br x16): {cnt(r"^br x16")}')
print(f'  calls (bl/blr):          {cnt(r"^(bl|blr) ")}')
print(f'  [sp] stores / loads:     {cnt(r"^(str|stp|stur)\b.*\[sp")} / {cnt(r"^(ldr|ldp|ldur)\b.*\[sp")}')
print(f'  movk:                    {cnt(r"^movk ")}')
print(f'  mov wN, wM:              {cnt(r"^mov w\d+, w\d+$")}')
for g in greps:
    print(f'  /{g}/: {cnt(g)}')
if '--header' in args:
    for i, r in enumerate(rows):
        if re.match(r'^br x16', r):
            j = i
            while j > 0 and '[x26, #-' not in rows[j]:
                j -= 1
            print('  header (%d instructions):' % (i - j + 1))
            for rr in rows[j:i + 1]:
                print('    ' + rr)
            break
