#!/usr/bin/env bash
#
# Run a test file or suite while the machine is deliberately busy (ISC-266).
#
# WHY THIS EXISTS. ISC-266 is about per-test time budgets that were inherited
# from bun's 5000 ms default rather than derived from the work. A budget like
# that cannot be judged by re-running the suite on a quiet box until it passes —
# a quiet box is precisely the condition under which the defect is invisible.
# The tests it describes measured 1.3-3.7 s idle, which looks fine, and reached
# 5001-9991 ms under load, which is red. So the evidence for "this budget is
# adequate" has to be produced under contention, on purpose and repeatably.
# That is what this script is: the load is a parameter of the experiment, not
# an accident of whatever else the machine happened to be doing.
#
# HOW MUCH LOAD, AND WHY THAT MUCH. The default is ceil(cores * 0.75) busy
# loops. On the 14-core machine the ISC-266 numbers were measured on that is 11
# loops, which reproduces the original probe (ten loops -> 2.09x-2.98x per-test
# inflation, 2.50x overall). It is deliberately NOT `cores` or higher: the goal
# is a machine under real contention that still schedules the test process
# regularly, which is the situation a developer is actually in when running the
# suite alongside an editor, a language server and a browser. ISC-266 itself
# recorded load average 18.40 on those 14 cores, so this default is a floor for
# what a developer machine does, not a worst case. Override with LOAD_PROCS to
# push past it.
#
# WHY IT SCALES WITH CORE COUNT. A fixed count would mean something different on
# every machine — ten loops is heavy contention on 4 cores and mild on 32. What
# is being held constant across machines is the RATIO of busy work to available
# parallelism, because that is what determines how much the test process has to
# wait.
#
# LEAK SAFETY IS THE POINT OF THE STRUCTURE BELOW, not a detail of it. An
# earlier session of this work left sixteen busy loops spinning on a developer's
# machine after the run that started them had finished. Three independent things
# prevent that here, and the script is written the way it is because of it:
#
#   1. Every generator SELF-TERMINATES. Each loop is bounded by a deadline it
#      checks itself (`while [ $SECONDS -lt $end ]`), so it dies on its own even
#      if this script is killed with SIGKILL and no trap ever runs.
#   2. A trap kills them EXPLICITLY on EXIT, INT and TERM, so the normal path
#      and the Ctrl-C path both clean up immediately rather than waiting out
#      the deadline.
#   3. The exit path VERIFIES, and says what it found. A cleanup that is not
#      checked is a cleanup nobody knows failed.
#
# The trap kills a recorded list of PIDs, never `jobs -p`: `jobs` is empty in a
# non-interactive shell whose job control is off, so a `kill $(jobs -p)` trap
# reads as correct, exits 0, and reliably kills nothing. That is very close to
# how the original leak happened.
#
# USAGE
#   .github/scripts/test-under-load.sh [test-path ...]
#   LOAD_PROCS=20 .github/scripts/test-under-load.sh test/integration/foo.test.ts
#   LOAD_SECONDS=600 .github/scripts/test-under-load.sh
#
# Exit code is the test run's own: this is a gate, and a suite that fails under
# load must fail the script.

set -uo pipefail

cd "$(dirname "$0")/../.." || exit 1

# ---------------------------------------------------------------- core count
# `nproc` on Linux (this must run on ubuntu-latest, where CI runs), `sysctl` on
# macOS (where the ISC-266 measurements were taken). Both absent is not fatal —
# a conservative 4 keeps the script usable rather than making load generation a
# hard dependency on coreutils.
if command -v nproc >/dev/null 2>&1; then
  CORES=$(nproc)
elif sysctl -n hw.ncpu >/dev/null 2>&1; then
  CORES=$(sysctl -n hw.ncpu)
else
  CORES=4
  echo "warning: neither nproc nor sysctl available; assuming ${CORES} cores" >&2
fi

# ceil(CORES * 3 / 4), floored at 1 so a single-core runner still applies load.
LOAD_PROCS=${LOAD_PROCS:-$(( (CORES * 3 + 3) / 4 ))}
[ "$LOAD_PROCS" -lt 1 ] && LOAD_PROCS=1

# The deadline is the generators' own kill switch (see 1 above), so it must
# outlast the run it is covering. 900s is comfortably past the slowest budget in
# the repo (a 600_000 ms relay test) without being effectively unbounded.
LOAD_SECONDS=${LOAD_SECONDS:-900}

TARGETS=("$@")
[ ${#TARGETS[@]} -eq 0 ] && TARGETS=("test/integration")

# ------------------------------------------------------------------- cleanup
LOAD_PIDS=()

stop_load() {
  # Idempotent: EXIT fires after INT/TERM have already run this.
  [ ${#LOAD_PIDS[@]} -eq 0 ] && return 0
  for pid in "${LOAD_PIDS[@]}"; do
    kill "$pid" 2>/dev/null
  done
  # Reap so the shell does not report them, and so the verification below is
  # not racing processes that are already on their way out.
  for pid in "${LOAD_PIDS[@]}"; do
    wait "$pid" 2>/dev/null
  done
  LOAD_PIDS=()
}
trap stop_load EXIT INT TERM

# --------------------------------------------------------------------- start
echo "=== test-under-load (ISC-266) ==="
echo "cores:        ${CORES}"
echo "load procs:   ${LOAD_PROCS}  (ceil(cores * 0.75); override with LOAD_PROCS)"
echo "self-kill in: ${LOAD_SECONDS}s"
echo "targets:      ${TARGETS[*]}"
echo

for _ in $(seq 1 "$LOAD_PROCS"); do
  # Self-terminating by construction. `$SECONDS` is the subshell's own age, so
  # this needs no external clock and no coordination with the parent.
  (
    end=$((SECONDS + LOAD_SECONDS))
    while [ $SECONDS -lt $end ]; do :; done
  ) &
  LOAD_PIDS+=("$!")
done

echo "load generators up: ${LOAD_PIDS[*]}"

# Let the loops actually reach the CPU before the measurement starts; without
# this the first test runs on a machine that is only nominally busy.
sleep 2
echo "load average now: $(uptime | sed 's/.*[Ll]oad [Aa]verages*: //')"
echo

# ---------------------------------------------------------------------- run
# No --timeout: the entire point is to exercise the budgets the tests carry
# themselves. Passing one here would override them and prove nothing.
bun test "${TARGETS[@]}"
STATUS=$?

echo
echo "=== result: $([ $STATUS -eq 0 ] && echo PASS || echo FAIL) (exit ${STATUS}) ==="

# --------------------------------------------------------------- verification
stop_load

# Prove the machine was left as it was found. `pcpu` is an average over each
# process's lifetime rather than an instantaneous sample, so a loop that has
# only just been killed can still be listed; give the kills a moment to land
# before believing the output.
sleep 1
echo
echo "=== leftover busy processes (>50% CPU) ==="
LEFTOVER=$(ps -eo pid,pcpu,command | awk '$2>50')
if [ -n "$LEFTOVER" ]; then
  echo "$LEFTOVER"
  echo "WARNING: processes above are still busy. If any is a shell loop from"
  echo "this script, its PID will appear in the generator list printed above."
else
  echo "(none)"
fi

exit $STATUS
