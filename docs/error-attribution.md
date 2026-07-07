# Honest error attribution (epic #66, phase #68)

Every tool failure carries a **structured error code** that says what ACTUALLY failed, so a calling
agent can never honestly claim "ApparelHub is rate-limited" when ApparelHub returned no such error.
The motivating incident: an agent hit a 429 in its OWN runtime, and — with no attribution signal on
the error surface — confidently reported the ApparelHub image endpoint as rate-limited while
ApparelHub had received no request at all.

## The error classes

| Code | What actually happened | What the agent should do |
| --- | --- | --- |
| `platform_rate_limited` | This API key hit **ApparelHub's own request throttle** (the per-key API Gateway usage plan). ApparelHub returned a plain HTTP 429. | Back off for `retry_after` seconds, then retry. Switching models will NOT help — every model call rides the same key and endpoint. Do not keep hammering. |
| `model_rate_limited` | **One specific model's upstream provider** throttled the generation. ApparelHub accepted the request fine. Carries `source` (the model name) and `retry_after`. | Retry with a DIFFERENT source — the built-in fallback ladder does this automatically. Only back off when the final error is also `model_rate_limited` (the whole ladder was provider-throttled). |
| `request_not_sent` | The HTTP request **never completed** — no response was received from ApparelHub (DNS, connection refused/reset, transport failure), even after the client's own retries. | Do NOT attribute this to ApparelHub — it is a failure at or near the caller. Retry; if several unrelated tools fail at the same moment, suspect the calling agent's own runtime or network. |
| `cancelled` | The caller aborted the request (explicit AbortSignal). | Nothing — this was intentional. |
| `upstream_unavailable` | ApparelHub responded with a 5xx. | Transient platform-side issue; retry shortly (generations also fall back to another model automatically). |
| `generation_timeout` | An async generation never completed within the poll budget. | Retry, or use a faster model; the fallback ladder treats this as fallbackable. |
| `generation_failed` | The generation failed for a non-rate-limit reason (e.g. content policy). | Read the message; usually surface to the user rather than retrying blindly. |

Validation (`bad_request`, `unprocessable`), auth (`auth_required`), permission (`forbidden`,
`workspace_forbidden`), and `not_found` errors surface immediately and are never retried with a
different model — cycling models cannot fix them and would hide the real cause.

## The async structured-error contract

Async models (Nano Banana etc.) report a provider rate limit through the poll status endpoint as a
failed generation whose error string is shaped exactly:

```
model_rate_limited: {source} throttled by provider (retry_after={n}s)
```

for example `model_rate_limited: Nano Banana throttled by provider (retry_after=25s)`. The server
parses this into the same structured `model_rate_limited` error the synchronous path produces
(`source` + `retry_after` populated), so the fallback ladder triggers on the precise code for both
paths.

## Model substitutions are visible

`generate_image`, `design_apparel`, and `iterate_design` return a `fallback_trail` listing every
model that was tried and abandoned (with its `code` and reason) before the one that succeeded. An
empty trail means the first model worked. When the whole ladder is exhausted and EVERY rung failed
with `model_rate_limited`, the final error keeps the `model_rate_limited` code — the honest report
is "the model providers are rate limiting", never "ApparelHub is rate limiting".

## Diagnose before you attribute

Before reporting a failure cause, an agent must read the error CODE — not infer from the symptom:

- A 429 in the agent's own runtime is not an ApparelHub error. If ApparelHub throttled the key, the
  error code says `platform_rate_limited`; if a model provider throttled, it says
  `model_rate_limited`; if there is no ApparelHub response at all, it says `request_not_sent`.
- `request_not_sent` plus several other tools failing at the same moment points at the calling
  runtime or its network — that is where to look first.
- Only report "ApparelHub rate-limited this key" when the code is literally `platform_rate_limited`.
