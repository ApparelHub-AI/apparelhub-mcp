# Remote MCP connector — cost, rate-limit, abuse & observability (epic #31, phase #36)

How a hosted connector's traffic and spend are bounded and made visible. Most controls are
**inherited** from the platform (the connector resolves to a real ApparelHub account + key), so this
phase mostly adds the **observability** layer on top.

## Rate limiting — per connector identity (inherited)

Every connector identity resolves (via OAuth) to the user's connector API key, which is attached to
an AWS API Gateway **usage plan** when it's minted (`get_or_create_connector_key` on the platform):
the account tier's plan if it has one, otherwise the **Default** plan — 10 req/s, burst 20,
10,000 requests/month. A runaway connector is throttled at the gateway before it ever reaches a tool.

## Paid-op spend cap — image generation (inherited)

Image generation is the only metered paid operation the tools expose. It gates on the account-level
**lifetime** counter, `MembershipService.check_limit(user.id, 'image_generation')`, which is shared
across the web, agent, and connector surfaces (one counter per account). A connector therefore
cannot exceed the account's image cap — the cap is enforced platform-side on every generate call,
regardless of surface.

## Abuse gating (inherited)

Connector access requires an ApparelHub account and an OAuth-linked connector key; account signup is
reCAPTCHA-gated, and connector keys count against the account's `api_key_limit`. Revoking the grant
(or the gateway kill-switch) cuts access.

## Observability — this phase

The hosted Lambda emits **one CloudWatch Embedded Metric Format (EMF) line per request**
(`src/http/metrics.ts`), so connector traffic shows up as metrics with **no** `PutMetricData` call —
CloudWatch Logs auto-extracts them:

- **Namespace:** `ApparelHub/MCP`
- **Metrics:** `Requests` (Count), `LatencyMs` (Milliseconds)
- **Dimensions:** `Outcome` (`ok` / `unauthorized` / `rate_limited` / `client_error` /
  `server_error`) and, for `tools/call`, `ToolName`. **No per-identity dimension** — deliberately
  low cardinality and no user data in metrics.
- The unauthenticated `/healthz` liveness probe is excluded so it doesn't drown the real signal.

A **`${stack}-connector` CloudWatch dashboard** (in the hosted SAM stack — one per account, since the
dev stack deploys to the dev account and the prod stack to the prod account) shows: requests by
outcome, tool-call volume by tool, latency p50/p99 by outcome, and the hosted Lambda's own health
(invocations, errors, throttles, duration p99).
