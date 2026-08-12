# `trust proxy` hop count on the public connector webhook — W3's report

Design reference: `tinychat-webhooks-design.md` §4.4 ("…and `req.ip` under it is an UNVERIFIED
assumption"). W3 owes a report on which failure mode applies.

## §4.4's "mutually exclusive" claim is FALSE — corrected 2026-08-05

§4.4 states that the two failure modes below "are mutually exclusive, and W3 must report which
applies." A code-execution audit falsified that, in the dangerous direction, and this section is
the correction:

> **A spoofable XFF does not make the IP bucket untrippable. It makes it trippable against an
> arbitrary victim IP**, which is strictly worse.

Under `trust proxy 1` the **last** XFF entry wins and the client writes it — measured:
`X-Forwarded-For: 10.0.0.1, 192.0.2.55` and `X-Forwarded-For: 9.9.9.9, 192.0.2.55` land in the
**same** bucket. So an unauthenticated attacker with no token and no secret picks any victim IP,
sends a handful of malformed POSTs, and — while the IP bucket rejected in *middleware* position —
429'd every correctly-signed delivery from that IP for the rest of the window. Since every
legitimate Fireflies delivery for every user arrives from Fireflies' small shared egress range,
that is cohort-wide delivery suppression: the T12/§4.4 outcome the design says must not ship,
reached without the token the threat model assumed was required.

## The two failure modes (both defended, not one chosen)

`backend/src/index.ts` sets `app.set("trust proxy", 1)` — *trust exactly one hop*, so `req.ip`
is the **last** `X-Forwarded-For` entry.

- **If XFF is spoofable** (the CVM port is directly reachable, or the ingress does not rewrite
  XFF), a rotating `X-Forwarded-For` makes any per-IP bucket untrippable *as a cap* — and with it
  the "bounded key space" argument for the token-bucket LRU and T8's enumeration residual — while
  simultaneously making it trippable *as a weapon* against a chosen IP.
- **If XFF is not spoofable**, an IP-only bucket is instead **cross-tenant**: every legitimate
  delivery for every user arrives from Fireflies' small shared egress range.

Because they are not exclusive, both are defended at once:

- The IP bucket keeps its keying and its counting, but is **CONSULTED on the scanner paths only**
  (format-fail / unknown token) — the exemption `scannerFloodTripped()` already implemented for
  the global bucket. A request bearing a **registered** token can no longer be dropped by it, so
  the weapon is disarmed regardless of what the hop count turns out to be. The format check still
  runs before any KV call, so the node-amplification bound is unchanged.
- The middleware `ipPreLimiter` now only **measures** the hop count. It rejects nothing.
- The global bucket is IP-independent, so a rotated XFF cannot uncap the route.
- Both failure classes — registered-token signature failure and unknown token — increment **both**
  IP-keyed buckets, so they are indistinguishable by accounting as well as by status and body.
  Previously only the unknown-token path incremented the IP bucket, which was a deterministic
  three-request oracle for "is this token live?" (T8's non-oracle property failed on accounting).

`(ip, token)` keying remains correct under both modes, which is why the failure bucket that is
tenant-scoped lives inside the handler.

## Verdict at build time: UNDETERMINED — the fallback shipped

The hop count cannot be measured from a build task: it needs a live deploy in front of the
Phala CVM ingress, and this build does not deploy (CI owns deploys). §4.4 permits exactly two
resolutions — a **verified** `trust proxy` value, or a **second, IP-independent global failure
bucket** — so the second one ships:

- `ConnectorWebhookLimiters` carries a global, IP-independent failure counter
  (`globalFailureLimit`, default **5 000 failures / 5 min** across the whole route). Only
  failures count it; a verified delivery never touches it. A spoofed XFF therefore cannot
  uncap the route.
- When it trips it **is** cross-tenant for the remainder of the window. That is the priced
  cost of the unverified hop count, and the trip is logged
  (`[connector-webhook] op=global-failure-trip …`) rather than absorbed silently.
- `trust proxy` is left at `1` — unchanged and still unverified. It is not raised to a guessed
  value; a wrong numeric here is worse than the honest fallback.

## How to close it (one deploy, no code change)

The pre-limiter logs the **number** of `X-Forwarded-For` hops on first sight of each distinct
value — never the addresses themselves (§6.3 forbids them in a world-readable stream):

```
[connector-webhook] op=xff-hops hops=1 trust_proxy=1 t=…
```

1. Deploy with `CONNECTOR_WEBHOOKS_ENABLED=true` and send the §7.4 probe
   (`POST /api/connectors/webhooks/fireflies/probe-token` with a junk signature ⇒ 401).
2. Read the CVM log for `op=xff-hops`.
   - Only `hops=1` from real provider traffic ⇒ `trust proxy 1` is correct; record the
     measurement here and the first failure mode is excluded.
   - `hops=0` ⇒ the CVM port is reachable without the ingress: XFF is spoofable, `req.ip` is
     attacker-controlled, and the global bucket above is the only IP-independent bound.
   - `hops=N>1` ⇒ set `trust proxy` to the verified `N` (or the ingress CIDR) in
     `index.ts` **and** `rate-limits.ts`, which set it in two places today.
3. Whatever is measured, replace this section's verdict with the number and the date. Do not
   drop the global bucket on the strength of a `hops=1` reading alone unless the CVM port is
   also confirmed unreachable directly — the two conditions are separate.

**Operator gate.** Read `op=xff-hops` off a **canary** deploy before enabling
`CONNECTOR_WEBHOOKS_ENABLED` in production. The cohort-suppression primitive above is closed in
code, but a wrong `trust proxy` value still leaves `req.ip` attacker-chosen for the LRU
key-space argument, and the honest way to close that is the measurement, not another guess. If
the measured hop count disagrees with the configured one, set the verified value in **both**
`index.ts` and `rate-limits.ts`.
