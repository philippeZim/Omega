#!/usr/bin/env bash
# dev/heavy.sh <command...> — runs a CPU/RAM-heavy command (dev/check.sh, cargo) in one of 4 global
# slots, so many parallel agents don't thrash the machine. Waits until a slot is free.
slots=4
while true; do
  for i in $(seq 1 $slots); do
    exec {fd}>"${TMPDIR:-/tmp}/omega-heavy-$i.lock"
    if flock -n "$fd"; then "$@"; rc=$?; flock -u "$fd"; exit $rc; fi
    exec {fd}>&-
  done
  sleep 3
done
