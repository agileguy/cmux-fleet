#!/usr/bin/env python3
"""Verify that each `file:line` citation in an SRD points at text that supports it.

WHY THIS EXISTS. The v0.3 revision claimed a mechanical sweep of every citation.
That sweep only checked that the file existed and the line number was below EOF,
so four drifts survived it -- one of them a citation an earlier round had already
corrected once. This checks the thing that actually matters: does the cited RANGE
contain the token the prose attributes to it?

HOW IT DECIDES. A citation is checked only when it carries a TIGHT anchor:

  * a backticked identifier immediately before it   -- `workerBranch` (`paths.ts:603`)
  * a quoted phrase immediately after it            -- (`x.ts:12`: *"the quote"*)

Anything looser is reported UNANCHORED and is a human's to check, because a
paragraph-wide anchor search matches its neighbours' anchors and produces
confident nonsense. Precision over recall is deliberate: a checker that cries
wolf gets ignored, and being ignored is how the v0.3 sweep failed.

Exit 1 if any anchored citation FAILS. Unanchored citations never fail the run.
"""
import argparse
import os
import re
import sys

CITE = re.compile(r'`([A-Za-z0-9_./-]+\.(?:ts|tsx|yaml|yml|md|json|sh|cjs)):(\d+)(?:-(\d+))?`')
BEFORE = re.compile(r'`([A-Za-z_][A-Za-z0-9_.]{3,})`(?:[^`]{0,40})$')
AFTER = re.compile(r'^\s*[:,]?\s*\*?"([^"]{10,300})"')
AFTER_TICK = re.compile(r'^\s*(?:is|reads|declares|carries|says)\s+`([^`]{4,120})`')
SEARCH = ["", "src/", "src/run/", "src/config/", "src/cli/commands/", "src/backends/cmux/",
          "src/harvest/", "src/container/", "src/orchestrate/", "src/security/",
          "src/supervisor/", "src/safety/", "src/monitor/", "src/monitor/views/",
          "docker/", "roles/", "skills/pifleet-worker/", "test/unit/", "test/integration/", "Docs/"]


def norm(t):
    return re.sub(r'[\s’‘“”]+', ' ', t).replace("'", "'").strip().lower()


def resolve(root, path):
    p = os.path.join(root, path)
    if os.path.isfile(p):
        return p
    for d in SEARCH:
        c = os.path.join(root, d, os.path.basename(path))
        if os.path.isfile(c):
            return c
    return None


def contains(window, anchor):
    a = norm(anchor)
    if len(a) < 4 or a in {"write", "read", "bash", "edit", "true", "false", "null", "main", "yaml", "json", "node", "python", "base"}:
        return None
    if a in window:
        return True
    w = a.split()
    if len(w) >= 8:                       # long quote: accept a solid fragment
        return any(" ".join(w[i:i + 6]) in window for i in range(len(w) - 5))
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("doc")
    ap.add_argument("--root", default=".")
    ap.add_argument("--slack", type=int, default=15, help="lines of leeway around the cited range")
    ap.add_argument("--list-unanchored", action="store_true")
    a = ap.parse_args()
    s = open(a.doc, errors="replace").read()

    ok = fail = unanchored = offtree = 0
    problems, loose = [], []
    for m in CITE.finditer(s):
        path, lo = m.group(1), int(m.group(2))
        hi = int(m.group(3)) if m.group(3) else lo
        docline = s[:m.start()].count("\n") + 1
        label = f"{path}:{lo}" + (f"-{hi}" if hi != lo else "")
        real = resolve(a.root, path)
        if real is None:
            offtree += 1
            continue
        lines = open(real, errors="replace").read().split("\n")
        if hi > len(lines):
            fail += 1
            problems.append(f"L{docline} {label} PAST EOF (file has {len(lines)} lines)")
            continue

        anchors = []
        b = BEFORE.search(s[max(0, m.start() - 90):m.start()])
        if b:
            anchors.append(b.group(1))
        # A dotted config path (`run.budget`) is nested in YAML and never appears
        # literally; check its last segment instead. Same for `egress.allow`.
        anchors = [x.rsplit(".", 1)[-1] if (path.endswith((".yaml", ".yml")) and "." in x) else x
                   for x in anchors]
        # Drop anchors that are themselves filenames or bare hostnames: those come
        # from a neighbouring citation, not from this one.
        anchors = [x for x in anchors
                   if not re.search(r'\.(ts|tsx|yaml|yml|md|json|sh|cjs|com|org|net)$', x)]
        tail = s[m.end():m.end() + 340].replace("\n", " ")
        f = AFTER.match(tail)
        if f:
            anchors.append(f.group(1))
        ft = AFTER_TICK.match(tail)
        if ft:
            anchors.append(ft.group(1))
        if not anchors:
            unanchored += 1
            loose.append(f"L{docline} {label}")
            continue

        window = norm("\n".join(lines[max(0, lo - 1 - a.slack): hi + a.slack]))
        results = [contains(window, x) for x in anchors]
        if any(r is True for r in results):
            ok += 1
        elif all(r is None for r in results):
            unanchored += 1
            loose.append(f"L{docline} {label}")
        else:
            fail += 1
            shown = "; ".join(repr(x[:70]) for x, r in zip(anchors, results) if r is False)
            problems.append(f"L{docline} {label} -- anchor not in range: {shown}")

    print(f"verified {ok} | FAILED {fail} | unanchored {unanchored} | off-tree {offtree}")
    for p in problems:
        print("  FAIL", p)
    if a.list_unanchored:
        for p in loose:
            print("  unanchored", p)
    return 1 if fail else 0


if __name__ == "__main__":
    sys.exit(main())
