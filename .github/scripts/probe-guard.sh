#!/usr/bin/env bash
#
# Run a set of test files and GRADE the result, rather than merely running it.
#
# ## Why this exists at all
#
# Several suites in this repo self-skip an entire file when an environment
# switch is unset: `PIFLEET_DOCKER=1` for the container suites, `PIFLEET_OMLX=1`
# for the live inference probes. A skip prints an announcement and still exits
# 0. So a green step has never, on its own, been evidence that a single probe
# actually ran — and four separate criteria in this project have at one time
# reported green having executed nothing at all. Arithmetic on the parsed
# summary, plus identity checks against a machine-readable report, is what turns
# "the command succeeded" into "the probes ran, and the ones that did not are
# the ones we said would not".
#
# ## Why it is a script and not inlined in ci.yml
#
# It used to be inlined, once, in the container job. It is now needed in two
# jobs with two different file sets, and duplicating sixty lines of subtle shell
# is precisely the drift that files criteria like ISC-257 and ISC-262: a parsing
# fix lands in one copy and not the other, and the copy nobody looked at goes
# quietly back to reporting green.
#
# Extraction buys a second thing that matters more: this guard can now be
# EXERCISED. `test/integration/probe-guard.test.ts` drives it against fixture
# suites and asserts it goes RED for each failure mode below — a dropped file, a
# renamed pin, a pinned test that ran, an unpinned test that skipped, a real
# failure. A guard nobody has tried to break is not a guard, and while this
# logic lived in YAML the only way to try was to push to CI and hope.
#
# ## Interface
#
#   Arguments : the test files to run, as `bun test` filters.
#   LABEL     : human name for this probe set, used in every message.
#   TOTAL_EXPECTED
#             : how many tests must be COLLECTED (pass + skip). See the total
#               check at the bottom for why collection, not passes, is the
#               number that catches a whole file falling out.
#   JUNIT_FILE: where to write the machine-readable report the identity checks
#               read. Must be writable.
#   EXPECTED_SKIPS
#             : newline-separated EXACT test names permitted to skip, or empty
#               to permit none. Blank lines are ignored so a YAML block scalar
#               can be pasted in directly.
#
# Exit 0 only when: no failures, no todos, bun exited 0, every name in
# EXPECTED_SKIPS is present in the report AND skipped, no OTHER test skipped,
# and exactly TOTAL_EXPECTED tests were collected.

set -eu

: "${LABEL:?probe-guard.sh needs LABEL naming the probe set, for its messages}"
: "${TOTAL_EXPECTED:?probe-guard.sh needs TOTAL_EXPECTED (tests collected = pass + skip)}"
: "${JUNIT_FILE:?probe-guard.sh needs JUNIT_FILE naming a writable path for the junit report}"
EXPECTED_SKIPS="${EXPECTED_SKIPS-}"

if [ "$#" -eq 0 ]; then
  echo "::error::probe-guard.sh was given no test files to run. That would grade an empty run as a pass."
  exit 1
fi

# Why a junit report and not a grep over the console text: bun's console
# reporter never prints individual skipped test NAMES, only the aggregate
# "N skip" summary line — measured, not assumed. A `test.skip`/`test.skipIf`
# case produces no per-test line at all in the default reporter, unlike a
# failure, which prints its name and a stack trace. Pinning skip IDENTITY
# therefore cannot be done from the console output no matter how it is parsed;
# it needs a structured side artifact. `--reporter=junit` is the cheapest one
# bun ships. Verified it does not change what runs or what the console prints —
# identical console output with and without the flag in every case tried — it
# only writes a second, structured report alongside the text captured below.
#
# THE BLACKHOLE BUG, and why this is `set +e` / capture-`$?` / `set -e` rather
# than a bare assignment under `set -e`. Under `set -e`, `out="$(bun test ...)"`
# aborts the WHOLE script the instant the command substitution returns
# non-zero: bash treats a failing command on the right-hand side of an
# assignment as a command failure like any other, and `set -e` kills the script
# at that statement — before `echo "$out"` on the next line ever runs.
# Reproduced directly: a failing container probe under the old script produced a
# RED step with ZERO output. Not a truncated stack trace — nothing. No test
# names, no `::error::` lines, not even bun's own summary, because the only
# place that output existed was the `$out` variable the aborted script never
# reached the `echo` for.
set +e
out="$(bun test "$@" --reporter=junit --reporter-outfile="$JUNIT_FILE" 2>&1)"
rc=$?
set -e
echo "$out"

# `sed`'s `$` end-of-line anchor below matches a literal end of line — but bun
# colors its summary lines with ANSI escape codes when it believes its output is
# going to a color-capable terminal, and a colored line ends in a reset sequence
# (`\x1b[0m`), not bare digits. This fails SAFE: with FORCE_COLOR=1 forced on,
# every anchored pattern comes back empty, the counts default to 0, and the
# total check at the bottom fails loudly rather than reporting a false pass.
# Stripping ANSI CSI sequences first is one extra `sed` pass and makes the
# counts actually right instead of merely non-lying, in case anything ever makes
# bun believe it has a tty here.
clean="$(printf '%s\n' "$out" | sed -E 's/\x1b\[[0-9;]*[A-Za-z]//g')"
pass="$(printf '%s\n' "$clean" | sed -n 's/^ *\([0-9][0-9]*\) pass$/\1/p' | tail -1)"
fail="$(printf '%s\n' "$clean" | sed -n 's/^ *\([0-9][0-9]*\) fail$/\1/p' | tail -1)"
skip="$(printf '%s\n' "$clean" | sed -n 's/^ *\([0-9][0-9]*\) skip$/\1/p' | tail -1)"
todo="$(printf '%s\n' "$clean" | sed -n 's/^ *\([0-9][0-9]*\) todo$/\1/p' | tail -1)"
: "${pass:=0}" "${fail:=0}" "${skip:=0}" "${todo:=0}"
total=$(( pass + skip ))
echo "parsed[$LABEL]: pass=$pass fail=$fail skip=$skip todo=$todo total=$total expected=$TOTAL_EXPECTED rc=$rc"

