# Experimental Claude JSON keepalive

`KIN_JSON_KEEPALIVE_DELAY_MS=30000` enables delayed whitespace padding for
authenticated, admitted, non-streaming Claude slot requests on `/v1/messages`.
The default is `0` (off). Positive values are capped at 90000 ms. Streaming,
Codex, API-channel and ordinary panel responses retain their existing behavior.
After the initial delay, padding is emitted every 10 seconds. The existing
upstream timeout bounds the whole operation. Authentication, quota admission
and policy validation complete before the padding timer is armed.

The final successful body is still one JSON document. The prefix consists only
of JSON whitespace; no SSE events or partial message objects are emitted.
Responses use `no-store, no-transform` and disable proxy buffering. Actual
proxy/SDK behavior must be verified before enabling this behind a new ingress.

## Failure behavior

Before padding, errors keep their normal HTTP status and headers. After padding,
HTTP 200 is already committed: a later failure destroys the incomplete response,
so clients must reject the body rather than accept an error object as a successful
message. This loses the original downstream HTTP error status and can affect
client retry policy. The original failure status is kept in usage logs; client
cancellations are recorded as 499 and the keepalive deadline as 504.

## No-inference ingress test

An administrator may temporarily enable the bounded diagnostic by creating
`data/run/json-keepalive-probe.json` locally, mode 0600, containing
`{"enabled_until": <Unix milliseconds within the next 15 minutes>}`.
Without this file, with an expired value, or with an excessive expiry the route
returns 404. Delete the file immediately after verification.

`POST /api/panel/diagnostics/json-keepalive?scenario=success` requires normal
panel administrator authentication (a managed model key cannot call it). It
waits 150 seconds and returns fixed JSON with zero inference calls. At most two
diagnostics run concurrently. Additional scenarios:

- `baseline`: same delay without padding, for comparison with a proxy timeout.
- `early-error`: ordinary HTTP 503 before padding.
- `late-error`: abort after 35 seconds, after padding has committed headers.
- `timeout`: a bounded 35-second transport deadline.

Check the first body chunk, final JSON parse, cancellation, and late failure
through the real public ingress. Never use an account's live prompt for this
diagnostic and never print authentication headers.

## Rollback

Set `KIN_JSON_KEEPALIVE_DELAY_MS=0` and recreate only the control service using
the existing deployment workflow. No database migration or slot rebinding is
needed. Remove the diagnostic enable file independently of this setting.
