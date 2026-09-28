#!/usr/bin/env bash
# A/B the threaded-interpreter generator on x86 under perf stat.
#
#   bench/prof/x86_ab.sh [-t "1 12"] [-d 15] [-D 9000] -- A_FLAGS -- B_FLAGS
#   e.g. bench/prof/x86_ab.sh -- --profile arm -- --profile x86 --fuse-n 800
#
# For each thread count T it runs A, then B (adjacent, fresh process each):
#   node bench/bench_webui.mjs --threads T --init-threads 12 --duration D --quiet --stats <flags>
# under perf stat -x, -D <ms> (counting starts after dataset init). Columns:
#   H/s       hashrate from bench_webui's JSON
#   disp/op   static dispatches per RandomX op (decoder counter, --stats)
#   misp%     indirect branch mispredicts / retired indirect branches
#             (ex_ret_brn_ind_misp / ex_ret_ind_brch_instr): the br_table
#   opc_hit%  op-cache hits / (hits + misses)
#   ICmiss/1k L1i misses (ic_tag_hit_miss.instruction_cache_miss) per 1000 instructions
# Needs kernel.perf_event_paranoid <= 0 and the Zen-family (Zen 2/3/4) event
# names above. 7 events on 6 PMCs multiplex: perf scales the counts, the
# ratios hold. This is a benchmark: run it only on an otherwise idle box.

set -euo pipefail
cd "$(dirname "$0")/../.."

usage() { sed -n '2,19p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

THREADS="1 12"
DURATION=15
DELAY=9000
while [ $# -gt 0 ]; do
	case "$1" in
	-t) THREADS="$2"; shift 2 ;;
	-d) DURATION="$2"; shift 2 ;;
	-D) DELAY="$2"; shift 2 ;;
	-h|--help) usage 0 ;;
	--) shift; break ;;
	*) echo "x86_ab.sh: unexpected '$1'" >&2; usage 2 ;;
	esac
done
A=""; B=""; side=A
for w in "$@"; do
	if [ "$w" = "--" ] && [ "$side" = A ]; then side=B; continue; fi
	if [ "$side" = A ]; then A="${A:+$A }$w"; else B="${B:+$B }$w"; fi
done
[ "$side" = B ] || { echo "x86_ab.sh: need '-- A_FLAGS -- B_FLAGS'" >&2; usage 2; }

NODE="${NODE:-node}"
EVENTS=cycles,instructions,ex_ret_ind_brch_instr,ex_ret_brn_ind_misp,op_cache_hit_miss.op_cache_hit,op_cache_hit_miss.op_cache_miss,ic_tag_hit_miss.instruction_cache_miss
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "A: ${A:-(defaults)}"
echo "B: ${B:-(defaults)}"
printf '%-3s %4s %9s %8s %7s %9s %10s\n' run T H/s disp/op misp% opc_hit% ICmiss/1k

run() { # label threads flags...
	local label=$1 t=$2; shift 2
	# shellcheck disable=SC2068 # flags are word-split on purpose
	if ! perf stat -x, -o "$TMP/perf.csv" -D "$DELAY" -e "$EVENTS" -- \
		"$NODE" bench/bench_webui.mjs --threads "$t" --init-threads 12 --duration "$DURATION" \
		--quiet --stats $@ >"$TMP/out.json" 2>"$TMP/err.txt"; then
		echo "$label T=$t: bench_webui failed:" >&2; tail -5 "$TMP/err.txt" >&2; return 1
	fi
	grep -m1 '^profile=' "$TMP/err.txt" >"$TMP/hdr_$label" || true
	local hs dpo
	hs=$(grep -o '"hashrate":[0-9.]*' "$TMP/out.json" | cut -d: -f2)
	dpo=$(grep -o 'dispatches/op=[0-9.]*' "$TMP/err.txt" | cut -d= -f2)
	awk -F, -v label="$label" -v t="$t" -v hs="${hs:--}" -v dpo="${dpo:--}" '
		$3 != "" && $1 ~ /^[0-9.]+$/ { v[$3] = $1 }
		function pct(a, b) { return (b > 0) ? sprintf("%.1f", 100 * a / b) : "-" }
		END {
			ind = v["ex_ret_ind_brch_instr"]; misp = v["ex_ret_brn_ind_misp"]
			hit = v["op_cache_hit_miss.op_cache_hit"]; miss = v["op_cache_hit_miss.op_cache_miss"]
			ins = v["instructions"]; icm = v["ic_tag_hit_miss.instruction_cache_miss"]
			ic = (ins > 0 && icm != "") ? sprintf("%.2f", 1000 * icm / ins) : "-"
			printf "%-3s %4s %9s %8s %7s %9s %10s\n", label, t, hs, dpo, pct(misp, ind), pct(hit, hit + miss), ic
		}' "$TMP/perf.csv"
}

for t in $THREADS; do
	run A "$t" $A
	run B "$t" $B
done
echo "A = $(cat "$TMP/hdr_A")"
echo "B = $(cat "$TMP/hdr_B")"