# `fail` and `todo` are checked FIRST, before `total` is ever consulted, and the
# order is the point. `total` is pass+skip, so a FAILING test does not produce a
# "wrong" total by itself — it makes `total` come up SHORT, indistinguishable,
# arithmetically, from a probe that was never added or a file that silently
# dropped out of collection. The guard's message would then read "expected N
# probes, N-3 were collected — update TOTAL_EXPECTED if probes were added",
# which is actively wrong advice when the real cause is three failures: it tells
# the reader to RAISE the constant to match the failure, papering over exactly
# the regression this check exists to catch.
if [ "$fail" -gt 0 ]; then
  echo "::error::$fail $LABEL probe(s) FAILED — see the bun output printed above for which ones and why. This is a real test failure, not a total-count drift: do not raise TOTAL_EXPECTED to make this message go away."
  exit 1
fi
if [ "$todo" -gt 0 ]; then
  echo "::error::$todo $LABEL probe(s) are test.todo() — a written-but-not-implemented test. Treat it as a real gap, not an accepted skip, and either finish the test or remove test.todo()."
  exit 1
fi
if [ "$rc" -ne 0 ]; then
  echo "::error::bun test exited $rc for $LABEL, for a reason the fail/todo checks above did not explain (both parsed as 0). Treat this as a real failure — see the full output above for what bun actually reported."
  exit 1
fi

# Identity, not arithmetic: confirm every name in EXPECTED_SKIPS appears in the
# junit report as a skip, by looking each one up directly, rather than trusting
# the aggregate skip COUNT to mean the right tests produced it. A probe
# elsewhere converting to `.skip`, paired with one of the pinned ones
# un-skipping, would leave `skip` at the same number while meaning something
# completely different — exactly the case a ceiling on count alone cannot
# detect. This is why the pins are names and not a MAX_*_SKIPS integer.
missing=0
expected_skip_count=0
while IFS= read -r name; do
  [ -z "$name" ] && continue
  expected_skip_count=$((expected_skip_count + 1))
  block="$(grep -A1 -F "name=\"$name\"" "$JUNIT_FILE" 2>/dev/null || true)"
  if [ -z "$block" ]; then
    echo "::error::[$LABEL] expected skip \"$name\" does not appear in the junit report at all. It may have been renamed or removed — confirm that before touching the pinned skip list."
    missing=1
    continue
  fi
  if ! printf '%s' "$block" | grep -q '<skipped'; then
    echo "::error::[$LABEL] expected skip \"$name\" RAN instead of skipping. Its gating condition changed, or this runner now satisfies a precondition it is not supposed to have. Do not simply delete the pin: work out which, and say so."
    missing=1
  fi
done <<< "$EXPECTED_SKIPS"
[ "$missing" -eq 0 ] || exit 1

if [ "$skip" -ne "$expected_skip_count" ]; then
  echo "::error::[$LABEL] $skip probes skipped, but exactly $expected_skip_count are pinned by name, and all $expected_skip_count were individually confirmed present and skipped. The mismatch means an UNPINNED probe skipped too — find it in the output above. A skip ceiling on count alone would have let this through as long as the count still matched."
  exit 1
fi

# The total check, last and on purpose: fail, todo, and the skip IDENTITY have
# all been confirmed clean above, so if `total` still does not match, none of
# those explain it — a test dropped out of COLLECTION entirely, before it could
# be counted as passing, failing, or skipping. The mechanism, measured directly
# against this invocation shape: `bun test fileA fileB` treats each argument as
# an independent filter, and a filter matching ZERO test files is silently
# dropped as long as at least one OTHER filter still matches something — no
# warning, exit code 0. (Measured again on 2026-08-19: even when EVERY filter
# matches nothing, bun prints "0 files were searched" and still exits 0.) Rename
# or delete any one file in a list and the rest still run fine; the only visible
# symptom is a lower `total` here. That is the entire reason this check exists,
# and it is the last thing standing between "the job is green" and "a whole
# file's worth of criteria silently stopped being tested".
#
# The same check catches the OPPOSITE drift, because those filters are
# SUBSTRING matches on the discovered path rather than paths. A new file whose
# name contains a listed one — `xrelay.test.ts` against a `relay.test.ts`
# filter — is swept in silently, and the only symptom is a HIGHER total. Both
# directions land here. (Measured 2026-08-19: `bun test pinned.test.ts` also
# collects `unpinned.test.ts`; see test/integration/probe-guard.test.ts, where
# it cost two red fixtures to find.)
if [ "$total" -ne "$TOTAL_EXPECTED" ]; then
  echo "::error::[$LABEL] expected $TOTAL_EXPECTED probes collected (pass+skip), got $total. fail=0, todo=0, and the skip set matches the pinned names exactly, so this is not a failure or an identity problem: a test dropped out of collection entirely, most likely because a listed file was renamed or deleted and its filter silently matched nothing. Confirm every file still exists under its exact name before raising TOTAL_EXPECTED to match a lower number."
  exit 1
fi

echo "ok[$LABEL]: $total probes accounted for (pass=$pass skip=$skip), fail=0, todo=0, and the skip set matches all $expected_skip_count pinned names exactly."
