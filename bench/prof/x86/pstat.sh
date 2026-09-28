#!/usr/bin/env bash
# usage: pstat.sh "<events>" [bench flags...]  -> per-thread counts for the busiest thread
set -e
mkdir -p /tmp/rxprof
EV="$1"; shift
cd /mnt/vault/dny/RandomX-bonanza
node bench/bench_webui.mjs --threads 1 --init-threads 12 --duration 22 --quiet "$@" > /tmp/rxprof/bench.json 2>/dev/null &
BPID=$!
sleep 10
perf stat --per-thread -x, -p $BPID -e "$EV" -o /tmp/rxprof/ps.csv -- sleep 10
wait $BPID
grep -o '"hashrate":[0-9.]*' /tmp/rxprof/bench.json
# busiest thread = the one with the most cycles
TID=$(grep ',cycles' /tmp/rxprof/ps.csv | sort -t, -k2 -n | tail -1 | cut -d, -f1)
grep "^$TID," /tmp/rxprof/ps.csv | awk -F, '{printf "%-55s %15s\n", $4, $2}'
