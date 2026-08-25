# Experiments

Standalone scripts that produced a measurement recorded in `ISA.md`. They are
kept so a claim can be RE-RUN rather than re-argued, and they are deliberately
not part of any test job: each answers a one-off question about the environment,
not a property of this codebase that should stay true.

Run any of them with:

```sh
docker run --rm -i debian:bookworm-slim sh -s < Docs/experiments/<script>.sh
```

**Via stdin, not a bind mount, and that is not a stylistic choice.** Mounting a
script from a path outside the container runtime's shared set produces an empty
directory rather than an error — ISC-292's whole subject — and on a Colima host
`/private/tmp` is outside it. The first run of these scripts silently did
nothing for exactly that reason.

| Script | Question it answers |
|---|---|
| `isc-298-permission-matrix.sh` | What can a uid-10001 worker do to a host-owned checkout, at each level of widening? |
| `isc-298-option-matrix.sh` | Do the two candidate ISC-298 fixes actually work end to end, including git? |

Both run entirely inside a Linux container, so macOS's bind-mount ownership
squash — the thing that hides ISC-298 on the operator's laptop — is not in the
path.
