# Pricing policy log

## Initial controlled verification

Scope: the standalone `antseed-surplus` seller only; the old Venice installation stays stopped and unchanged. Health probes disabled. One canonical model, `openai-gpt-oss-120b`, through Surplus with native Groq provider pin and AntSeed blocked as an upstream.

The initial reference-envelope estimate advertised input/cache `$0.170210527` and output `$0.729473685` per million tokens. It successfully served and settled the first controlled request, but its historical formula did not explicitly separate the AntSeed fee; current source now does.

## Live-book competitive estimate

Verified 2026-10-28T11:50:13Z. Explicit operator policy `basis: live-book` uses the maximum eligible healthy/available pinned-Groq public offer I/O components, cache charged at input, a 10% Surplus account-fee cushion, 5% safety allowance, 4% AntSeed protocol fee, and 5% target gross margin:

```
upstream_estimate = max_eligible_public_class_rate × 1.10
advertised = ceil_1e-9(upstream_estimate × 1.05 / 0.95 / 0.96)
```

Published per-million rates, independently read from direct AntSeed metadata:

- Input/cache: `$0.070921053`.
- Output: `$0.303947369`.

The gateway sends the eligible-offer discount floor through `/minN/v1/chat/completions`, not only the feature-gated header. It also requests upstream streaming usage, pins `api.groq.com`, disables affinity caching, and blocks AntSeed upstreams.

A paid streaming control passed and settled 282 micros gross / 271 net versus 2 micros SI charge. These are dust-test inference spreads, not net profits after gas/hosting. The rates target a small margin above a conservative eligible-supply estimate, not necessarily the cheapest offer that actually wins routing.

Rollback: stop the standalone process, remove `basis: live-book` (or set `reference-envelope`) in the private pricing policy, regenerate prices, inspect them, then restart. Never reset the private payment/revenue journal. Any price increase/freshness/policy failure stops serving rather than silently changing already advertised rates. Policy expiry remains explicit and bounded; see README.

Monitor actual `buyer_cost_micro`, AntSeed gross/net settlement, provider failures, gas and organic traffic separately. Public quotes lack some per-account/per-offer dimensions, so neither mode guarantees profit or an absolute upstream charge ceiling.
