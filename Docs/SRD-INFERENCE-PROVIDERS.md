# System Requirements Document — per-worker inference providers

**SRD-PROVIDERS-001 v0.1 — DRAFT FOR OWNER REVIEW**
Sits alongside `Docs/SRD.md` (SRD-PIFLEET-001) and **proposes an amendment to its §5.9 and §12.4**.
Until that amendment is adopted, `Docs/SRD.md` wins and this document is a proposal, not a
specification. Where this document and `Docs/SRD.md` disagree today, that disagreement is the
subject of §4 rather than an oversight.

---

## 0. Preamble

### 0.1 The one-paragraph thesis

A worker's model is served by an oMLX instance the operator runs, and §5.9 states that no hosted
provider is involved *in any role, ever*. The requirement is to let a worker use **Ollama Cloud**
instead — chosen per worker, alongside oMLX rather than in place of it. Mechanically this is small:
`llm.provider` is already resolved per worker, the relay's forwarding table is already a list, and
the two changes the entrypoint needs are the two latent defects §2 measures. Architecturally it is
not small at all, because it moves the fleet's model traffic across a boundary the containment
design was built around. oMLX is the operator's own process: the worker's transcript, the repository
under `/workspace`, and every byte of tool output stay on hardware the operator owns. Ollama Cloud is
a third party, and everything in a worker's context is sent to it. **This document's main job is to
argue that reversal explicitly and to bound it, not to smuggle it in behind a config key.**

### 0.2 The decision that matters — this reverses a stated prohibition

§5.9 does not merely default to self-hosted inference. It says: *"No hosted provider is involved, in
any role, ever. **That prohibition is unchanged and is not what any amendment to this section has
relaxed**"* — and then names three things the prohibition deletes: `usd_ceiling`, the provider key,
and §12.4's Class 1 collapsing to a single environment variable. `fleet.yaml`'s `llm:` block carries
the comment *"ALWAYS self-hosted oMLX, never a provider"*, and `secrets.env_allowlist` carries
*"NEVER provider keys"*.

**So this is not a feature request against an unstated default. It is a request to reverse a written
rule that three other design decisions are built on top of.** A document that adds a `providers:` map
and moves on would leave §5.9's sentence standing and false, which is the specific failure mode this
repository has spent several errata removing.

Two honest dispositions exist and §4 works through both:

1. **Repeal.** The prohibition goes, §5.9 is re-titled again, and the exposure ladder it already
   maintains gains a fourth row.
2. **Bound.** The prohibition is narrowed rather than deleted: a hosted provider becomes legal for a
   named subset of roles and refused for the rest, by mechanism at `up` rather than by convention.

**This document recommends (2), and §7 specifies the refusals.** (1) is the outcome if the owner
declines those refusals, and it should be taken deliberately rather than as a side effect.

### 0.3 The disclosure boundary

This document names one third-party vendor — Ollama — because it is the subject, and it names public
facts about that vendor's public API. It names **no** operator hostname, no LAN or CDN address, no
cloud project, no cluster or namespace, no ticket system or ticket identifier, and no employer. Where
§2 and §4 need to refer to the operator's current endpoints they are described by role — *the tunnel
endpoint*, *the address `llm.relay_upstream` pins today* — and the reader is directed to `fleet.yaml`
for the values. This follows the `skills/ticket-ops/SKILL.md` precedent that `Docs/SRD-DEPLOY-OPS.md`
§0.3 records: name the public vendor and the shape of its API, and nothing internal.

### 0.4 Evidence provenance — what rests on what

| Strength | Source | Used for |
|---|---|---|
| **Measured** | code in this repository, read directly, plus probes run 2026-09-01 against the repository's own functions and against the vendor's public API | §2 in its entirety, §3.1, and every claim carrying a probe command |
| **Recorded** | `Docs/SRD.md`, `docker/entrypoint.sh` and `src/security/relay.ts` header comments, `fleet.yaml`'s own annotations | §4's account of the prohibition and of the relay's design reasoning |
| **Vendor-documented** | Ollama's published API and policy pages | §3.2 — labelled, and weaker than §3.1 because a documentation page is not a running server |
| **Inferred** | reasoning from the above | §5-§8. **These are design proposals, not observations, and they are where the owner's review is most valuable.** |

**One correction to the premises this document was commissioned against, recorded rather than
silently accommodated.** The commission states that a per-worker provider *name* already resolves,
`base_url` and `api_key_env` do not, and that this asymmetry is the crux. The asymmetry is real and
is the crux. But the name resolves **only half way** — to Pi's argv and not to the file Pi actually
reads — and the two halves disagree today for any worker carrying a `provider/` prefix. §2.3 measures
it. The crux is therefore slightly worse than commissioned, and slightly cheaper to fix than it
looks, because the fix is the same one-line change the feature needs anyway.

### 0.5 What was measured today, and what it found

Three defects, all latent, all reachable from the feature this document specifies, none of which
requires the feature to exist in order to be wrong. They are stated up front because each one changes
what a section downstream is allowed to assume.

| # | Defect | Reachable today? | §  |
|---|---|---|---|
| **A** | `docker/entrypoint.sh` reads the credential from the hardcoded name `OMLX_API_KEY`, while the supervisor delivers it under the name `llm.api_key_env` configures. A fleet that renames the variable gets `apiKey: ""` in `models.json`, silently. | Yes — any `api_key_env` other than the default | §2.2 |
| **B** | A worker's resolved provider reaches Pi's `--provider` flag but **not** `models.json`'s provider key, which is still the fleet-wide value. A `provider/`-prefixed model launches Pi naming a provider its own config file does not define. | Yes — any `model:` carrying a `provider/` prefix | §2.3 |
| **C** | `decomposeModel` strips a trailing `:<thinking-level>` before splitting the provider prefix, so a colon-tagged model name whose tag is one of six reserved words silently loses its tag. | Only with tag-style model names — which is exactly how Ollama spells them | §2.4 |

**And one finding that is not a defect, and that reframes the whole document.** A hosted provider is
**already reachable today, fleet-wide, with no code change** — measured in §2.7. `ISC-259` names three
mechanisms as *"the reason a hosted provider cannot appear by accident"*, and the first of them, the
pin on `llm.base_url`'s host, was removed by `ISC-369` for an unrelated and good reason. So this
document is not opening a door. **The door is open, it is fleet-wide rather than per-worker, and the
refusals that ought to bound it do not exist at all.** That inverts the framing: the feature's value is
as much in the gates §7 specifies as in the capability §6 adds.

**And three things measured against the live endpoint with a real key**, which between them removed the
design's largest dependency and added a smaller one:

- **The hard gate clears.** `probeNativeToolCalls` — the repository's own function, so the parser under
  test is the one that runs at `up` — returned `ok: true` for **19 of 19** catalogue models. The design
  no longer rests on the vendor's `capabilities` attestation. §3.1
- **One key serves both API surfaces**, so no second credential is needed anywhere. §3.1
- **A new risk, in the clock rather than the shape.** Probe latency is bimodal: 17 models under 4.4 s,
  then `mistral-large-3:675b` at 42 s and `nemotron-3-ultra` at **57 s** against a fleet-wide 60 s
  ceiling — host-side and unqueued, so through a relay and behind a one-concurrent-request tier both
  only rise. D16. §3.1

**And one thing traced through the code rather than probed:** a Class 1 credential's *value* is never
swept from harvested artifacts — only its *name* is redacted from logs. True for every fleet today; it
changes severity here because a hosted key is a billing credential. D15, §6.6.

---

## 1. Problem statement

### 1.1 What a worker can talk to today

