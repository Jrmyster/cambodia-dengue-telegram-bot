# Verification record

Date: 2026-09-18

- Runtime used: Node.js 24.15.0, npm 11.12.1, Windows.
- Installed direct dependencies: Telegraf 4.16.3, Express 5.2.1, dotenv 17.4.2; exact transitive versions in `package-lock.json`.
- `npm run check`: syntax check and **23 passing tests**, no failed/skipped tests.
- `npm audit --omit=dev --audit-level=moderate`: **0 reported vulnerabilities** at the time checked.
- Tests exercise real Telegraf middleware with synthetic updates, an in-process Express HTTP server, and actual temporary SQLite databases. Telegram API calls are mocked. They do not need a real bot token.
- Both language dictionaries have matching key structures. Generated message text and callback payloads are checked against Telegram size limits.
- Clinical path tests cover every warning position and fever category in each language, plus fever-duration and vulnerability/hydration combinations.
- Persistence/delivery tests cover duplicate update IDs, stale buttons, rollback and retry, restart recovery, expiry, recipient isolation, rate-limit retry, blocked recipients, and permanent API failures.
- HTTP tests cover webhook secret rejection, JSON/body limits, retryable storage failure, readiness, group exclusion, and an end-to-end Khmer red-alert flow.

Not performed: real Telegram/BotFather integration, public HTTPS deployment, Docker build on a Linux host, Render volume-permission checks, Android Khmer rendering/comprehension testing, native clinical Khmer review, clinical validation, or telephone confirmation of contacts. Those are clearly documented deployment acceptance steps in `README.md` and `CLINICAL_NOTES.md`.
