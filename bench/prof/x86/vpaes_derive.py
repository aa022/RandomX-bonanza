#!/usr/bin/env python3
# Derives and exhaustively checks the vpaes nibble tables in wasm/src/src/soft_aes.cpp
# (rx_aes_simd_tab): AES S-box and inverse S-box on all 256 bytes. Prints the tables.
import struct
def q2b(lo, hi): return list(struct.pack('<QQ', lo, hi))
k_inv  = q2b(0x0E05060F0D080180, 0x040703090A0B0C02)
k_inva = q2b(0x01040A060F0B0780, 0x030D0E0C02050809)
ipt_lo = q2b(0xC2B2E8985A2A7000, 0xCABAE09052227808)
ipt_hi = q2b(0x4C01307D317C4D00, 0xCD80B1FCB0FDCC81)
def swz(t, i):
    if i < 16: return t[i]
    assert i >= 0x80, hex(i)
    return 0
# GF(2^8)
def gmul(a, b):
    r = 0
    while b:
        if b & 1: r ^= a
        a <<= 1
        if a & 0x100: a ^= 0x11b
        b >>= 1
    return r
inv = [0]*256
for x in range(1,256):
    for y in range(1,256):
        if gmul(x,y) == 1: inv[x] = y; break
def rotl8(x, s): return ((x << s) | (x >> (8-s))) & 0xff
def Alin(x): return x ^ rotl8(x,1) ^ rotl8(x,2) ^ rotl8(x,3) ^ rotl8(x,4)
SBOX = [Alin(inv[x]) ^ 0x63 for x in range(256)]
assert SBOX[0] == 0x63 and SBOX[1] == 0x7c and SBOX[0x53] == 0xed
Ainv = [0]*256
for x in range(256): Ainv[Alin(x)] = x
INV_SBOX = [0]*256
for x in range(256): INV_SBOX[SBOX[x]] = x
def ipt(x): return ipt_lo[x & 15] ^ ipt_hi[x >> 4]
# check ipt linear & bijective
for a in range(256):
    for b in range(0,256,17):
        assert ipt(a ^ b) == ipt(a) ^ ipt(b)
assert len(set(ipt(x) for x in range(256))) == 256
def core(z):
    i = z >> 4; k = z & 15
    ak = swz(k_inva, k)
    j = i ^ k
    iak = swz(k_inv, i) ^ ak
    jak = swz(k_inv, j) ^ ak
    io = swz(k_inv, iak) ^ j
    jo = swz(k_inv, jak) ^ i
    return io, jo
# solve T1[io]^T2[jo] = inv(x) via GF(2) elimination on 32 byte-unknowns (per bit-vector: treat bytes as values, rows are 32-bit masks)
rows = []
for x in range(256):
    io, jo = core(ipt(x))
    m = 0
    if io < 16: m |= 1 << io
    if jo < 16: m |= 1 << (16 + jo)
    rows.append((m, inv[x]))
# gaussian elimination: unknown vector of bytes
piv = {}
for m, v in rows:
    for p in sorted(piv, reverse=True):
        if m >> p & 1:
            pm, pv = piv[p]; m ^= pm; v ^= pv
    if m == 0:
        assert v == 0, "inconsistent"
        continue
    p = m.bit_length() - 1
    # reduce others
    for q in list(piv):
        qm, qv = piv[q]
        if qm >> p & 1: piv[q] = (qm ^ m, qv ^ v)
    piv[p] = (m, v)
sol = [0]*32
for p in sorted(piv):
    m, v = piv[p]
    # free vars = 0; m has pivot p as highest bit, others lower bits that are pivots or free
    # since fully reduced, lower bits are free vars -> 0
    sol[p] = v
T1, T2 = sol[:16], sol[16:]
for x in range(256):
    io, jo = core(ipt(x))
    assert swz(T1, io) ^ swz(T2, jo) == inv[x]
print("inverse ok; pivots", len(piv))
E1 = [Alin(t) for t in T1]; E2 = [Alin(t) for t in T2]
c = ipt(Ainv[0x63])
d_lo = [ipt(Ainv[n]) ^ c for n in range(16)]
d_hi = [ipt(Ainv[n << 4]) for n in range(16)]
for x in range(256):
    io, jo = core(ipt(x)); assert swz(E1, io) ^ swz(E2, jo) ^ 0x63 == SBOX[x]
    z = d_lo[x & 15] ^ d_hi[x >> 4]
    io, jo = core(z); assert swz(T1, io) ^ swz(T2, jo) == INV_SBOX[x]
print("sbox / inv sbox ok")
def fmt(name, t): return "static const uint8_t %s[16] = {%s};" % (name, ", ".join("0x%02x" % b for b in t))
for n, t in [("k_inv", k_inv), ("k_inva", k_inva), ("k_ipt_lo", ipt_lo), ("k_ipt_hi", ipt_hi), ("k_dipt_lo", d_lo), ("k_dipt_hi", d_hi), ("k_sbo_u", E1), ("k_sbo_t", E2), ("k_dsbo_u", T1), ("k_dsbo_t", T2)]:
    print(fmt(n, t))
