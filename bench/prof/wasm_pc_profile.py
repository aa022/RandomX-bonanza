#!/usr/bin/env python3
"""Instruction-level profile of V8-generated wasm code on macOS (xctrace + --print-wasm-code).

Record (1 mining thread, machine code printed into the same process's address space):
  xctrace record --template 'CPU Counters' --output /tmp/rxprof/run.trace --time-limit 30s \
    --target-stdout /tmp/rxprof/code.txt --launch -- $(which node) --print-wasm-code \
    bench/bench_webui.mjs --threads 1 --init-threads 10 --duration 15 --quiet
  xctrace export --input /tmp/rxprof/run.trace \
    --xpath '/trace-toc/run[@number="1"]/data/table[@schema="time-sample"]' --output /tmp/rxprof/samples.xml
  # bottleneck split (useful / processing / delivery / discarded) per thread:
  xctrace export --input /tmp/rxprof/run.trace \
    --xpath '/trace-toc/run[@number="1"]/data/table[@schema="CounterMetricByThread"]' --output /tmp/rxprof/bythread.xml

Analyse:
  wasm_pc_profile.py functions CODE SAMPLES            # per-function share, mining thread, mining window
  wasm_pc_profile.py hot CODE SAMPLES [N]              # hottest N instructions of the hottest function
  wasm_pc_profile.py range CODE SAMPLES LO HI          # annotated listing, offsets in hex
  wasm_pc_profile.py bottleneck BYTHREAD_XML           # per-thread bottleneck split

Notes: the mining thread is the em-pthread with most samples in the largest TurboFan function;
the first 2 s after its first dispatch sample are skipped (init/warm-up). Apple PMI samples skid
onto the instruction after a stall / onto branch targets (loop head, arm-exit join), so read
clusters, not single lines.
"""
import bisect
import collections
import re
import sys


def load_code(path):
    blocks = []
    for b in open(path, errors='replace').read().split('--- WebAssembly code ---')[1:]:
        name = re.search(r'name: (.*)', b)
        comp = re.search(r'compiler: (.*)', b)
        ins = re.findall(r'^(0x[0-9a-f]+)\s+([0-9a-f]+)\s+[0-9a-f]{8}\s+(.*)$', b, re.M)
        if not ins:
            continue
        addrs = [int(a, 16) for a, _, _ in ins]
        lab = f"{name.group(1) if name else '?'}/{comp.group(1) if comp else '?'}/n{len(ins)}"
        blocks.append((min(addrs), max(addrs) + 4, lab,
                       {int(a, 16): (int(o, 16), t) for a, o, t in ins}))
    blocks.sort()
    return blocks


def load_samples(path):
    rows = re.findall(r'<row>(.*?)</row>', open(path).read(), re.S)
    bt, thr, times, out = {}, {}, {}, []
    for r in rows:
        m = re.search(r'<sample-time id="(\d+)"[^>]*>(\d+)<', r)
        if m:
            times[m.group(1)] = t = int(m.group(2))
        else:
            m = re.search(r'<sample-time ref="(\d+)"/>', r)
            t = times.get(m.group(1)) if m else None
        m = re.search(r'<thread id="(\d+)" fmt="([^"]*)"', r)
        if m:
            thr[m.group(1)] = tn = m.group(2)
        else:
            m = re.search(r'<thread ref="(\d+)"/>', r)
            tn = thr.get(m.group(1), '') if m else ''
        m = re.search(r'<kperf-bt id="(\d+)" fmt="PC:(0x[0-9a-f]+)', r)
        if m:
            bt[m.group(1)] = pc = int(m.group(2), 16)
        else:
            m = re.search(r'<kperf-bt ref="(\d+)"/>', r)
            pc = bt.get(m.group(1)) if m else None
        if pc is not None and t is not None:
            out.append((t, tn, pc))
    return out


def mining_pcs(blocks, samples):
    starts = [b[0] for b in blocks]

    def blk(pc):
        i = bisect.bisect_right(starts, pc) - 1
        return i if i >= 0 and blocks[i][0] <= pc < blocks[i][1] else -1

    tf = [i for i, b in enumerate(blocks) if '/TurboFan/' in b[2]]
    biggest = max(tf, key=lambda i: len(blocks[i][3]))
    hits = [(t, tn) for t, tn, pc in samples if blk(pc) == biggest]
    tn = collections.Counter(x for _, x in hits).most_common(1)[0][0]
    t0 = min(t for t, x in hits if x == tn) + 2_000_000_000
    pcs = collections.Counter(pc for t, x, pc in samples if x == tn and t >= t0)
    return pcs, blk, biggest


def main():
    cmd = sys.argv[1]
    if cmd == 'bottleneck':
        s = open(sys.argv[2]).read()
        acc = collections.defaultdict(lambda: [0, [0, 0, 0, 0]])
        ids = {}
        for b in re.findall(r'<row>(.*?)</row>', s, re.S):
            vals = {}
            for tag in ('duration', 'thread', 'uint64-array', 'core'):
                m = re.search(r'<%s id="(\d+)"(?: fmt="([^"]*)")?>(.*?)</%s>' % (tag, tag), b, re.S)
                if m:
                    ids[(tag, m.group(1))] = vals[tag] = (m.group(2), m.group(3))
                else:
                    m = re.search(r'<%s ref="(\d+)"/>' % tag, b)
                    vals[tag] = ids.get((tag, m.group(1))) if m else None
            if not (vals['duration'] and vals['thread'] and vals['uint64-array']):
                continue
            v = [int(x) for x in vals['uint64-array'][1].split()]
            if len(v) != 4:
                continue
            ct = 'P' if vals['core'] and 'P Core' in vals['core'][0] else 'E'
            a = acc[(vals['thread'][0].split(' (node')[0], ct)]
            d = int(vals['duration'][1])
            a[0] += d
            for i in range(4):
                a[1][i] += v[i] * d
        print('thread                                   core   time   useful processing delivery discarded')
        for (k, ct), (d, v) in sorted(acc.items(), key=lambda x: -x[1][0])[:8]:
            print(f"{k[:40]:40s} {ct} {d / 1e9:7.2f}s " + ' '.join(f"{x / d / 100:8.1f}%" for x in v))
        return
    blocks = load_code(sys.argv[2])
    pcs, blk, biggest = mining_pcs(blocks, load_samples(sys.argv[3]))
    total = sum(pcs.values())
    if cmd == 'functions':
        per = collections.Counter()
        for pc, n in pcs.items():
            per[blk(pc)] += n
        print(f"mining-thread samples: {total}")
        for i, n in per.most_common(15):
            lab = f"{blocks[i][2]} @{hex(blocks[i][0])}" if i >= 0 else 'native / unprinted stubs'
            print(f"{n:7d} {100 * n / total:5.1f}%  {lab}")
        return
    st, en, lab, ins = blocks[biggest]
    ftot = sum(pcs.get(a, 0) for a in ins)
    if cmd == 'hot':
        n = int(sys.argv[4]) if len(sys.argv) > 4 else 40
        print(f"{lab}: {ftot} samples")
        for a in sorted(ins, key=lambda a: -pcs.get(a, 0))[:n]:
            print(f"{pcs.get(a, 0):6d} {100 * pcs.get(a, 0) / ftot:5.1f}% {ins[a][0]:5x} {ins[a][1]}")
    elif cmd == 'range':
        lo, hi = int(sys.argv[4], 16), int(sys.argv[5], 16)
        for a in sorted(ins):
            o, t = ins[a]
            if lo <= o <= hi:
                print(f"{pcs.get(a, 0):6d} {o:5x} {t}")


if __name__ == '__main__':
    main()