One thing. `llm:` in `fleet.yaml` is a single fleet-wide block — `provider`, `base_url`,
`relay_upstream`, `api_key_env`, `model`, `thinking`, `models_allowlist`,
`require_native_tool_calls` — and every worker in every role resolves against it. The endpoint is an
oMLX server in one of the three deployment shapes §5.9 permits (Docker host, trusted LAN peer,
private tunnel to the operator's own machine). A worker reaches it through a relay container that
re-opens exactly one destination in an otherwise deny-all Docker bridge.

### 1.2 What "per worker, not fleet-wide" actually asks for

Three separable things, and conflating them is how this design goes wrong:

1. **Provider selection** — which endpoint a given worker's inference goes to. This is what was
   asked for, and it is per worker.
2. **Provider declaration** — which endpoints the fleet may reach at all. This is necessarily
   fleet-wide, because the relay and the egress bridge are shared. §6.5 is about the gap between
   (1) and (2), and it is the most consequential paragraph in this document.
3. **Provider trust** — whether a given endpoint is the operator's own or a third party's. Today
   this is a constant (`true`) and it stops being one.

### 1.3 Success in one sentence

An operator can write `model: ollama-cloud/gpt-oss:120b` on one role, leave every other role on
oMLX, and have `up` either bring that fleet up correctly or refuse it by name — with the set of
workers whose context will leave the machine printed before anything starts.

---

## 2. The measured current state

Everything in this section was read from the tree and, where a probe is shown, run on 2026-09-01.
Line references are as of that date; **the symbol names are the durable citation** and the file:symbol
form is used where a line number would rot.

### 2.1 The `llm:` block is one block, and only one of its fields is per-worker

`src/config/schema.ts:LlmSchema` is `.strict()` and flat. Defaults: `provider: "omlx"`,
`base_url: "http://omlx.pifleet.internal:8000/v1"`, `relay_upstream: null`,
`api_key_env: "OMLX_API_KEY"`, `models_allowlist: []`, `require_native_tool_calls: true`.

`src/config/load.ts:resolveWorker` calls `decomposeModel(mergedModel, config.llm.provider,
mergedThinking)`, so a worker's `model:` may carry a `provider/` prefix that overrides the fleet
value. That resolved value lands on `ResolvedWorker.provider`. **No other field of `llm:` is
per-worker, and there is no syntax that would make one so.** `base_url`, `relay_upstream` and
`api_key_env` are read straight off `config.llm` by every consumer.

That is the asymmetry the feature has to close: a per-worker provider *name* with no per-worker
*endpoint* or *credential* to go with it names something that does not exist.

### 2.2 Defect A — the entrypoint hardcodes the credential's name

`src/run/worker-env.ts:buildWorkerEnv` reads `const apiKeyEnvName = llm.api_key_env` and, near the
end, writes `vars[apiKeyEnvName] = apiKey` — the key is delivered to the container **under the name
the operator configured**. `docker/entrypoint.sh`'s `models.json` block reads it under a literal:

```sh
--arg apiKey "${OMLX_API_KEY:-}" \
```

The two agree today only because both strings happen to be `OMLX_API_KEY`. Reproduced by running the
entrypoint's `jq -n` invocation verbatim under two environments, `env -i` so nothing leaks in:

```
=== CASE 1: api_key_env: OMLX_API_KEY (today's fleet) ===
  "omlx": { …, "apiKey": "KEY-FOR-SELF-HOSTED", … }

=== CASE 2: api_key_env: OLLAMA_API_KEY; supervisor delivered OLLAMA_API_KEY and nothing else ===
  "ollama": { …, "apiKey": "", … }
```

**The failure is silent in the worst available way.** The guard above the block is
`[ -n "${PIFLEET_LLM_BASE_URL:-}" ] && [ -n "${PIFLEET_LLM_MODELS:-}" ]` — it does not test the key —
so `models.json` is still written, Pi still registers the provider, the container still boots, and
`up` still reports success. The first symptom is an authentication error at generation time, inside
a container, on a worker that looks healthy. Against a metered provider it is an authentication
error that a person will initially read as a billing problem.

This is not a consequence of the feature. It is reachable today by any operator who renames the
variable, and the schema explicitly invites that: `api_key_env` exists precisely so the name is not
fixed. **The feature makes it certain rather than possible**, because a second provider cannot share
one variable name.

### 2.3 Defect B — the provider name resolves to argv but not to `models.json`

`src/config/render.ts` pushes `argv.push("--provider", w.provider)` — the **resolved, per-worker**
value. `src/run/worker-env.ts:buildWorkerEnv` sets `PIFLEET_LLM_PROVIDER: llm.provider` — the
**fleet-wide** value — and that variable is what `docker/entrypoint.sh` uses as the provider key in
`models.json`. Measured, by loading a config through the repository's own `parseConfig`,
`resolveWorker` and `buildWorkerEnv`:

```
--- w-omlx --- (role model: Qwen3.5-35B-A3B-8bit)
  w.provider (-> pi --provider) = "omlx"
  PIFLEET_LLM_PROVIDER          = "omlx"
  argv provider === models.json provider key ? true

--- w-ollama --- (role model: "ollama/gpt-oss:120b-cloud")
  w.provider (-> pi --provider) = "ollama"
  w.model    (-> pi --model)    = "gpt-oss:120b-cloud"
  PIFLEET_LLM_PROVIDER          = "omlx"
  argv provider === models.json provider key ? false
```

So a `provider/` prefix today produces a container in which Pi is launched with `--provider ollama`
and handed a `models.json` whose only provider block is keyed `omlx`. **The per-worker provider name
does not resolve end to end; it resolves to the flag and stops.** The `provider/` prefix has never
been exercised against a second provider — with one provider the two values agree by coincidence,
which is the same shape of coincidence `relayGatePolicy` was caught in by ISC-264.

The repair is one line — `PIFLEET_LLM_PROVIDER: w.provider` — and it is a strict prerequisite for
this feature rather than a nice-to-have alongside it.

### 2.4 Defect C — the thinking suffix eats a colon tag

`src/config/load.ts:decomposeModel` strips a trailing `:<suffix>` when the suffix parses as a
`ThinkingLevel`, *before* it splits the `provider/` prefix. The levels are `off`, `minimal`, `low`,
`medium`, `high`, `xhigh`. Ollama spells model names `name:tag`. Measured in the same run:

```
--- w-tagclash --- (role model: "ollama/some-model:high")
  w.provider = "ollama"   w.model = "some-model"   w.thinking = "high"
```

The tag is gone and a thinking level has been invented from it. Today's Ollama Cloud catalogue does
not use any of the six words as a tag, so this is latent rather than live — but the collision is
structural, the vendor controls the tag namespace, and the failure presents as `model-not-found`
against a model name the operator can see is correct in their `fleet.yaml`. §8 D12 proposes the
narrow fix.

### 2.5 The two egress mechanisms, and which one carries the model

`src/security/network.ts` puts every worker on an `--internal` Docker bridge: no default route, no
NAT, nothing off the bridge subnet. On top of that sit **two** mechanisms, and they are frequently
conflated:

| | **The relay** | **The CONNECT proxy** |
|---|---|---|
| Purpose | model traffic | everything in `egress.allow` |
| Alias workers dial | `RELAY_LISTEN_ALIAS` (and the `base_url` host, ISC-369) | `PROXY_LISTEN_ALIAS`, port 3128 |
| Mechanism | raw TCP splice — nothing parses, terminates or re-originates TLS | HTTP `CONNECT`; answers `405` to anything else |
| Who gets it | every worker on the bridge | only workers with `egress_access: true` (`HTTPS_PROXY` is set for them) |
| Policy | `relayGatePolicy` — the Docker-host default rule plus `egress.allow` | `proxyPolicyFor` — `egress.allow` plus `egress.google_hosts` |
| Container | the same one. Two aliases, two listeners, one image | |

`proxyPolicyFor` deliberately carries **no** `llm` rule, and every relay listen alias is put into
`NO_PROXY` for proxied workers, so model traffic cannot enter the proxy. This matters for §6: routing
a hosted provider through the CONNECT proxy instead of the relay is not a free alternative — it would
require `egress_access` on every worker using that provider, which also grants that worker every
other destination in `egress.allow`, and it would need Pi itself to honour `HTTPS_PROXY` for its
inference calls (unverified; §9 Q6).

**The relay's target list is already plural.** `relayRunArgv` takes `targets: readonly RelayTarget[]`,
`assertTargetsAllowed` iterates it, `relayTargetsDrifted` compares two lists, and
`PIFLEET_RELAY_TARGETS` carries it as JSON so a running relay's forwarding table can be read back off
the container. The single place the plurality collapses is `ensureEgressRelay`:

```ts
const target = omlxRelayTarget(cfg);
const targets = [target] as const;
```

**One element, in one function, in a data path that is otherwise a list from end to end.** This is the
single most important fact in this section, and §6.3 rests on it.

### 2.6 The probe is single-provider by construction

`src/security/model-probe.ts:assertModelsSupportToolCalls` groups the named workers by resolved
model, then probes each distinct model with:

```ts
const baseUrl = loaded.config.llm.base_url;
const apiKey  = process.env[loaded.config.llm.api_key_env] ?? "";
```

**One URL and one key for every model, regardless of which provider that model belongs to.** Add a
second provider without touching this and every model belonging to it is dialed at the first
provider's endpoint with the first provider's credential, which returns `model-not-found` and exits
2 — a fleet refused at `up` for a model that is perfectly valid. `up.ts:assertModelsAllowed` has the
matching gap in the other direction: `models_allowlist` is fleet-wide and is checked against the
**bare** model name after the prefix has been stripped, so `omlx/gpt-oss:120b` passes an allowlist
written for the cloud provider. **The provider/model pair is not validated as a pair anywhere.**

Ordering at `up`, which §6.8 has to preserve: `assertModelsAllowed` → `ensureEgressNetwork` →
`ensureEgressRelay` → `assertModelsSupportToolCalls`. The tool-call probe runs **last and from inside
a container on the egress bridge**, dialing `base_url` verbatim, because ISC-260's whole content is
that the gate must test the path the workers use.

### 2.7 A hosted provider is already reachable today, and one of the three defences is gone

ISC-259 is the criterion that carries the prohibition. Its headline is *"Every worker's model is served
by an oMLX instance the OPERATOR runs — **never a hosted provider** — reached only through a target the
operator authorised explicitly, in a second place from the one that names it."* It is graded `[x]`, and
its closing evidence names three mechanisms, *"each … the reason a hosted provider cannot appear by
accident"*:

1. `llm.base_url`'s host is **pinned** — *"`relayListenPort` throws for anything other than
   `omlx.pifleet.internal`"*, so *"a worker cannot be pointed at an arbitrary endpoint by editing one
   field"*;
2. the relay's dial target needs a **second, non-derivable authorization** — `relayGatePolicy` builds
   its policy from `egress.allow` only;
3. the worker bridge is `--internal` and has no route of its own.

**Defence 1 no longer exists.** ISC-369 removed the pin so that `base_url` could name a published
endpoint the relay answers to — a good change, taken for the operator's own tunnel, and
`relayListenEndpoint`'s docblock records the reasoning. But ISC-259's closing evidence was not re-taken
when the mechanism it cites was removed. Measured 2026-09-01, driving the repository's own
`parseConfig`, `omlxRelayTarget`, `relayListenAliases` and `assertTargetsAllowed`:

```
=== Point the whole fleet at a hosted provider, with the allow entry written ===
  config validate  : ACCEPTED
  relay target     : omlx:443->…:443
  listen aliases   : omlx.pifleet.internal, host.docker.internal, egress.pifleet.internal, ollama.com
  egress gate      : ALLOWED

=== Same, but WITHOUT the egress.allow entry ===
  REFUSED: relay: refusing to forward omlx -> …:443 — the egress policy denies it
           (rule: default-deny)

=== Hostname upstream ===
  REFUSED: 1 validation error
```

**Defence 2 holds exactly as designed, and defence 3 is untouched.** But defence 2 is an
*authorization* check, not a *trust* check: it establishes that the operator wrote the destination
down in a second place, which they will do deliberately when they mean to use a hosted provider. It was
never able to distinguish the operator's own endpoint from a vendor's, and with defence 1 gone it is
the only check standing between `fleet.yaml` and a third-party model server.

Two consequences for the rest of this document:

- **The capability is not what is being requested; the *granularity* is.** A fleet can go to Ollama
  Cloud today by editing three fields — and would fail only at generation time, with a 401, because
  Defect A means the key is never delivered. What does not exist today is per-worker selection, and
  what does not exist *at all* is any refusal, banner, or role bound.
- **ISC-259's evidence needs re-taking regardless of whether this feature is built.** A closed
  criterion resting on a mechanism a later criterion deleted is exactly the drift `ISA.md`'s
  strictness rule exists to surface, and the relay target is still labelled `name: "omlx"` in a
  configuration where it dials neither oMLX nor the operator's machine.

---

## 3. What is known about Ollama Cloud, and what is not

Split by evidence strength, because §6 and §7 lean on different halves and the difference matters.

### 3.1 Confirmed by live probe (2026-09-01)

| Claim | Evidence |
|---|---|
| An OpenAI-compatible route exists at `https://ollama.com/v1/…` | `GET /v1/models` → `200` with `{"object":"list","data":[{"id":…,"object":"model","owned_by":"ollama"}…]}`; `POST /v1/chat/completions` → `401` in an OpenAI error envelope, i.e. routed and auth-gated, not `404` |
| `GET /v1/models` needs **no** credential | `200` unauthenticated, and `200` with a deliberately bogus bearer token |
| Inference **is** credential-gated, and the credential is validated | `POST /v1/chat/completions` and `POST /api/chat` both `401` with no token **and** with a bogus token |
| Model ids are tag-style and carry **no** `-cloud` suffix when the service is addressed directly | live catalogue ids include `gpt-oss:120b`, `gpt-oss:20b`, `qwen3.5:397b`, `mistral-large-3:675b`, `nemotron-3-nano:30b` |
| Per-model capabilities are queryable, unauthenticated | `POST /api/show {"model":"…"}` → `200` with `capabilities`, e.g. `["completion","tools","thinking"]`. Five models sampled, all five advertised `tools` |
| The service is behind Google's global HTTPS load balancer, **not** a CDN this project has experience pinning | every response carries `server: Google Frontend`; the single A record observed resolves into Google's address space |
| The catalogue churns | model ids cited in the vendor's own older material are absent from today's catalogue |
| **Every catalogue model passes the fleet's native-tool-call gate** | `probeNativeToolCalls` — the repository's own function, not a hand-rolled request — run against `/v1` with a real key: **19 of 19 models `ok: true`**, each *"answered with 1 native tool_call(s)"*, i.e. `finish_reason: "tool_calls"` **and** a non-empty `tool_calls[]`, both halves the code requires. **Zero `prose`, zero `malformed`, zero `inconclusive`, zero `timeout`.** |
| One key authenticates **both** surfaces | the same bearer token: `POST /v1/chat/completions` → `200`, `POST /api/chat` → `200` |
| Probe latency is **bimodal**, and the slow group sits on the fleet's own ceiling | 17 models ≤ **4.4 s** (most under 1.5 s); `mistral-large-3:675b` **42,114 ms**; `nemotron-3-ultra` **56,947 ms** against `PROBE_TIMEOUT_MS = 60_000`. Third-slowest is 4,374 ms — a tenfold gap with nothing in between, and both slow models are the largest in the catalogue. **Single sample per model, host-side, unloaded: enough to establish the shape, not the distribution.** See D16 |

**The tool-call gate was the hard gate and it clears.** §3.3 previously carried it as the design's
largest unconfirmed dependency, on the reasoning that the vendor's `capabilities: ["…","tools",…]`
array is an attestation on a *native* route and not a measurement of the OpenAI-compatible path's
response shape. That reasoning was right and is now moot: the path was measured directly, with the
parser that runs at `up`. **The design no longer rests on the vendor's attestation for this.**

### 3.2 Vendor-documented, not probed

- The native API base URL is `https://ollama.com/api`, described as the same API as a local install's
  `/api` on a different host.
- Authentication is `Authorization: Bearer <key>`, with keys minted from an account settings page.
  **This is the same header shape `model-probe.ts:authHeaders` already emits**, which is a genuine
  and slightly surprising piece of luck: `Authorization: Token` would have been the kind of wrong
  guess this repository has been caught by before.
- Cloud models are addressed from a *local* Ollama install with a `-cloud` suffix; that suffix is a
  local routing hint and not the service's own spelling.
- Prompts and responses are described as processed transiently and not used for training.
- Concurrency is tiered: 1 concurrent request on the free tier, 3 on the next, 10 above that.

### 3.3 Not confirmed — and none of these is a gate any more

**Nothing below should be treated as fact, and §9 carries each as an open question with the probe
that settles it.** Two items that stood here on the first draft — the tool-call response shape and
whether one key serves both surfaces — have since been **measured and moved to §3.1**. They are named
here only so a reader of the earlier draft can see where they went.

- Whether the `/v1` surface is at full parity with a local install's. One third-party report of a
  `500` on that path for vision models was surfaced and not read; it is a signal, not a finding.
- Whether the load balancer accepts a request whose `Host` header carries a non-default port. **No
  longer load-bearing** — D7 gives each provider its own network, so §6.4's port mechanism is not
  implemented and this blocks nothing.
- Whether the observed address is stable in any sense the operator can rely on. No vendor-published
  static range or firewall guidance was found. **D9 removes the operator's exposure to this** by
  resolving the name at `up` for hosted blocks.
- The exact wording of the retention policy, which §7.4 would otherwise quote.
- The distribution behind §3.1's latency figures. The *shape* is measured; the *stability* of any one
  number is not, and D16 is written to the shape rather than to the numbers.

---

## 4. The prohibition this reverses

### 4.1 §5.9's axis is privacy, and a hosted provider fails all three clauses

§5.9 was re-titled on 2026-08-25 specifically to stop enumerating permitted *places*, because each
new place read as a relaxation when none of them touched the rule. The rule it settled on:

> **The requirement is that the instance is the operator's own.** Private means: the operator runs the
> process, holds its key, and decides who may reach it.

Ollama Cloud fails all three clauses, and it is worth being exact about that rather than gesturing at
it. The operator does not run the process. The key is issued to the operator by the vendor and can be
revoked by the vendor. The set of parties who may reach the endpoint is the vendor's decision, not the
operator's. **This is not a fourth deployment shape of a private instance. It is the thing §5.9's
amendment was written to keep excluding**, and the amendment says so in the same breath:
*"none of them introduces a third party who serves the model."*

The consequence for this document's structure: §5.9 cannot absorb Ollama Cloud as another row without
its central sentence becoming false. Either the sentence changes, or the new row is explicitly outside
what the sentence governs.

**The prohibition is also a graded criterion, not only prose.** ISC-259 carries it in its headline and
was closed `[x]` on 2026-08-28 by owner decision, after being reframed twice. So adopting this document
does not merely amend an SRD section — it **falsifies a closed criterion**, and §10 says what has to
happen to it. That is a heavier act than editing a paragraph and should be visible as one.

### 4.2 The exposure ladder needs a fourth row and a third column

§5.9 already maintains an exposure ladder over the three private shapes. Extending it is the clearest
way to show what actually changes — and the extension needs a **column that does not exist today**,
because all three current rows have the same answer to it and a constant column is invisible.

| Shape | Where the key travels | Who can open a socket to the endpoint | **Who can read the prompt** |
|---|---|---|---|
| Docker host (default) | nowhere — loopback only | processes on that host | the operator |
| Trusted LAN peer | one unencrypted L2 hop | every device on the operator's LAN | the operator, and anyone observing that hop |
| Private tunnel to the operator's own server | the public internet, TLS to the tunnel edge | anyone who learns the hostname | the operator |
| **Hosted provider** | the public internet, TLS to the vendor | anyone the vendor permits | **the vendor** |

**The fourth column is the whole of the change.** Rows one to three differ in *credential* exposure
and in *reachability*; §12.4 spent two errata on exactly those two axes and reached a defensible
residual each time, on the repeated basis that the credential *"protects free inference on a
self-hosted server — no money, no cloud identity, no data at rest."* Row four is the first row where
the **content** leaves, and it is also the first row where the credential has billing authority. Both
of §12.4 Class 1's load-bearing arguments fail simultaneously.

### 4.3 What actually leaves the machine

Stated concretely, because "data egress" is abstract enough to be nodded at:

- **The repository.** A worker with `isolation: worktree` or `shared-ro` has the operator's checkout
  at `/workspace`, and everything it reads there to answer a task goes into the context. For the
  `engineer`, `sre`, `reviewer` and `tester` roles this is source code, and it is the primary use
  case for a faster model — the value and the exposure are the same fact.
- **Tool output.** `bash`, `grep` and `read` results are context. For a `cloud_access` role that
  includes `kubectl` and `gcloud` output: resource names, topology, error text.
- **The briefing.** Role prompts under `roles/` and the task envelope's prose.
- **Not the credentials themselves, by default.** Class 3 secrets are delivered as files and the
  environment holds only a `<NAME>_FILE` pointer, so `env` does not disclose them. §12.4 is explicit
  that this narrows the accident and not the agent: a worker can still `cat "$TICKET_API_TOKEN_FILE"`
  and put the value in its own transcript, and that transcript is context.

The last point is the sharp one. **The fleet's credential design assumes the transcript is a place the
operator can inspect after the fact; a hosted provider makes it a place a third party reads first.**

### 4.4 The refusal that should be built rather than the warning that should be printed

§12.4's Class 2 sets the precedent this document follows. A Google identity in a container is *also* a
deliberate reversal of a simpler rule, and it was handled by moving the boundary from *presence* to
*blast radius*: opt-in per role, a one-hour token rather than a refresh token, the host credential
store never mounted, and — the part that matters here — *"`up` prints the granted identity, project,
and mode"*, so *"the grant is never silent."*

**A hosted provider deserves the same treatment and one thing more.** Class 2's controls bound what a
leaked credential can do. There is no equivalent for content: once a transcript has been sent, no
ceiling, timeout or scope reduces it. The only controls available are **which workers may use the
provider at all** and **what those workers can see**, and both are decidable from `fleet.yaml` before
anything starts. §7 specifies them as refusals at `up` rather than as warnings, on the same reasoning
`worker-env.ts:SecretReservedNameError` already records: *"a comment is not a control."*

---

## 5. Scope and non-goals

### 5.1 In scope

- A second declared provider, selected per worker, reached through the existing relay.
- The three defects in §0.5, which are prerequisites rather than adjacent work.
- Per-provider `base_url`, `relay_upstream`, `api_key_env` and `models_allowlist`.
- Refusals at `up` that bound which roles may use a hosted provider.
- The credential channel for a provider key that has billing authority.

### 5.2 Non-goals

- **Any provider other than Ollama Cloud.** The shape generalises, but a design validated against one
  vendor and written as though it covered all of them is how `backend.kind` spent months parsed and
  read by nothing.
- **Cost control.** `usd_ceiling` was deleted by §5.9 and is not being resurrected here. A metered
  provider makes it meaningful again and that is a separate piece of work. The owner ruled it
  deferred for v1 — D14, and §9.1 records the ruling.
- **Routing one worker across two providers**, or failover between them. One worker, one provider,
  one model — which is what `PIFLEET_LLM_MODELS: w.model` already encodes.
- **Per-worker network isolation.** §6.5 explains why this is the only thing that would deliver true
  per-worker containment, and why it is deferred rather than absent.

### 5.3 Deliberately deferred

- SNI-based demultiplexing in the relay. §6.4 rejects it on a property argument, not a cost one.
- Using Ollama's native `/api` surface. The fleet is OpenAI-shaped end to end —
  `api: "openai-completions"` is hardcoded in the entrypoint and `probeNativeToolCalls` speaks
  `/chat/completions` — and adding a second API dialect is a larger change than adding a second
  endpoint. This deferral is now on firm ground rather than provisional: §3.1 measured the `/v1`
  path passing the tool-call gate on **all 19** catalogue models, so there is no gate-driven reason to
  add the native dialect. §9.2 Q11 keeps the narrower parity question open.

---

## 6. The design

### 6.1 `llm.providers` — a map, with the flat keys retained as the default provider's shorthand

```yaml
llm:
  provider: omlx                  # the fleet DEFAULT — unchanged meaning
  model: Qwen3.5-35B-A3B-8bit     # fleet default, unchanged
  thinking: medium
  require_native_tool_calls: true # stays fleet-wide — see §6.8
  providers:
    omlx:
      hosted: false
      base_url: …                 # unchanged semantics, now scoped to this provider
      relay_upstream: …
      api_key_env: OMLX_API_KEY
      models_allowlist: [Qwen3.5-35B-A3B-8bit]
    ollama-cloud:
      hosted: true                # REQUIRED and explicit — see below
      base_url: https://ollama.com/v1
      relay_upstream: ollama.com:443
      api_key_env: OLLAMA_API_KEY
      models_allowlist: [gpt-oss:120b]
      tag_style: true             # see D12
```

`llm.provider` keeps its meaning exactly — the default a worker gets when its `model:` carries no
prefix — and must name a key of `providers`. The flat `base_url`/`relay_upstream`/`api_key_env`/
`models_allowlist` keys stay accepted and mean *"the block for `llm.provider`"*, so **an existing
`fleet.yaml` needs no edit**, which is the same compatibility rule `relay_upstream: null` and the
legacy listen alias were both given. Writing both the flat key and a `providers` entry for the same
provider is a refusal, not a merge: two spellings of one value silently disagreeing is the failure
mode ISC-264 cost a whole rename to find.

**`hosted:` is required and explicit, and it is the most important field in the block.** It is not
inferred, and the reason is measured rather than stylistic: §5.9's third permitted private shape is a
tunnel to the operator's own machine, whose address is public and whose hostname is publicly
resolvable. Any inference from the URL, the address range, or the presence of TLS classifies that
shape as hosted, which is wrong in exactly the case §5.9 spent an amendment establishing. The operator
declares it, and every refusal in §7 keys on the declaration.

### 6.2 What becomes per-provider, and what stays fleet-wide

| Field | Scope | Why |
|---|---|---|
| `base_url` | **per provider** | it is the endpoint |
| `relay_upstream` | **per provider** | one relay target per provider |
| `api_key_env` | **per provider** | two endpoints cannot share a credential |
| `models_allowlist` | **per provider** | §2.6 — the pair must be the unit of validation |
| `hosted` | **per provider** | new |
| `tag_style` | **per provider** | D12 |
| `probe_timeout_ms` | **per provider** | D16 — how long to wait is a measured property of the wire, not a fleet policy. Contrast `require_native_tool_calls`: *whether* to refuse a prose-only model is the same answer whichever endpoint serves it |
| `provider` | fleet | the default; overridable per worker by prefix, unchanged |
| `model`, `thinking` | fleet default | already overridable at role and worker level |
| `require_native_tool_calls` | **fleet** | it is a statement about what the fleet will tolerate, not about an endpoint. Per-provider would let a hosted provider quietly opt out of the gate §5.9 calls mandatory |

`models_allowlist` moving per-provider closes §2.6's second gap by construction: `assertModelAllowed`
checks the resolved model against **the resolved provider's** list, so a model belonging to one
provider can no longer satisfy an allowlist written for the other.

### 6.3 The relay's target list — retained as the record of a trade D7 overrode

> **SUPERSEDED IN EFFECT BY D7 (§6.5.4).** With one relay per provider, each relay carries exactly one
> target and `ensureEgressRelay` needs no change. This section is kept because D7's ruling is a choice
> *against* what follows, and a reader should be able to see what was on the other side of it — in
> particular that the shared-relay option was rejected despite being cheaper in containers, and that
> the "exactly one destination" sentence D5 would have retired is preserved by D7 instead.

**As proposed before D7: one relay container, one target per declared provider.** `ensureEgressRelay`'s
`const targets = [target] as const` becomes one target per entry in `llm.providers`; everything
downstream — `assertTargetsAllowed`, `relayRunArgv`, `PIFLEET_RELAY_TARGETS`, `liveTargetsFromEnv`,
`relayTargetsDrifted`, the `egress_relay_ready` ledger event — is already list-shaped and needs no
change. `relayListenAliases` already appends `base_url`'s host to the alias set and must append every
provider's; it is already an ordered de-duplicated derivation, which is exactly the shape that
extension needs.

**What this does to the deny-all argument, stated precisely.** The relay's property was never "one
destination" as an end in itself — `relay.ts`'s header says *"re-opens exactly one destination"*, but
`assertTargetsAllowed`'s docblock states the actual invariant: *"The relay may only carry destinations
`decide()` allows."* The guarantee is **"exactly the destinations the operator authorized in
`egress.allow`, and nothing else"**, and it is enforced per target in a loop. Going from one target to
two does not weaken it; it exercises it. The number one was a fact about the configuration, not a
property of the mechanism.

**A second relay container was considered and rejected.** `relayContainerName` and `uplinkNetworkName`
are pure functions of the egress network, so two relays means two derivations, two adoption paths, two
drift detectors, two lifetime stories on a container that already carries `--restart unless-stopped`
and outlives every run, and a second manual teardown sequence in the header's removal instructions. It
buys one property the target list does not: independent listen ports on independent IPs, which §6.4
shows is only needed for a case the port field already handles.

### 6.4 The listen-port collision — dissolved by D7, and why the SNI rejection still stands

> **NO LONGER LIVE UNDER D7 (§6.5.4).** Two providers on `:443` are two containers in two network
> namespaces, so nothing collides and the non-default-port mechanism below is not needed. **§9 Q3 stops
> blocking.** What survives is the last paragraph: the reason the relay must not learn to read TLS is a
> standing property of the design, not a consequence of this feature, and it would have to be re-argued
> by anyone who later proposes collapsing the per-provider networks back into one.

The relay splices raw TCP and deliberately parses nothing. It resolves *which upstream to dial* from
**which port the connection arrived on**, because that is the only signal a splice has. Two providers
whose `base_url` names the same port therefore cannot be distinguished, and `listen(2)` fails loudly
rather than mis-routing — which is the good failure, but is still a failure.

**Today this is not live.** The shipped default `base_url` is `http://…:8000/v1` and the operator's
current one is an HTTPS endpoint on 443; a fleet running the default oMLX alongside Ollama Cloud has
ports 8000 and 443 and no collision. **It becomes live the moment two providers are both plain
HTTPS**, which the operator's current tunnel configuration would make true immediately.

The resolution is a **distinct port in the hosted provider's `base_url`**, with the relay dialing the
real port upstream:

```yaml
base_url: https://ollama.com:8443/v1     # what a worker dials, on the bridge
relay_upstream: ollama.com:443           # what the relay dials, off the bridge
```

TLS survives this: the worker sends SNI for `ollama.com` and validates the vendor's real certificate,
because a certificate binds a name and not a port, and nothing in the relay terminates the session.
This is the same end-to-end property the tunnel configuration already relies on and which
`relayListenEndpoint`'s docblock records as measured.

**The cost, stated plainly, because it is genuinely confusing:** `base_url` for a hosted provider then
holds a URL that is correct nowhere except inside the bridge. A person debugging will copy it, paste
it into `curl` on the host, and get a connection refused that says nothing. It must carry a comment in
`fleet.yaml`, and `doctor`'s host-vantage output must not present it as dialable.

**And it rests on something unverified.** The client's `Host` header will read `ollama.com:8443` while
the connection terminates on the vendor's load balancer at 443. §9.1 records Q3 as **dissolved rather than answered** — D7 removes the mechanism
that needed it. **If it were live and the load
balancer rejects it, this design fails and the fallback is a second relay container after all** —
which is why §6.3's rejection of that option is recorded with its one distinguishing property named
rather than dismissed.

**SNI inspection is rejected on a property argument.** Reading the handshake to demultiplex by name
would make the relay parse TLS. `relay.ts` states the current property as *"Nothing in the relay
parses, terminates or re-originates that TLS; it cannot, and that is the property that makes this safe
to allow."* Trading that for a port number is a bad trade, and it would have to be re-argued for every
future destination.

### 6.5 One network and one relay per provider — reachability tracks selection

**This is the section to read if only one is read.** It states the problem, then the design the owner
ruled for, which is the one that actually solves it.

#### 6.5.1 The problem, as it stands today

The egress bridge is shared by every worker. The relay publishes **every** listen alias to that bridge,
for every worker, unconditionally — `relayConnectArgv` attaches the alias list to the network endpoint,
not per container. So declaring `ollama-cloud` makes `ollama.com` resolve and connect from **every
worker on the network**, including the ones assigned to oMLX, including the `ticketing` worker holding
a ticket credential, including the `observer` worker holding a Google identity. `curl` and
`ca-certificates` are in the base toolchain.

**Provider selection bounds where a worker's inference goes. It does not bound where its `bash` can
reach.** A worker does not even need the API key to exfiltrate: an unauthenticated `POST` to
`/v1/chat/completions` returns `401`, and the body has already crossed the wire.

This is not a new class of hole; it is an existing, documented limit arriving in a place where it costs
more. `worker-env.ts` already records the same shape for the CONNECT proxy: *"two workers with
`egress_access: true` reach the same hosts, so the grant is per-worker and the reach is not. A fleet
that needs one worker to reach a host another must not still has no way to express that."*

**It is worse than that, and the second half is not documented anywhere.** The relay is a durable
shared resource keyed on the egress network, adopted by later `up`s and **replaced when its target
list drifts**, with a `relay_targets_replaced` ledger row. So a *second fleet* that declares a hosted
provider will replace the relay the *first* fleet is using and add the hosted alias to the bridge the
first fleet's workers are on — mid-run, with nothing in the first fleet's output saying so.
`ensureEgressRelay`'s docblock already accepts this trade for target changes generally
(*"the alternative is not 'leave the other fleet alone'"*), which was proportionate when every target
was the operator's own oMLX and is not proportionate when one of them is a third party.

Three options were put to the owner: accept and document; bound it with role refusals plus a distinct
`docker.network` per fleet; or per-worker bridges. **The owner ruled for per-worker bridges** — the
option this document had named as the only one that makes reachability track selection, and had
deferred on cost. It is specified below rather than deferred.

#### 6.5.2 The design — one egress network and one relay per provider in use

A worker's network stops being a fleet constant and becomes a function of its resolved provider.
Everything else falls out of derivations that already exist.

| Thing | Today | Under D7 |
|---|---|---|
| Egress network | `docker.network` | `<docker.network>-<provider>` |
| Uplink network | `uplinkNetworkName(net)` → `<net>-uplink` | unchanged function, applied to the per-provider name |
| Relay container | `relayContainerName(net)` → `pifleet-egress-relay-<net>` | unchanged function, applied to the per-provider name |
| Worker attach | `render.ts` pushes `--network docker.network` | `--network` for **that worker's** provider |
| Relay targets | one | still **one** — see 6.5.4 |
| `up` call sites | `ensureEgressNetwork` and `ensureEgressRelay` once | once **per distinct provider the run's workers resolve to** |

**Only providers actually in use get a network and a relay.** A provider declared in `llm.providers`
that no worker in this run resolves to creates nothing and opens no route. That is a containment
property the fleet-wide design could not express at all: today a declared provider is a published alias
whether or not anything uses it.

**The name derivations survive intact, which is the property that makes this cheap.**
`relayContainerName` and `uplinkNetworkName` are pure functions of the network name and
`relay.ts`'s header leans on exactly that — *"the exact strings are always recoverable from `fleet.yaml`
alone, with no hunting through `docker ps`"*. Composing one more level keeps that true; the strings are
still derivable, there are just more of them. `assertDockerName` is already re-run after composition
because a derived name is longer than its input, and that check now earns its keep: a provider key is
operator-chosen, so `pifleet-egress-relay-<network>-<provider>` is the first composed name in this
codebase that a long config value can push past Docker's limit. It fails at `up` with the field named,
which is the right failure.

#### 6.5.3 What this solves — the cross-fleet hazard, completely

The sharpest finding in 6.5.1 was that a *second* fleet declaring a hosted provider replaces the relay a
*first* fleet is using and adds the hosted alias to the bridge the first fleet's workers are already on,
mid-run, with nothing in the first fleet's output saying so.

**That cannot happen under D7, and not by policy — by construction.** A relay's target is a function of
**one provider**, not of the union of what any fleet declared. Fleet A running oMLX owns
`<network>-omlx` and its relay; fleet B declaring a hosted provider creates `<network>-ollama-cloud` and
a second relay. Fleet A's network, relay, alias set and reachable set are untouched. There is no
configuration of fleet B that adds a route to fleet A's workers.

Drift and replacement still occur **within** a provider — an operator changing that provider's
`base_url` or `relay_upstream` still cycles that provider's relay under the existing
`relay_targets_replaced` semantics, and two fleets using the same provider still share its relay and
still race on that change. **That is the original case, and it was always proportionate**: both fleets
asked for the same endpoint, and the thing that changed is the endpoint they both named.
`ensureEgressRelay`'s *"the alternative is not 'leave the other fleet alone'"* stays true and stays
defensible, because it now only ever applies between fleets that chose the same provider.

#### 6.5.4 What this makes unnecessary — D5 and D6

**D7 supersedes D5's multi-target relay.** With one relay per provider, each relay carries exactly one
target again. `ensureEgressRelay`'s `const targets = [target] as const` needs no change at all, and —
the part worth noticing — **`relay.ts`'s header sentence "the single container that re-opens exactly one
destination" stays true.** D5 would have had to retire it. The more elaborate option turns out to be the
more conservative one about the property the relay's documentation actually claims. §6.3's plurality
argument is retained below as the record of why a second relay container was once thought expensive,
because that reasoning is what D7 overrides and a reader should see what was traded.

**D7 also removes §6.4's listen-port collision entirely.** Two providers both on `:443` are now two
containers in two network namespaces; each binds `:443` in its own. There is nothing to demultiplex, so
the non-default-port mechanism is not needed, and **§9 Q3 — whether the vendor's load balancer tolerates
a `Host` header carrying a non-default port — stops blocking anything.** §6.4's rejection of SNI
inspection stands as a standing property statement rather than as a live trade.

#### 6.5.5 The costs, named

**More networks, and there is a ceiling.** Each provider in use costs two Docker networks (egress plus
uplink) and one container. Two providers is four networks and two relays where today it is two and one.
Docker allocates bridge subnets from a default address pool, and that pool is finite — this is a
plausible real limit rather than a theoretical one, and it is now the fleet's to manage. §9 Q11 carries
the probe.

**A lifetime model the relay header was not written for.** The header specifies a durable shared
resource: created on demand, adopted by every later `up`, never torn down by `down`, carrying
`--restart unless-stopped` so it returns on every daemon start and reboot **indefinitely, whether or not
a fleet is running**. Removal is manual, and the header spells out a forced three-command order because
Docker will not remove a network with an endpoint attached.

Three consequences, and the third needs a decision:

1. **That manual sequence multiplies by the number of providers ever used.** The strings stay derivable,
   so it is longer rather than harder, but the header's removal instructions must be rewritten from a
   sequence into a per-provider loop.
2. **Sharing narrows from fleet-wide to per-provider**, which is the intended effect and also means
   more containers doing the job one used to do.
3. **A hosted provider's relay would otherwise persist across reboots with no fleet running** — a
   container that re-establishes a standing route to a third party on every boot, long after the run
   that wanted it ended. That is materially different from a relay that points at the operator's own
   machine, and the "never torn down" rule was written when every relay pointed at the operator's own
   machine. **Proposal: a `hosted: true` provider's relay is not created with `--restart
   unless-stopped`, and `down` removes it.** The cost is that it is no longer adopted after a reboot, so
   the next `up` recreates rather than adopts and the ledger's `created`/`adopted` signal changes
   meaning for those relays — which should be recorded rather than left to be discovered.

**`NO_PROXY` becomes per-network.** It is currently derived from `relayListenAliases(config)` over the
whole fleet. Under D7 a worker should receive only its **own** network's relay aliases. Leaving it
fleet-wide is harmless in routing terms — a name that does not resolve on that bridge cannot be dialed
either way — but it would put another provider's hostname into the environment of a worker that has no
route to it, and it would be a second derivation of a fact that now varies per network. Those are
exactly the two conditions that produced ISC-264 and ISC-369.

**The CONNECT proxy's policy stays fleet-wide.** Each per-provider relay still carries the proxy at
`PROXY_LISTEN_ALIAS`, and `proxyPolicyFor` is still built from `egress.allow` plus
`egress.google_hosts`. So a worker with `egress_access: true` reaches the same non-model hosts whatever
network it is on. **This is deliberate and it bounds what D7 buys:** D7 partitions *model* reachability,
not *all* reachability. `worker-env.ts`'s standing limit — *"the grant is per-worker and the reach is
not"* — is unchanged for `egress.allow` destinations.

### 6.6 The credential channel

§12.4 forbids provider keys in `secrets.env_allowlist`, and this is not merely written down —
`buildWorkerEnv` puts `apiKeyEnvName` into its `reserved` set, so a role requesting it is refused with
`SecretReservedNameError`. **An Ollama Cloud key must not go through Class 3, and cannot.**

It is a Class 1 credential: named by `api_key_env`, read from the host environment by the supervisor,
delivered to the worker. But Class 1's justification does not survive the move. §12.4 collapses Class 1
to a single environment variable on the explicit basis that the key *"carries **no billing authority**
— that part of the argument is unconditional."* An Ollama Cloud key is a subscription credential.
**That sentence stops being true, and Class 1's argument has to be re-taken rather than inherited.**

**The proposal: keep the rule, change the delivery.** Class 1 borrows Class 3's *mechanism* without
entering its *grant list*:

- The value is written to `<run-dir>/workers/<id>/secrets/<NAME>` at mode `0444` and reaches the
  container through the existing read-only `/secrets` mount.
- The worker's environment receives `PIFLEET_LLM_API_KEY_FILE=/secrets/<NAME>` — a fleet-owned,
  fixed name carrying a **path**, not the operator's variable name carrying a **value**.
- `docker/entrypoint.sh` reads that file when rendering `models.json`.

This is strictly better than today on three counts and worse on none. It fixes Defect A permanently,
because the entrypoint stops needing to know the operator's chosen variable name at all — the
indirection is a path, and the name is the fleet's. It removes the key from the container's
environment, so `env` and a serialised crash dump no longer disclose it, which is precisely what
ISC-337..342 bought for Class 3. And it keeps §12.4's `env_allowlist` prohibition **intact rather than
repealed**: `env_allowlist` is the operator's grant ceiling, and a provider key is fleet-assigned, not
operator-granted.

**It also keeps a criterion green that would otherwise go red, which is a good sign rather than a
coincidence.** ISC-31 is *"`docker inspect` shows no cloud provider key in any container's environment
(only `OMLX_API_KEY`)"*, and it is machine-checked at two altitudes, both of which execute in CI. An
Ollama Cloud key is precisely a cloud provider key. Delivering it as an environment value would fail
that test; delivering it as a file passes it, and passes it *for the right reason* rather than by
renaming the variable out of the assertion's way. The criterion's parenthetical will still need
restating — under D8 the environment holds a path, not `OMLX_API_KEY` — but the property it asserts
gets **stronger**, not weaker.

**Two costs, stated.** The key still lands in `models.json` on the worker's named volume, because Pi
reads the file and not the environment — that is unchanged from today and is not made worse, but it is
not fixed either. And a worker with `bash` can `cat` the file, exactly as §12.4 already records for
Class 3: *"This narrows the accident, not the agent."*

**One gap this exposes, and it is now measured rather than suspected.** `redactable` in
`buildWorkerEnv` is `[apiKeyEnvName if present, ...secretNames]` and feeds `SECRET_NAMES_VAR`. It is a
set of **names**, and the harvester's needle sweep operates on granted **values** — and the two lists
are not the same list. The sweep reads `launch.secret_names`, which is `envPlan.secretNames`, and that
list deliberately excludes the API key. **So the Class 1 key's name is redacted from logs while its
value is never swept from harvested artifacts.** This is today's behaviour for every fleet, not a
regression introduced here.

It matters more than it used to, and for two compounding reasons: a key with billing authority
appearing in a harvested artifact is a different severity from one without, and D8 puts that key into a
file the worker can `cat` — a plausible route into a transcript. **D15 records the decision and its
cost.** The general shape is the part worth carrying away: the sweep only knows values the fleet
delivered as *grants*, so a Class 1 credential in an artifact is invisible to it by construction.

### 6.7 The IP literal

`relay_upstream` must be an IP literal or the Docker-host alias. The refusal is real and measured — the
relay resolves through Docker's embedded DNS, which forwards to the host resolver, and a hostname there
produces a relay that starts cleanly and fails every connection. There is a second, independent reason
recorded in `fleet.yaml`: the relay publishes `base_url`'s host as an alias on the bridge it is itself
attached to, so a hostname upstream that matches a published alias **resolves to the relay itself** and
every forwarded connection loops back into its own listener, with the client hanging for the full
timeout and nothing in `docker logs` explaining it.

For a hosted provider this rule is worse than inconvenient. §3.1 measured a single A record behind a
global load balancer, no vendor-published static range, and no guidance for firewall allowlisting. The
current pin is already documented as a cost with a re-derivation procedure; a vendor address is a
shorter-lived pin with the same manual chore, duplicated across `relay_upstream` and `egress.allow`,
and a stale pin refuses the fleet at `up` rather than misrouting it — the good failure, but a recurring
one.

**The decision (D9): resolve the name on the host at `up`, and stamp the result into the target — for
`hosted: true` providers ONLY.** For every other provider **the IP-literal rule is retained exactly as
it stands**, unchanged in code and in `fleet.yaml`'s annotation.

The scoping is the whole of the decision, and it is what keeps the trade proportionate. The chore this
removes is only real where the address is somebody else's: a vendor behind a global load balancer with
no published range. For the operator's own oMLX — loopback, a LAN peer, or a tunnel to their own
machine — the address is theirs, it is stable, and re-deriving it is not a recurring cost. **So the
weakening is confined to the blocks where the benefit exists, and the default path keeps the stronger
property.**

Mechanically, for a hosted block: `relay_upstream` accepts a hostname; `up` resolves it **on the host**,
where the resolver is known to answer public names; the resulting literal becomes the target's `host`,
so the relay still dials an address and neither the resolver dependency nor the alias loop can occur;
and the resolution is recorded in the `egress_relay_ready` ledger event beside the script hash, so
*"what did this relay actually dial"* stays answerable after the fact rather than inferred.

`assertTargetsAllowed` then needs the **name** for its policy comparison while the relay dials the
**address**, so `egress.allow` carries `{host: ollama.com, port: 443}` and the operator authorizes a
name. `normalizeHost` and `decide` already match on names — that is how `egress.allow`'s existing
non-LLM entries work through the CONNECT proxy — so this is a change of input, not of mechanism.

**The cost, and it is a real weakening that must not be glossed.** For a hosted block, the gate's
property changes from *"the operator authorized this exact address"* to *"the operator authorized this
name, and the fleet recorded which address that name resolved to at launch."* Between the allow-check
and the dial there is one resolution, performed once and reused, so the window is small — but it is not
zero, and a hostile or compromised resolver moves that relay's dial target without the operator's
`egress.allow` changing.

**What bounds it is that it cannot spread.** A non-hosted provider's block still refuses a hostname at
`config validate`, so the stronger property is not merely the default — it is enforced, and an operator
cannot opt their oMLX into the weaker one by editing a field. Under D7 the blast radius is smaller
again: a mis-resolved hosted upstream moves **that provider's** relay on **that provider's** network, and
no worker outside that provider group has a route to it.

### 6.8 The model probe with two providers

`assertModelsSupportToolCalls` groups by model today; it must group by **(provider, model)** and dial
each group at that provider's `base_url` with that provider's key. Nothing else about the gate changes:
it still runs last, still from a container on the egress bridge, still dials `base_url` verbatim, and
still exits 2 on prose and 3 on everything it did not learn from. The dedupe rationale carries over
unchanged and gets stronger — probing is now metered.

**Two consequences that are new and neither is cosmetic:**

**The probe costs money.** Every `up` sends one real generation per distinct (provider, model) pair. On
oMLX that is GPU time on the operator's own machine, which §5.9 already accounts for. On a metered
provider it is spend, on every bring-up, including the ones that then fail for an unrelated reason.
`/api/show`'s `capabilities` array is a free, unauthenticated pre-check — but it is the vendor's
attestation on a native route, not a measurement of the OpenAI-compat response shape, so it can cheaply
refuse a model that will certainly fail and cannot certify one that will pass. **Proposal: use it as a
fast-fail before the generative probe, never as a substitute** — the generative probe is the one that
tests the path a worker takes, which is ISC-260's entire content.

**This collides with an anti-criterion.** ISC-140 is *"no acceptance test in the `headless` suite
requires provider spend or a cloud endpoint."* A probe that spends on every `up` does not by itself
break it — the acceptance suite does not run `up` against a real provider — but the two are one careless
fixture apart, and the criterion should be re-read rather than assumed to survive.

**`require_native_tool_calls` stays fleet-wide (§6.2), and that has teeth.** A per-provider opt-out
would let a hosted provider quietly leave the gate §5.9 calls mandatory, which is the shape of
relaxation this document exists to avoid. **The gate has now been measured against the real endpoint
and all 19 catalogue models clear it** (§3.1), so keeping it fleet-wide costs nothing today — which is
the best moment to fix its scope, before a future model makes an exception tempting.

**The remaining risk is the clock, not the shape — see D16.** `PROBE_TIMEOUT_MS` is one fleet-wide
constant sized against oMLX cold loads, and §3.1 measures two of the vendor's largest models at 42 s and
57 s against a 60 s ceiling, host-side and unqueued. Through the relay, from a container, on a tier
permitting one concurrent request, those figures only rise, and the result is a `timeout` verdict and a
refused fleet. D16 makes the budget per-provider and gives `models_allowlist` the job of excluding
models measured near the line.

**The `/api/show` fast-fail can now be authenticated at no extra cost.** §3.1 measured one bearer token
serving both `/v1/chat/completions` and `/api/chat`, so the pre-check needs no second credential. It
remains a pre-check and not a substitute, for the reason above: it reads the vendor's attestation, while
the generative probe tests the path a worker takes.

---

## 7. Security model — what changes and what it costs

### 7.1 What is unchanged

Stated first, because the list is longer than the list of changes and a reader should not infer a
broader retreat than is proposed. The `--internal` deny-all bridge is unchanged. The relay's
"destinations `decide()` allows, and nothing else" invariant is unchanged and is now non-vacuously
exercised. `egress.allow` remains the operator's hand-written authorization and remains a separate edit
from the endpoint change — **two edits, one of which is unambiguously a security decision** — which is
the property `assertTargetsAllowed` was built to protect and which two providers do not touch. The
CONNECT proxy's policy is unchanged and still carries no `llm` rule. Class 2's Google-credential
controls are unchanged. `no_context_files: true` is unchanged. The honeypot is unchanged. The verb gate
is unchanged.

### 7.2 Role eligibility — no refusal; the grant is made loud

**Decision (D10): there is no role-eligibility refusal. Every role stays eligible for a hosted
provider, including `observer` and `ticketing`, and the control is prominence rather than
prevention.** An earlier draft of this document proposed refusing a `hosted: true` worker that held
`cloud_access: true` or a non-empty `secrets:`; the owner reversed it.

This follows the precedent this document already set twice — §12.4's Class 2, where a Google identity
enters a container by design and the control is that *"the grant is never silent"*, and §7.3, where a
repository is not refused either. Applying it here makes the treatment consistent: **the fleet does not
decide which of the operator's data is theirs to send. It makes sure they cannot send it without
knowing.**

**The cost, stated plainly and without hedging.** A worker holding a Google identity can now be assigned
a hosted provider, and its `gcloud` and `kubectl` output — resource names, topology, error text — goes
to the vendor. A worker granted `secrets:` can be assigned one too, and although the value is delivered
as a file rather than an environment variable, §12.4 is explicit that this *"narrows the accident, not
the agent"*: the worker can `cat "$NAME_FILE"` and put the value in its own transcript, and that
transcript is context. **Nothing in this design prevents either. There is no ceiling, timeout or scope
that reduces a transcript after it has been sent.**

#### Why this is coherent with D7 rather than careless

This pairing only works because of the option the owner took in §6.5, and it is worth being precise
about why.

**The refusal was mostly a defence against *accidental* reach, and D7 replaces it with a structural
one.** Under the shared-bridge design, the refusal was doing two jobs at once: stopping an operator
configuring a credentialled worker onto the vendor, and standing as the only thing between a
credentialled worker and a vendor endpoint its own bridge could already resolve. The second job was the
important one, and §6.5.1 shows the refusal was bad at it — it stopped the worker being *configured*
for the provider, never its `bash` from *reaching* it.

**Under D7 that second job is done by the network.** A worker not assigned to the hosted provider is on
a different bridge, with no alias for the vendor and no route to it. It cannot reach the endpoint
deliberately, accidentally, or under injection from untrusted repository content. The reach now tracks
the assignment exactly, which is what the refusal was a poor proxy for.

**What survives is deliberate assignment**, and that is a decision the operator takes with their eyes
open, which is precisely the class of thing this codebase handles with a loud grant rather than a
refusal. **Under option (2) this reversal would have been much weaker** — dropping the refusal while
leaving the bridge shared would have removed the only control and left the exposure, which is why the
earlier draft argued for it. Under option (3) the refusal is redundant for the accidental case and
paternalistic for the deliberate one.

**What this does not fix**, and it is the residual to carry forward: a worker deliberately assigned to a
hosted provider *and* holding a credential is exactly as exposed as it sounds. §7.3's banner is the only
control, and §7.4's revisit trigger is written against this case.

### 7.3 The repository is the largest surface, and it is not refused

A `hosted: true` worker with `isolation: worktree` sends source code to the vendor. This document does
**not** propose refusing that, because it is the feature: an `engineer` role with no repository has
nothing to do. The proposal is instead the Class 2 precedent — *"the grant is never silent"*:

**`up` prints, before creating anything, the list of workers whose context will leave the machine.**
With D10's reversal this banner is carrying more weight than the earlier draft asked of it, so it must
name more: for each such worker, the worker id, the role, the provider, the isolation mode and the
repository path if it has one, **and — the part D10 makes load-bearing — whether it holds
`cloud_access` and which `secrets:` names it was granted.** A credentialled worker on a hosted provider
should be the most conspicuous line `up` prints, because it is now permitted and nothing else stops it.

The `hosted: true` declaration is the operator's acknowledgement; the banner is what stops it being
acknowledged once and forgotten. The same facts are written into the run's launch record so a harvested
run can be asked the question afterwards — which matters more under D10 than it did before, because
"was this run's ticket credential exposed to a vendor" becomes a question with a recorded answer rather
than a reconstruction.

### 7.4 Data handling, stated plainly

The vendor's published position is that prompts and responses are processed transiently and not used
for training, and that retention is minimised. **This document does not quote that policy, and
deliberately so** — it was retrieved through a summarising fetch rather than read verbatim, and a
policy claim that a design leans on should be read directly. §9 Q8 carries it.

More importantly, **the policy is not the control.** The operator's exposure is not bounded by what the
vendor promises to do with the data; it is bounded by what is sent. D7's network partition and §7.3's
banner are the controls — the first bounds *which workers can reach the vendor at all*, the second
bounds *whether the operator knows*. A retention policy is a reason to be comfortable, and it can change
without the operator's `fleet.yaml` changing.

**The condition under which this must be revisited**, stated now so the trigger is not a judgement call
later, in the form §12.4 already uses for the LAN and tunnel residuals. D10 permits what the earlier
draft refused, so the trigger has to be written against the case that is now legal:

- **A hosted-provider worker holding a credential is the case to watch.** With D10 there is no refusal,
  so the moment one is configured, §7.3's banner is the entire control. If that configuration becomes
  routine rather than exceptional — if it is assigned once and then inherited by a role, or if an
  operator stops reading the banner because it prints on every `up` — the reversal has stopped being a
  loud grant and become a silent one, and the refusal should be reconsidered.
- **A repository that is not the operator's own to disclose** puts this outside what any control in this
  document addresses, and `hosted: true` should not be set on a fleet pointed at one.
- **If the vendor's retention position changes**, the banner tells an operator what is being sent but
  nothing about what is kept, and §9 Q8 becomes a standing check rather than a one-off.

---

## 8. Recorded decisions

Each entry states what was chosen, what was rejected, and what it costs. **Four points were put to the
owner as open and have been ruled on — D7, D9, D10 and D14. None of them is open now**, and the
sections they touch are written to the ruling rather than to the recommendation this document originally
carried. Where a ruling went against the draft's recommendation, the draft's reasoning is retained as
the record of what was traded rather than deleted; D5, D6 and D10 are the three places that happened.

| # | Decision | Specified in |
|---|---|---|
| **D1** | Bound the §5.9 prohibition rather than repeal it | §0.2, §4, §7.2 |
| **D2** | `llm.providers` as a map; flat keys retained as the default provider's shorthand | §6.1 |
| **D3** | `hosted:` is declared, never inferred | §6.1 |
| **D4** | `models_allowlist` moves per-provider; `require_native_tool_calls` stays fleet-wide | §6.2, §6.8 |
| **D5** | ~~One relay, N targets~~ — **superseded in effect by D7**; each relay keeps one target | §6.3, §6.5.4 |
| **D6** | ~~Distinct listen ports via `base_url`~~ — **dissolved by D7**; the SNI rejection stands | §6.4, §6.5.4 |
| **D7** | **RULED** — per-worker bridges: one network and one relay per provider in use | §6.5 |
| **D8** | Class 1 keeps the rule and changes the delivery: a file pointer under a fleet-owned name | §6.6 |
| **D9** | **RULED** — resolve `relay_upstream` at `up`, for `hosted: true` providers only | §6.7 |
| **D10** | **RULED, REVERSING THE DRAFT** — no role-eligibility refusal; the grant is made loud | §7.2 |
| **D11** | The repository is not refused; the grant is made loud instead | §7.3 |
| **D12** | `tag_style: true` disables thinking-suffix parsing per provider | §8, below |
| **D13** | Fix Defects A and B as prerequisites, not as adjacent cleanup | §2.2, §2.3 |
| **D14** | **RULED** — no budget control for hosted workers in v1; deferred with the reason | §8, below |

### The three that need no argument

**D4 — `models_allowlist` per provider, `require_native_tool_calls` fleet-wide.** The allowlist is a
statement about an endpoint's catalogue and follows the endpoint; the tool-call gate is a statement
about what the fleet will tolerate and must not. A per-provider opt-out would let the hosted provider
leave a gate §5.9 calls mandatory, quietly, at exactly the moment the operator is least able to notice
— the alternative was symmetry for its own sake, and symmetry is not a reason. §2.6's second gap closes
as a side effect: the provider/model pair becomes the unit of validation.

**D11 — the repository is not refused; the grant is made loud.** Refusing `isolation: worktree` for a
hosted worker would leave the `engineer` role with nothing to do, which is to say it would refuse the
feature. The alternative taken is §12.4's Class 2 precedent: the grant is never silent. **The cost is
that a banner is a weaker control than a refusal, and this is the largest single volume of data leaving
the machine.** It is the one place this document accepts prominence in place of prevention, and it does
so because the alternative is not a safer feature but no feature.

**D13 — Defects A and B are prerequisites.** Both are one-line changes and both are independently
wrong today (§2.2, §2.3); neither needs this feature to justify fixing. They are listed as decisions
rather than as cleanup because sequencing matters: **Defect A is what makes a second credential
possible at all**, and shipping the provider map without it produces a fleet that comes up green and
authenticates as nobody. Fix them first, in their own change, with their own tests.

### D1 — bound rather than repeal

**Chosen: §5.9's prohibition is narrowed to a named set of roles and enforced by refusal at `up`.
Rejected: deleting the sentence and re-titling the section a third time.**

The repeal is tempting because it is honest about the direction of travel and because §5.9 has already
been re-titled twice for exactly this reason — enumerating permitted places was the wrong axis, and
"no hosted provider" was the one clause that survived both amendments. But the clause survived because
it is the one thing the other three decisions rest on: §5.9 names it as what deletes `usd_ceiling`,
deletes the provider key, and collapses §12.4's Class 1. Deleting it re-opens all three at once, and
two of them (§6.6, §5.2) are then unresolved rather than decided.

**§2.7 is what makes the choice urgent rather than editorial.** The prohibition is currently enforced
by one check that cannot tell a vendor from the operator, so today the fleet has the *prose* of a
prohibition and the *mechanism* of a preference. Repeal at least makes those agree. Bounding makes them
agree in the other direction and keeps the thing the prohibition was protecting. **What is not
available is leaving it alone**, because leaving it alone means a document that forbids what the code
permits, which is the condition every erratum in `Docs/SRD.md` was written to end.

**The cost of bounding instead: §5.9 becomes a rule with an exception list, which is a weaker thing to
state and a harder thing to check.** The mitigation is that the exception list is machine-checked at
`up` rather than written in prose, which is the difference between §5.10's verb gate and §5.10's
descoped policy rewriter.

### D2 — a map, not a second flat block

**Chosen: `llm.providers: {name: {…}}`. Rejected: a parallel `llm2:` block; rejected: per-worker
`base_url`/`api_key_env` written inline on the worker.**

`llm2:` does not survive a third provider and gives the `provider/` prefix nothing to name. Inline
per-worker endpoints spread a security decision across every worker entry — the relay has to enumerate
the distinct upstreams anyway, so the map is the honest home for them, and it keeps `egress.allow`'s
one-edit-per-authorized-destination correspondence legible.

**The cost: `llm:` grows a nested level, and `fleet.example.yaml`'s annotation of it — already the
longest block in that file — grows with it.**

### D3 — `hosted:` is declared

**Chosen: a required boolean in each provider block. Rejected: inferring it from the URL scheme, the
address range, or whether `relay_upstream` is RFC1918.**

Every inference available misclassifies §5.9's third permitted shape. A private tunnel to the
operator's own machine is `https:`, publicly resolvable, and on a public address, and it is emphatically
**not** hosted — §5.9 spent an amendment establishing exactly that. An inference that is wrong in the
one case a whole amendment was written about is not an inference worth having.

**The cost: an operator can lie to the field.** They can; and so can they set `cloud_access: false` on a
role that needs it. The field is a declaration of intent that the fleet then holds them to, in the same
way `credential: false` is.

### D5 — one relay, N targets — SUPERSEDED IN EFFECT BY D7

**Retained as the record of what D7 traded away.** The owner's ruling on D7 gives each provider its own
network and therefore its own relay, so every relay carries exactly one target and this decision changes
no code. Its argument is kept because D7 is a choice against it, and because of the outcome noted in
§6.5.4: **the sentence this decision was prepared to retire from `relay.ts`'s header survives.** The
"cost" paragraph below is now a cost that is not paid.

**As proposed: extend the target list. Rejected: a second relay container per provider.**

The plurality already exists everywhere except one line (§2.5), and the invariant
`assertTargetsAllowed` enforces is per-target and unchanged. A second container duplicates the name
derivation, the uplink network, the adoption path, the drift detection, the `--restart unless-stopped`
lifetime and the manual teardown sequence, and the one property it buys — independent listen ports on
independent addresses — is only needed if D6's port trick fails.

**The cost is honest and small: the sentence "the single container that re-opens exactly one
destination" stops being true and has to be rewritten in `relay.ts`'s header and in §5.9.** The
guarantee it was standing in for — "exactly the destinations the operator authorized" — is unchanged,
and going from one to two is what makes the check non-vacuous rather than what makes it weaker.

### D6 — distinct listen ports; no SNI inspection — DISSOLVED BY D7

**The collision this decision resolved cannot occur under D7**, because two providers on `:443` are two
containers in two network namespaces. The non-default-port mechanism is not implemented and §9 Q3 stops
blocking. **The second half stands on its own and is not dissolved:** the relay must not learn to read
TLS, for reasons that have nothing to do with this feature.

**As proposed: give the hosted provider a non-default port in `base_url` and dial the real port
upstream. Rejected — permanently, not just here: parsing SNI in the relay.**

The rejection is on a property, not on effort. The relay's safety argument is that it parses nothing:
TLS runs end to end, the worker validates the vendor's real certificate, and no code in the fleet sees
plaintext. Teaching it to read the handshake trades that for a port number, and it would then have to
be re-argued for every destination added afterwards.

**The cost is confusion and one unverified dependency.** `base_url` becomes a URL that is dialable only
from inside the bridge, which will mislead the first person who copies it into `curl`. And the design
assumes the vendor's load balancer tolerates a `Host` header carrying a non-default port — §9 Q3. **If
that probe fails, D5's rejected option is the fallback**, which is why it is recorded with its
distinguishing property rather than dismissed.

### D7 — per-worker bridges: one network and one relay per provider in use

**Chosen: §6.5's option (3). Rejected: option (1), accept and document; rejected: option (2), role
refusals plus one distinct `docker.network` per fleet.** The draft recommended (2) and named (3) as the
only complete answer; the owner took the complete answer. §6.5 is the specification.

**Why (2) was not enough, in one sentence:** it bounded who could be *configured* onto the vendor and
left every worker on the bridge able to *reach* it, which is the gap §6.5.1 measures rather than
predicts.

**Why (1) was arguable and was still rejected.** The fleet's existing posture already accepts that
`egress_access`'s reach is fleet-wide, already accepts §12.8's residual that every port on the bridge
gateway is reachable, and already accepts that a worker with `bash` can route around the verb gate. A
design that demands per-worker network containment for this one destination while those three residuals
stand could be defending the wrong thing at the wrong cost. **The distinction that decided it: those
three residuals bound *capability* against the operator's own infrastructure, and this one bounds
*disclosure* to a third party — and disclosure has no rollback.**

**What it buys**, and these are properties rather than intentions: reach tracks assignment exactly; a
declared-but-unused provider opens no route at all; the cross-fleet relay-replacement hazard is
structurally impossible rather than merely discouraged (§6.5.3); and D5 and D6 both become unnecessary,
which means `relay.ts`'s "exactly one destination" header sentence and the SNI-free splice both survive
unchanged.

**The costs, and they are real: more networks and relays per fleet, and a lifetime model the relay
header was not written for.** Two providers means four Docker networks and two relay containers where
today it is two and one, against a finite address pool (§9 Q11). The relay's documented lifetime —
durable, shared, `--restart unless-stopped`, never torn down by `down`, removed by a manual
three-command sequence — was written for one container pointing at the operator's own machine. §6.5.5
works through what that becomes, and flags the one part that needs its own decision: whether a hosted
provider's relay should persist across reboots with no fleet running, re-establishing a route to a third
party on every boot.

**And it changes what D10 means**, which is the other ruling on this list — see §7.2.

### D8 — the credential keeps the rule and changes the delivery

**Chosen: Class 1's value is delivered as a `0444` file at `/secrets/<NAME>` with a fleet-owned
`PIFLEET_LLM_API_KEY_FILE` pointer in the environment. Rejected: adding the provider key to
`secrets.env_allowlist`; rejected: leaving Class 1 as an environment value.**

The allowlist route is refused by the code as well as by §12.4, and it is the right refusal:
`env_allowlist` is the operator's grant ceiling and a provider key is fleet-assigned. Leaving it as an
environment value preserves Defect A and puts a billing credential where `env` discloses it, at a moment
when §12.4's "no billing authority" justification has just stopped being true.

**The cost: the key still reaches `models.json` on the worker's volume, because Pi reads that file and
not the environment. That is unchanged from today, and this decision does not fix it.**

### D9 — resolve `relay_upstream` at `up`, for hosted providers only

**Chosen: a `hosted: true` block may name a hostname, which `up` resolves on the host and stamps into
the relay's target. Rejected: relaxing the rule for every provider; rejected: keeping the IP-literal
rule everywhere.** §6.7 is the specification.

**The scoping is the decision.** The chore is only real where the address belongs to somebody else — a
vendor behind a global load balancer with no published range. For the operator's own oMLX the address is
stable and re-deriving it is not a recurring cost, so relaxing the rule there would spend a security
property and buy nothing. **The weakening is confined to the blocks where the benefit exists, and it is
enforced rather than defaulted: a non-hosted block still refuses a hostname at `config validate`, so an
operator cannot opt their own server into the weaker property by editing a field.**

**The cost, unchanged from §6.7 and not glossed:** for a hosted block the gate's guarantee weakens from
*"the operator authorized this exact address"* to *"the operator authorized this name, and the fleet
recorded what it resolved to."* A hostile resolver moves that relay's dial target without `egress.allow`
changing. Under D7 the blast radius is one provider's network.

**§9 Q4 remains worth running even though it no longer decides anything.** If the alias loop is a
property of the internal bridge only, the resolve-at-`up` step may be simplifiable — but the decision
does not wait on it.

### D10 — no role-eligibility refusal; the grant is made loud

**RULED AGAINST THE DRAFT.** The draft proposed that `up` refuse a `hosted: true` worker holding
`cloud_access: true` or a non-empty `secrets:`. **Chosen instead: no refusal. Every role stays eligible,
including `observer` and `ticketing`, and the control is §7.3's banner.** §7.2 is the specification.

**The draft's argument, retained because it is what was overridden:** `worker-env.ts` states the
principle for the neighbouring case — *"a comment is not a control"* — a warning is read once and then
becomes scenery, and the failure is not recoverable after the fact, because a transcript that has been
sent has been sent.

**Why the reversal is coherent rather than careless, and it turns on D7.** The refusal was doing two
jobs: stopping an operator *configuring* a credentialled worker onto the vendor, and standing as the
only barrier between a credentialled worker and an endpoint its own bridge could already resolve. **D7
takes the second job away from policy and gives it to the network** — a worker not assigned to the
hosted provider has no alias and no route, so accidental reach is structurally impossible rather than
merely refused. What is left is deliberate assignment, and this codebase's settled answer to a
deliberate grant of the operator's own data is a loud grant, not a refusal: §12.4's Class 2 and this
document's own D11 both take that shape. **Under option (2) this reversal would have removed the only
control and kept the exposure; under option (3) the refusal is redundant for the accidental case and
paternalistic for the deliberate one.**

**The cost, stated plainly:** a worker holding a Google identity or a granted secret **can** now be
assigned a hosted provider, and its `kubectl`/`gcloud` output — or a credential it deliberately `cat`s
out of `/secrets` — crosses to the vendor. Nothing prevents it. The banner is the whole of the control,
and §7.4's revisit trigger is written against exactly this configuration becoming routine.

**What the reversal gains, since a cost list alone would misrepresent it:** the two roles whose latency
would benefit most stay eligible. `observer` reconciles four disagreeing channels at `thinking: high`;
`ticketing` is latency-bound. The draft excluded both, and an operator wanting a faster observer would
have hit that refusal on their first attempt without considering it obvious.

### D12 — `tag_style` disables suffix parsing per provider

**Chosen: a per-provider boolean that turns off `decomposeModel`'s `:thinking` stripping. Rejected:
changing the suffix spelling globally; rejected: leaving the collision latent.**

Changing the spelling — `@high` rather than `:high` — is a breaking change to every existing config for
a collision that is today theoretical. Leaving it alone means a vendor tag rename can silently strip a
tag and produce a `model-not-found` against a name the operator can see is correct. A per-provider
opt-out is narrow, is off by default, and changes nothing for oMLX.

**The cost: a worker on a `tag_style` provider cannot use the `:thinking` suffix at all and must use the
`thinking:` key.** That is a real reduction in expressiveness, on one provider, for the field the merge
rules give the *lowest* precedence to anyway.

### D14 — no budget control for hosted workers in v1

**Chosen: defer. Rejected: resurrecting `usd_ceiling`; rejected: a per-provider price table.** This was
carried as Q7 and the owner ruled it deferred.

**The reason it is safe to defer.** `run.budget.tokens_ceiling` is unchanged and still bounds every
worker, hosted or not — §5.9 made it *"THE ceiling"* precisely because local models have no price table,
and it does not stop working when one provider acquires one. What is absent is a *money* bound, not an
*any* bound, and the admission-control machinery that would enforce one already exists and is
provider-agnostic.

**The cost, and the shape of it is the interesting part: the deferral's bill arrives as availability
before it arrives as money.** §3.2 measured the vendor's concurrency tiers at 1 / 3 / 10 concurrent
requests. The operator's consoles run six Pi processes, and `run.max_concurrent` bounds each *run*, not
the host — §5.9 F40 already records that six panes generating at once is six concurrent requests. **On
the free tier that is six workers against one permitted concurrent request.** So the first symptom of
having no budget control is not an unexpected invoice; it is queueing, then `429`s, then workers that
look wedged. That is a support burden and a stall-detector false positive (§5.9's F20 concern), and it
lands well before spend becomes the binding constraint.

**Revisit trigger:** when a hosted worker runs unattended, or when more than one operator shares a key.
Both turn an unbounded spend from a theoretical risk into an unsupervised one.

### D15 — the Class 1 key is not swept from artifacts, and that must be decided rather than inherited

**This was Q9. It is settled by measurement and the answer is worse than the question assumed.**

**Measured.** The Class 1 key's *name* is redacted from logs but its *value* is **never swept from
harvested artifacts**. `worker-env.ts` builds `redactable = [apiKeyEnvName, ...secretNames]` and feeds
`SECRET_NAMES_VAR`, which arms the redactor. The harvest sweep reads a **different** list:
`harvest/needles.ts:resolveWorkerNeedles` takes `launch.secret_names`, which is `envPlan.secretNames`,
and `secretNames` **deliberately excludes** the API key. The codebase says so in terms:

> *"THE API KEY IS ON IT AND `secretNames` IS NOT WIDENED TO MATCH… `llm.api_key_env` is a Class 1
> credential (§12.4) that no worker requested and every worker carries, so it belongs on the second list
> and would be a lie on the first."*

**That reasoning is correct and should not be undone wholesale.** The two lists mean different things —
one is "values this worker was granted", the other is "names to redact" — and collapsing them would make
`secret_names` claim a grant that never happened. **The general shape of the gap is what matters: the
sweep only knows values the fleet delivered as GRANTS, so a Class 1 credential appearing in an artifact
is invisible to it by construction, for every fleet, today.**

**Why it changes severity here.** For a self-hosted key the residual is small and §12.4 has already
accepted it twice on the explicit basis that the credential carries no billing authority. **A hosted
provider's key is a subscription credential**, so a leak into a harvested artifact is a different event
— and D8 puts that key into a file the worker can `cat`, which is a plausible route into a transcript.

**Chosen: for `hosted: true` providers, the Class 1 key's value joins the needle set.** Not by widening
`secretNames` — that would restore the lie the docblock refuses — but by carrying it as its own
declared field in the launch record, so the harvester learns the value without the grant list claiming
it was granted. The distinction the codebase drew is preserved; what changes is that the sweep stops
being blind to a class of credential.

**Rejected: leaving it and documenting the residual.** That was the honest alternative and it is what
today's behaviour amounts to. It is rejected because §12.6's whole argument for the sweep is that a
credential in an artifact reaches the orchestrator's context, and a billing credential doing so is
precisely the case the sweep exists for.

**The cost: one more value swept means one more chance of a false positive**, which is not hypothetical
— §12.4's `credential: false` erratum exists because a swept value that appears legitimately in every
artifact clamped every verdict. A provider key is high-entropy and unlikely to collide, unlike the
endpoint URL that caused that incident, but the mechanism for declaring an exception already exists if
it does.

### D16 — the probe budget becomes per-provider, and the allowlist gains a second job

**Forced by measurement, not anticipated by the design.** `PROBE_TIMEOUT_MS = 60_000` in
`model-probe.ts` was chosen against oMLX **cold loads on the operator's own hardware** — its docblock
says so. Under this feature the same constant silently becomes the budget for a third party's largest
models over the public internet, and §3.1 measures that as a live risk rather than a theoretical one.

**The measured shape is bimodal, which is why this is a property rather than bad luck.** Seventeen of
nineteen models answered in **≤ 4.4 s**, most under 1.5 s. Two did not: `mistral-large-3:675b` at
**42,114 ms** and `nemotron-3-ultra` at **56,947 ms** — the latter inside the fleet's own ceiling by
three seconds. Third-slowest is 4,374 ms, so **the gap between the two groups is a factor of ten with
nothing in between, and both members of the slow group are the largest-parameter models in the
catalogue.** This is a predictable property of the top of the catalogue and it gets worse as larger
models are added, not better.

**And every one of those figures is a floor.** They were taken host-side, with no relay in the path and
no queueing. Inside a container, through the relay, on a tier permitting one concurrent request against
six Pi processes (D14), both numbers only go up — and `up` then exits non-zero with a `timeout` verdict.
That is the class `model-probe.ts` correctly distinguishes from `prose`, and it is still a refused
fleet.

**Chosen: the probe timeout becomes a per-provider value with the existing 60 s as the default**, so
raising it for a hosted provider does not relax the gate for the operator's own server, and lowering it
stays available for a fast endpoint. **And `models_allowlist` acquires a second, concrete job beyond
naming what exists: excluding models measured near the ceiling.** §6.2 already moves the allowlist
per-provider for a different reason; this gives the same field a hygiene role, and it is the cheaper of
the two controls because it needs no code at all.

**Rejected: raising the constant fleet-wide.** It is load-bearing for the oMLX path — a cold 35B load is
what it was sized against — and a single number serving two very different failure modes is how it came
to be wrong here in the first place.

**The measurement's honest limits, recorded rather than implied:** one sample per model, host-side,
unloaded. That is enough to establish the shape — two clean groups, a tenfold gap, the slow group
identified by parameter count — and **not** enough to characterise the distribution or to treat any
individual figure as stable. A model at 56.9 s against a 60 s ceiling should be read as "on the line",
not as "passing with three seconds to spare".

---

## 9. Open questions

Ten questions were opened on the first draft. **Four are now settled** — three by live measurement
against the real endpoint, one by an owner decision — and a fifth was *dissolved* by D7 rather than
answered. They are listed before the remainder, because a reader of the earlier draft needs to see
where they went, and because "settled" should be auditable rather than a silent deletion.

### 9.1 Settled

| # | Question | Outcome |
|---|---|---|
| **Q1** | Does `/v1/chat/completions` return tool calls in the shape `probeNativeToolCalls` parses? | **YES — 19 of 19 catalogue models**, measured with the repository's own function rather than a hand-rolled request. This was the design's hard gate and the largest thing it rested on; it clears. §3.1 |
| **Q2** | Does one key authenticate both `/api/*` and `/v1/*`? | **YES.** The same bearer token returns `200` on each, so §6.8's `/api/show` fast-fail needs no second credential. §3.1 |
| **Q3** | Does the load balancer accept a `Host` header carrying a non-default port? | **DISSOLVED, not answered.** D7 gives each provider its own network and relay, so §6.4's port-multiplexing mechanism is never built and nothing depends on the answer. Recorded because the question was load-bearing under the rejected design. §3.3, §6.4 |
| **Q7** | Does a metered provider re-open `usd_ceiling`? | **DEFERRED by owner decision — D14.** No budget control for hosted workers in v1. Note the cost arrives as queueing and `429`s (Q5) before it arrives as money. |
| **Q9** | Is the Class 1 key's **value** swept out of harvested artifacts, or only its **name** tracked? | **NAME ONLY — the value is never swept.** Traced `worker-env.ts` → `materialize.ts` → `harvest/needles.ts`. Worse than the question assumed, and the reason D15 exists. §6.6 |

### 9.2 Still open

None of these blocks the design. Where a section depends on one, it says so.

| # | Question | Probe that settles it | Blocks |
|---|---|---|---|
| **Q4** | Does the alias loop `fleet.yaml` records actually occur when the relay resolves from its **uplink** network rather than the internal bridge? Docker's embedded DNS is per-network and the relay is attached to both; the measured loop had `base_url`'s host and `relay_upstream` identical. | Attach a splice container to both networks with the alias on the internal one only, dial the name, and compare against the recorded 10s hang | Nothing now. D9 resolves the name at `up` and stamps a literal, so the loop cannot arise. Answering it would only tell us whether D9's resolution step could later be *simplified* |
| **Q5** | What concurrency tier is in use, and does it clear the fleet's shape? The tiers observed are 1 / 3 / 10 concurrent requests; the consoles run six Pi processes and `run.max_concurrent` bounds each **run**, not the host. | Read the account's tier; then run the fleet and count `429`s | `run.max_concurrent`, and whether `event_stall_warn` must absorb provider-side queueing the way §5.9 F40 requires it to absorb oMLX's. **Also D16** — queueing is what pushes §3.1's slow group past the probe budget |
| **Q6** | Does Pi honour `HTTPS_PROXY` for its own inference calls? Every relay alias is currently put into `NO_PROXY` precisely so it does not, and that was arrived at after a measured `403`. | Set `HTTPS_PROXY` with the alias removed from `NO_PROXY` on a throwaway worker and watch the proxy's log | Only the rejected CONNECT-proxy alternative in §2.5. Recorded because that alternative will be proposed again by someone who has not read this |
| **Q8** | The exact wording of the vendor's retention and training policy. §7.4 declines to quote it because it was retrieved through a summarising fetch. | Read the policy page directly and quote it, or decline to rely on it | §7.4's framing only. Nothing in §7.2 depends on it |
| **Q10** | Is the catalogue stable enough to write a `models_allowlist` against? Vendor material cites model ids absent from today's catalogue, and 19 ids were observed on 2026-09-01. | `GET /v1/models` on a schedule and diff against the recorded 19 | Whether the allowlist is a durable config value or a recurring chore like the address pin |
| **Q11** | Is the `/v1` surface at full parity with a local install's? One third-party report of a `500` on that path for vision models was surfaced and not read. | Exercise the paths the fleet actually uses beyond chat completions; treat the report as a signal to check, not a finding | Nothing known. Raised so parity is not assumed from a passing chat-completions probe |
| **Q12** | What is the *distribution* behind §3.1's latencies? One sample per model, host-side and unqueued, established a bimodal shape; it did not establish that any single figure is stable. | Repeat the sweep n times, through the relay and from a container, and report spread rather than a point | D16's *numbers*, not its shape. D16 is deliberately written to the shape so a shifting figure does not invalidate it |

---

## 10. Hooks for acceptance criteria

**Not criteria — this document does not write them.** What follows is what must become criteria, each
phrased so the probe is obvious, because a criterion whose verification is unclear is one that will be
graded `[~]` forever. A large part of this section is about criteria that **already exist**, which is
the unusual part: this work does not sit in empty space, it lands on top of a closed criterion that
says it must not happen.

**Three criteria are FALSIFIED or made stale by this work, and each needs a decision rather than a
re-check.** These are the ones to look at first.

| ISC | What it says | What this work does to it |
|---|---|---|
| **ISC-259** | *"Every worker's model is served by an oMLX instance the OPERATOR runs — **never a hosted provider** — reached only through a target the operator authorised explicitly, in a second place from the one that names it."* Graded `[x]`, closed 2026-08-28 by owner decision. | **Directly falsified by D1 in either disposition.** Separately and independently of this feature, its closing evidence is already one-third stale — §2.7 measures defence 1 gone, removed by ISC-369. **It should be re-taken now**, before any code lands, because a closed criterion resting on a deleted mechanism is drift regardless of what is built next. The *second* half of its sentence — the two-place authorization, `base_url` naming a target and `egress.allow` authorizing it — **survives D7 intact** and is worth keeping as the part that still holds. |
| **ISC-31** | *"`docker inspect` shows no cloud provider key in any container's environment (only `OMLX_API_KEY`)."* Machine-checked at two altitudes, **both of which execute in CI**. | **Would fail** if the key were delivered as an environment value. **Passes, and asserts something stronger,** under D8 — see §6.6. The parenthetical needs restating either way, because under D8 the environment holds a *path* rather than `OMLX_API_KEY`. This is the criterion most likely to catch a wrong implementation, so it should be updated *after* the code, not before. |
| **ISC-140** | *"Anti: no acceptance test in the `headless` suite requires provider spend or a cloud endpoint."* | Not broken by this design, and one careless fixture from being broken by its implementation — §6.8. The probe now costs real money per distinct (provider, model) pair. |

**Criteria that must be re-read before any of them is claimed to still hold**, because this work moves
something they depend on: **ISC-50, ISC-51, ISC-57** (the relay and the deny-all bridge — under D7 there
are now N of each, which is the relevant change), **ISC-52 / ISC-190** (the allowlist gate and ceiling —
now per-provider), **ISC-53 / ISC-108** (the native-tool-call probe and the runtime prose detector),
**ISC-253** (relay targets judged against a policy they were not derived from — unchanged in kind, and
now applied once per provider), **ISC-260 / ISC-291** (where the probe dials from, and `base_url`
verbatim on the container path), **ISC-263** (the CONNECT proxy — §2.5's rejected alternative),
**ISC-264** (the two-constants lesson, which §2.3's Defect B is another instance of), **ISC-265**
(adoption compares targets — now once per provider relay), **ISC-333 / ISC-337..342 / ISC-388**
(credential sweeping and file delivery — D8 reuses this machinery and D15 changes what is swept),
**ISC-369** (the alias list derived from `base_url` — the criterion that removed ISC-259's first
defence), **ISC-354** (every schema key named in the SRD — `llm.providers` is nested rather than
top-level, so the letter does not bind but the intent does).

`ISC-400` is the highest id in use as of 2026-09-01; a new block starts after it. **This document
deliberately allocates none of them** — `ISA.md` owns that numbering, and two criteria sharing a number
is a worse outcome than a criteria list that needs ids assigned on adoption.

Proposed new criteria, by area:

**Config and merge**
- A `provider/`-prefixed model produces the same provider name in Pi's argv and in the rendered
  `models.json`. *Probe: build the env plan and the argv for one worker and compare; mutation of either
  side fails the test.* (Defect B.)
- A provider named by a worker but absent from `llm.providers` is refused at `config validate` with the
  field and the file.
- Writing both a flat `llm.base_url` and a `providers` entry for the same provider is refused.
- `models_allowlist` is checked against the resolved **provider's** list; a model valid for one provider
  and named on a worker resolving to the other is refused.
- On a `tag_style: true` provider, a model whose tag is one of the six thinking levels keeps its tag.
  *Probe: `decomposeModel` on `p/m:high` with the flag set returns model `m:high`, thinking `undefined`.*

**The entrypoint and the credential**
- `models.json` carries the worker's key when `api_key_env` is **not** the default name. *Probe: render
  the entrypoint's block under `env -i` with a renamed variable and assert `apiKey` is non-empty — the
  probe in §2.2, inverted.* (Defect A.)
- A worker's environment contains no variable whose value equals the provider key. *Probe: assert on the
  serialised env file, which is what `docker inspect` would show.*
- A hosted provider's key file is mode `0444` and its mount is read-only.

**The per-provider network and relay (D7)**
- Two providers in use produce **two egress networks and two relays**, each relay carrying exactly
  **one** target. *Probe: assert on the derived names and on each relay's target list; a relay with two
  targets fails.*
- A provider declared in `llm.providers` that **no worker in this run resolves to** creates no network,
  no relay and no alias. *Probe: declare three, use two, assert the third's derived names are absent
  from `docker network ls` / `docker ps`.*
- **Anti: a worker cannot resolve or connect to a provider it is not assigned to.** *Probe: from a
  worker on provider A's network, resolve provider B's alias and assert NXDOMAIN or connection failure.
  This **inverts** the criterion the shared-bridge design would have needed, and it is the whole content
  of D7 — if it ever passes as a positive again, per-worker containment has silently regressed.*
- The composed relay name is re-checked against Docker's length limit, and an over-long provider key is
  refused at `up` naming the field. *Probe: a provider key long enough to push
  `pifleet-egress-relay-<network>-<provider>` past the limit exits non-zero with the field named.*
- Two providers whose `base_url` names the same port stand up cleanly, because they are in separate
  network namespaces. *Probe: two providers both on `:443`; assert both relays listen and neither
  `listen(2)` fails. This is D6 dissolved, asserted rather than assumed.*

**The gates (D10 — loud, not refused)**
- A worker resolving to a `hosted: true` provider while holding `cloud_access: true` **stands up**, and
  `up` prints a banner naming the worker, the provider and the credential it holds. *Probe: assert the
  banner text on stdout; a silent bring-up fails.* **Note this is the reverse of a refusal** — D10 chose
  prominence over prevention, so the test asserts the warning exists rather than that the run stops.
- The same for a worker with a non-empty `secrets:`.
- `up` prints every worker whose context leaves the machine, and the same list is in the launch record.
  *Probe: parse the launch record; a hosted worker missing from it fails.*
- **Anti: no `hosted: true` worker is ever silently stood up.** *Probe: the launch record's hosted list
  and the printed banner name the same set; a mismatch in either direction fails.*

**The probe, per provider (D16)**
- The tool-call probe dials each provider at **its own** `base_url` with **its own** key. *Probe:
  mutation — point one provider's `base_url` at the other's and assert the refusal.*
- The probe timeout is resolved **per provider**, not from one fleet-wide constant. *Probe: set two
  different budgets and assert each provider's probe uses its own; a shared constant fails.*
- `require_native_tool_calls` remains fleet-wide and has no per-provider override. *Probe: attempt to
  set it inside a `providers` entry and assert the schema refuses it.*

**The harvest sweep (D15)**
- For a `hosted: true` provider, the Class 1 key's **value** is in the worker's needle set. *Probe:
  plant the key's value in a harvested artifact and assert the sweep finds it — today it does not.*
- **Anti: `secret_names` does not claim the Class 1 key as an operator grant.** *Probe: assert the key's
  name is absent from `launch.secret_names` while its value is present in the needle set — the two lists
  stay distinct, which is what `worker-env.ts`'s docblock requires.*

**Reachability as a standing property**
- **Anti: no acceptance test requires provider spend or a live cloud endpoint** (ISC-140, restated for
  this feature's fixtures). *Probe: the `headless` suite passes with no key in the environment.*

---

## 11. References

- `Docs/SRD.md` §5.9 (the LLM is a private oMLX instance), §12.4 (credentials — three classes),
  §12.8 (containment verification), §5.10 (the verb gate), §19 (open questions).
- `Docs/SRD-DEPLOY-OPS.md` — the format sibling, and §0.3's disclosure precedent.
- `src/security/relay.ts` — the header records why each mechanism was chosen; `relayGatePolicy`,
  `assertTargetsAllowed`, `relayListenAliases`, `ensureEgressRelay`.
- `src/security/model-probe.ts` — `assertModelsSupportToolCalls`, `probeNativeToolCalls`,
  `ProbeFailure`.
- `src/security/network.ts` — the `--internal` bridge and the uplink.
- `src/config/schema.ts` — `LlmSchema`, `relayUpstream`, `httpUrl`.
- `src/config/load.ts` — `decomposeModel`, `resolveWorker`.
- `src/run/worker-env.ts` — `buildWorkerEnv`, `SecretReservedNameError`, the proxy-route block.
- `src/config/render.ts` — the Pi argv builder.
- `docker/entrypoint.sh` — the `models.json` render block.
- `fleet.yaml` — the annotated live configuration; the values this document declines to name.
