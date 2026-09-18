# Verification record

Date: 2026-09-18

- Runtime used: Node.js 24.15.0, npm 11.12.1, Windows.
- Installed direct dependencies: Telegraf 4.16.3, Express 5.2.1, dotenv 17.4.2; exact transitive versions in `package-lock.json`.
- `npm run check`: syntax check and **40 passing tests**, no failed/skipped tests (analytics feature update).
- `npm audit --omit=dev --audit-level=moderate`: **0 reported vulnerabilities** at the time checked.
- Tests exercise real Telegraf middleware with synthetic updates, an in-process Express HTTP server, and actual temporary SQLite databases. Telegram API calls are mocked. They do not need a real bot token.
- Both language dictionaries have matching key structures. Generated message text and callback payloads are checked against Telegram size limits.
- Clinical path tests cover every warning position and fever category in each language, plus fever-duration and vulnerability/hydration combinations.
- Persistence/delivery tests cover duplicate update IDs, stale buttons, rollback and retry, restart recovery, expiry, recipient isolation, rate-limit retry, blocked recipients, and permanent API failures.
- HTTP tests cover webhook secret rejection, JSON/body limits, retryable storage failure, readiness, group exclusion, and an end-to-end Khmer red-alert flow.
- Analytics coverage includes daily HMAC rotation/domain separation, in-memory coordinate coarsening, no identities in reporting tables, consent/expiry, province-only reporting, live/forwarded-pin rejection, outcome/referral deduplication, transaction rollback, restart recovery, additive schema migration, retention, and small-count suppression.
- Real Telegraf location updates are exercised in both opt-in and invalid-message scenarios. Raw pin coordinates and sender/contact metadata are checked for absence from persisted reporting/state/reply payloads. Operational routing chat IDs in the existing outbox remain separate from reporting.
- The report CLI is run against a temporary SQLite fixture; its aggregate JSON and lack of database modification are verified.

Not performed: real Telegram/BotFather integration, public HTTPS deployment, Docker build on a Linux host, Render volume-permission checks, Android Khmer rendering/comprehension testing, native clinical Khmer review, clinical validation, or telephone confirmation of contacts. Those are clearly documented deployment acceptance steps in `README.md` and `CLINICAL_NOTES.md`.
