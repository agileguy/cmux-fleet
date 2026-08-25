#!/bin/sh
# Linux bind-mount permission semantics for a non-root container uid.
# Runs ENTIRELY inside a Linux container so macOS's ownership squash — the
# thing that hides this failure on the operator's laptop — is not in the path.
set -u
UID_WORKER=10001

try() { # label, command
  if su_out=$(setpriv --reuid=$UID_WORKER --regid=$UID_WORKER --clear-groups sh -c "$2" 2>&1); then
    printf '    %-28s OK\n' "$1"
  else
    printf '    %-28s FAIL  %s\n' "$1" "$(echo "$su_out" | head -1 | cut -c1-58)"
  fi
}

scenario() { # label, dirmode, filemode
  d=/tmp/case-$2-$3
  rm -rf "$d"; mkdir -p "$d"
  # Files created by the HOST uid (root here, the runner's uid in CI) —
  # exactly what `git checkout` leaves behind.
  echo 'function add(a,b){return a+b}' > "$d/add.js"
  chmod "$3" "$d/add.js"
  chmod "$2" "$d"
  printf '\n  %s  (dir %s, file %s)\n' "$1" "$2" "$3"
  try "write existing in place"  "printf 'x' > $d/add.js"
  try "create NEW file"          "printf 'y' > $d/new.js"
  try "sed -i existing"          "cd $d && sed -i 's/add/sub/' add.js"
  try "rm + recreate"            "cd $d && rm -f add.js && printf 'z' > add.js"
  try "chmod existing"           "chmod 666 $d/add.js"
}

echo "=== what a uid-$UID_WORKER worker can do to a host-owned checkout ==="
scenario "AS SHIPPED — no widening"            0755 0644
scenario "RELOCATE ONLY — dir widened"         0777 0644
scenario "RELOCATE + RECURSIVE widening"       0777 0666
