#!/usr/bin/env bash
# ARM sign-off for the x86 generator profile (Apple M4; no perf needed).
#
#   bench/arm_ab.sh [-t "1 10"] [-d 15] [-i 10] [-r 1] [-- A_FLAGS -- B_FLAGS]
#   default: A = --profile arm, B = --profile x86
#
# For each round and thread count T it runs A, then B (adjacent, fresh process each):
#   node bench/bench_webui.mjs --threads T --init-threads I --duration D --quiet --stats <flags>
# and prints H/s and static dispatches/op per run, then the mean B/A ratio per T.
#
# "Neutral or better": B/A >= 0.98 at every T (1T and 10T). Then the x86
# profile values may become the global default (auto = x86 everywhere);
# otherwise auto keeps ARM on arm. One M4 run spreads about +-7% at 1T and
# +-12% at 10T (opus_handoff.md): if a ratio lands within 0.90..1.10, rerun
# with -r 3 (interleaved rounds, means compared) before deciding.
# This is a benchmark: run it only on an otherwise idle machine.
# Works with macOS bash 3.2.

set -euo pipefail
cd "$(dirname "$0")/.."

usage() { sed -n '2,18p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

THREADS="1 10"
DURATION=15
INIT=10
ROUNDS=1
while [ $# -gt 0 ]; do
	case "$1" in
	-t) THREADS="$2"; shift 2 ;;
	-d) DURATION="$2"; shift 2 ;;
	-i) INIT="$2"; shift 2 ;;
	-r) ROUNDS="$2"; shift 2 ;;
	-h|--help) usage 0 ;;
	--) shift; break ;;
	*) echo "arm_ab.sh: unexpected '$1'" >&2; usage 2 ;;
	esac
done
A="--profile arm"; B="--profile x86"
if [ $# -gt 0 ]; then
	A=""; B=""; side=A
	for w in "$@"; do
		if [ "$w" = "--" ] && [ "$side" = A ]; then side=B; continue; fi
		if [ "$side" = A ]; then A="${A:+$A }$w"; else B="${B:+$B }$w"; fi
	done
	[ "$side" = B ] || { echo "arm_ab.sh: need '-- A_FLAGS -- B_FLAGS'" >&2; usage 2; }
fi

NODE="${NODE:-node}"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
: >"$TMP/rows"

echo "A: ${A:-(defaults)}"
echo "B: ${B:-(defaults)}"
printf '%-3s %5s %4s %9s %8s\n' run round T H/s disp/op

run() { # label round threads "flags" (one string: an empty "$@" trips set -u in bash 3.2)
	local label=$1 r=$2 t=$3 flags=$4
	# shellcheck disable=SC2086 # flags are word-split on purpose
	if ! "$NODE" bench/bench_webui.mjs --threads "$t" --init-threads "$INIT" --duration "$DURATION" \
		--quiet --stats $flags >"$TMP/out.json" 2>"$TMP/err.txt"; then
		echo "$label T=$t: bench_webui failed:" >&2; tail -5 "$TMP/err.txt" >&2; return 1
	fi
	grep -m1 '^profile=' "$TMP/err.txt" >"$TMP/hdr_$label" || true
	local hs dpo
	hs=$(grep -o '"hashrate":[0-9.]*' "$TMP/out.json" | cut -d: -f2)
	dpo=$(grep -o 'dispatches/op=[0-9.]*' "$TMP/err.txt" | cut -d= -f2)
	printf '%-3s %5s %4s %9s %8s\n' "$label" "$r" "$t" "${hs:--}" "${dpo:--}"
	echo "$label $t ${hs:-0}" >>"$TMP/rows"
}

r=1
while [ "$r" -le "$ROUNDS" ]; do
	for t in $THREADS; do
		run A "$r" "$t" "$A"
		run B "$r" "$t" "$B"
	done
	r=$((r + 1))
done
echo "A = $(cat "$TMP/hdr_A")"
echo "B = $(cat "$TMP/hdr_B")"
awk -v order="$THREADS" '
	{ s[$1 " " $2] += $3; n[$1 " " $2]++ }
	END {
		ok = 1; nt = split(order, ts, " ")
		for (i = 1; i <= nt; i++) {
			t = ts[i]
			a = n["A " t] ? s["A " t] / n["A " t] : 0
			b = n["B " t] ? s["B " t] / n["B " t] : 0
			q = (a > 0) ? b / a : 0
			if (q < 0.98) ok = 0
			printf "T=%-3s A %8.2f  B %8.2f  B/A %.3f  %s\n", t, a, b, q, (q >= 0.98) ? "neutral or better" : "WORSE"
		}
		if (ok) print "=> B is neutral or better at every T: its values may become the global default"
		else    print "=> B is worse at some T: auto keeps ARM on A (rerun with -r 3 if within noise)"
	}' "$TMP/rows"
