#!/bin/sh
set -u
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq >/dev/null 2>&1; apt-get install -y -qq git >/dev/null 2>&1
U=10001

build() { d=$1; rm -rf "$d"; mkdir -p "$d"
  git -C "$d" init -q -b main
  git -C "$d" config user.email f@t; git -C "$d" config user.name f
  echo 'function add(a,b){return a+b}' > "$d/add.js"
  git -C "$d" add -A; git -C "$d" commit -qm base; }

try() { printf '    %-26s ' "$1"
  if o=$(setpriv --reuid=$2 --regid=$2 --clear-groups sh -c "$3" 2>&1); then echo OK
  else echo "FAIL  $(echo "$o" | head -1 | cut -c1-50)"; fi; }

suite() { printf '\n  %s\n' "$1"
  try "edit in place"  "$3" "printf 'x' >> $2/add.js"
  try "git status"     "$3" "$4 git -C $2 status --porcelain"
  try "git add -A"     "$3" "$4 git -C $2 add -A"
  try "git commit"     "$3" "$4 git -C $2 -c user.email=w@t -c user.name=w commit -qm w"; }

echo "=== the option space, measured ==="

d=/tmp/a; build $d; chmod -R a+rwX $d
suite "A: relocate + widen + safe.directory" $d $U "GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=safe.directory GIT_CONFIG_VALUE_0=$d"

# B: the checkout is OWNED by the worker uid — what --user \$(id -u) achieves
d=/tmp/b; build $d; chown -R $U:$U $d
suite "B: container runs as the owning uid" $d $U ""
