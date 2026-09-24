# Verification record

Date: 2026-09-24

- Runtime used: Node.js 24.15.0, npm 11.12.1, Windows.
- Installed direct dependencies: Telegraf 4.16.3, Express 5.2.1, dotenv 17.4.2; exact transitive versions in `package-lock.json`.
- `npm run check`: syntax check and **62 passing tests**, no failed/skipped tests (`/start` and storage recovery update).
- `npm audit --omit=dev --audit-level=moderate`: **0 reported vulnerabilities** when checked on 2026-09-18; dependencies are unchanged by this update.
- Tests exercise real Telegraf middleware with synthetic updates, an in-process Express HTTP server, and actual temporary SQLite databases. Telegram API calls are mocked. They do not need a real bot token.
- Both language dictionaries have matching key structures. Generated message text and callback payloads are checked against Telegram size limits.
- Clinical path tests cover every warning position and fever category in each language, plus fever-duration and vulnerability/hydration combinations.
- Persistence/delivery tests cover duplicate update IDs, stale buttons, rollback and retry, restart recovery, expiry, recipient isolation, rate-limit retry, blocked recipients, and permanent API failures.
- HTTP tests cover webhook secret rejection, JSON/body limits, retryable storage failure, readiness, group exclusion, and an end-to-end Khmer red-alert flow.
- Added real middleware-to-delivery tests for `/start`, both generated language keyboards, greetings/arbitrary text, unknown commands and plain `help`. Expired sessions recover language selection while old clinical buttons stay inert; active clinical questions survive text or old language taps. Duplicate/malformed callbacks and database failures still acknowledge taps; rejected or stalled acknowledgements cannot lose the queued reply. Telegram calls remain mocked.
- Liveness aliases `/`, `/health`, `/healthz` return 200 in polling and webhook modes even when `/readyz` is 503. Retry tests cover launch timeouts, backoff bounds, network/server errors, Telegram `retry_after`, fatal errors and cancellation during reconnect.
- Analytics coverage includes daily HMAC rotation/domain separation, in-memory coordinate coarsening, no identities in reporting tables, consent/expiry, province-only reporting, live/forwarded-pin rejection, outcome/referral deduplication, transaction rollback, restart recovery, additive schema migration, retention, and small-count suppression.
- Real Telegraf location updates are exercised in both opt-in and invalid-message scenarios. Raw pin coordinates and sender/contact metadata are checked for absence from persisted reporting/state/reply payloads. Operational routing chat IDs in the existing outbox remain separate from reporting.
- The report CLI is run against a temporary SQLite fixture; its aggregate JSON and lack of database modification are verified.
- `/start` recovery tests cover all conversation stages, malformed session JSON, the burst limit, and actual read-only SQLite through Express/Telegraf and reply delivery. File-path failure, a real lock held by a second SQLite connection, queue pruning failure and backend changes during an in-flight send exercise memory fallback. Constraint errors are not misclassified as storage availability failures.
- Recovery guidance is tested in both languages without a database read; failed recovery delivery remains retryable. Process handler tests use an isolated event emitter to verify sanitized logging, storage recovery and controlled fatal shutdown. Polling conflicts wait at least 30 seconds and retry only in polling mode.
- On 2026-09-24, the supplied Render service's `/`, `/health`, `/healthz`, and `/readyz` returned HTTP 200 before this change was deployed. This confirms web reachability, not Telegram webhook registration or replies. No production Telegram token or private Render logs were available to confirm the user's exact live outage cause or runtime disk permissions.
- The live service returned 404 for OPTIONS and an unauthenticated empty POST to `/telegram/webhook`, consistent with this application's polling configuration. Readiness now exposes configured transport and public bot username to help distinguish a transport/token mismatch from database recovery problems.

Not performed: real Telegram/BotFather integration, public HTTPS deployment, Docker build on a Linux host, Render volume-permission checks, Android Khmer rendering/comprehension testing, native clinical Khmer review, clinical validation, or telephone confirmation of contacts. Those are clearly documented deployment acceptance steps in `README.md` and `CLINICAL_NOTES.md`.
