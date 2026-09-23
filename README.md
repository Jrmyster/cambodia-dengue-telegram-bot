# Cambodia dengue referral bot

A complete Node.js 24 application using **Telegraf + Express**, English and Khmer Unicode dictionaries, inline keyboards, a finite state machine, and persistent SQLite state/reply delivery. Assessments need no images, GPS, AI calls, or external clinical API. Optional one-time location contributions and detached aggregate reporting are described in [ANALYTICS.md](ANALYTICS.md); live location tracking is not supported.

**Deployment status:** implemented and tested locally with synthetic Telegram updates. No real bot token was supplied, so a live Telegram conversation and cloud deployment have not been tested. This is referral-support software, not a validated diagnostic device. Have a Cambodian clinician and a native Khmer clinical reviewer approve the wording and local referral policy before patient-facing rollout. Provincial directory entries are explicitly marked historical until locally reconfirmed.

## Files

```text
index.js                 Startup, polling/webhook modes, graceful shutdown
locales.js               Complete English and Khmer messages and buttons
src/flow.js              FSM, callback validation, conservative referral tiers
src/referrals.js         Bilingual addresses, phone provenance, optional maps
src/store.js             SQLite transactions, session expiry, update deduplication
src/delivery.js          Durable outbound replies, retry/backoff and rate handling
src/bot.js               Telegraf commands and callbacks; private chats only
src/server.js            Express webhook, secret verification, health endpoints
src/config.js            Validated environment settings
src/analytics.js         Daily keyed dedup, coarse grid and aggregate reporting
src/location-flow.js     Optional province/pin consent and validation flow
scripts/report.js        Read-only internal report with small counts suppressed
test/                    Clinical paths, persistence, delivery and HTTP tests
.env.example             Local configuration template
package.json             Dependencies and commands
package-lock.json        Exact installed dependency versions
Dockerfile / render.yaml Render deployment configuration
CLINICAL_NOTES.md        Policy decisions, evidence and directory review notes
ANALYTICS.md             Reporting schema, privacy, retention and rollout
```

## Local setup

1. Install Node.js **24.15 or later in the 24.x line**. SQLite is provided by Node's `node:sqlite`; no separate database server is needed.
2. Create a bot through Telegram's official **@BotFather**, and copy its token. Disable group joining via `/setjoingroups`; this application ignores group, channel and edited-message updates.
3. In this project folder:

```sh
npm ci
```

Copy `.env.example` to `.env` (`Copy-Item .env.example .env` in PowerShell, or `cp .env.example .env` on Linux/macOS). Set:

```dotenv
TELEGRAM_BOT_TOKEN=your_actual_BotFather_token
BOT_MODE=polling
PORT=3000
DATABASE_PATH=./data/bot.sqlite
SESSION_KEY_SECRET=your_random_secret_at_least_32_characters
SESSION_TTL_MINUTES=30
```

Generate a random secret locally with:

```sh
node -e "console.log(require('node:crypto').randomBytes(32).toString('hex'))"
```

Keep `.env` private. It is excluded from Git and Docker builds. Do not put secrets in source, URLs or command-line arguments. Keep `SESSION_KEY_SECRET` stable across restarts so ongoing sessions remain accessible.

```sh
npm test
npm start
```

Open the bot in Telegram, send `/start`, select **🇰🇭 ភាសាខ្មែរ** or **🇬🇧 English**, then use buttons. Polling works locally without a public URL. Only run **one process per bot token**; polling startup removes any existing webhook for that token. Use a separate development bot when production is running.

Local health endpoints: `http://localhost:3000/health` (also `/` and `/healthz`) returns 200 when the web process is alive, including during Telegram initialization. `/readyz` checks initialization, database access, and whether any reply is older than two minutes. These checks do not prove end-to-end Telegram connectivity when the queue is empty. An endpoint alone does not prevent a free host from sleeping; use the always-on Render configuration provided.

Plain text such as “Hi” or “Hello” opens language selection when no session exists. During an assessment it returns friendly button guidance and the current question without discarding answers; `help` also works without a slash. Language callbacks use `<nonce>:<revision>:language:km` or `:en`. Expired language menus (and older `lang_kh`, `lang_km`, `lang_en` buttons) can recover onboarding in one tap. Expired clinical buttons only open a fresh language menu; they never replay an old symptom answer. Callback acknowledgements are awaited with a two-second budget independently of durable reply delivery.

## Commands

| Command | Action |
|---|---|
| `/start` | Reset assessment and choose language every time |
| `/resume` | Repeat the current question/result after losing connectivity |
| `/prevention` | Water-container, Abate and mosquito-bite checklist |
| `/emergency` | Immediate ambulance guidance, then area/referral buttons |
| `/cancel` | Clear active bot answers and unsent replies |
| `/help` | Show commands and urgent-care instructions |
| `/location` | Optional coarse location or province-only contribution |
| `/referral` | Health Center referral guidance and available hospital contacts |

No typing is required after `/start`. Question and utility screens include navigation buttons. Emergency and prevention pages preserve the current assessment. If either command is used before language selection, the bot shows bilingual emergency guidance immediately and opens the requested page after a language tap. Optional `/location` first explains reporting and asks for a province; a static pin can then be attached or skipped with the province-only button. It is not part of triage and must never delay emergency care.

## Triage behavior

```text
/start → language → introduction → fever → duration (if any fever)
       → five warning questions → higher-risk circumstances → hydration
       → referral advice

Any warning YES     → RED immediately; no remaining questions
Any warning UNSURE  → urgent YELLOW immediately; seek assessment now
```

| Tier | Trigger | Advice |
|---|---|---|
| Red | Any listed warning sign, even without fever | Nearest emergency-capable hospital now; 119; conditional ORS guidance |
| Urgent yellow | Uncertain danger sign, higher-risk circumstances, reduced drinking/urine, uncertain fever/history, or fever longer than 7 days | In-person assessment now; possible danger signs require emergency care |
| Yellow | Any current/recent fever, including mild fever or fever that has subsided, without the above factors | Health Center today, within 24 hours at the latest; clinician decides tests |
| Green | No recent fever, all five warning signs denied, normal drinking/urine and no higher-risk factors | General care, close monitoring, seek advice if symptoms persist/worsen |

The requested green category is deliberately narrowed: **mild fever is not enough to exclude dengue**. The bot does not label symptoms “non-dengue,” calculate a diagnostic score, or interpret NS1/CBC results. Fever duration of 2–7 days is captured but never used to exclude illness outside that window. See the evidence and clinical limits in [CLINICAL_NOTES.md](CLINICAL_NOTES.md).

## Deploy on Render

The included Blueprint uses a paid web instance and persistent disk. Check the current plan/cost in Render before provisioning. No cloud service is created by this project.

1. Put the **contents of this project folder** in a private Git repository. Commit the lockfile; never commit `.env`, `data/`, or `node_modules/`.
2. Create a Render **Blueprint** from that repository using `render.yaml`. Alternatively, create a Docker web service manually with the same settings. If using a monorepo, set this project as the root directory and select its Blueprint.
3. Supply `TELEGRAM_BOT_TOKEN` and your exact Render HTTPS origin for `PUBLIC_URL`, e.g. `https://your-service.onrender.com`. No path or query string. The Blueprint generates separate session and webhook secrets.
4. Keep `BOT_MODE=webhook`, `DATABASE_PATH=/app/data/bot.sqlite`, the disk mounted at `/app/data`, and **one instance**. The service account must be able to write that mount. The container runs as user `node` (UID 1000); set mounted volume ownership if your host requires it.
5. Deploy. Startup registers `/telegram/webhook` with Telegram using `WEBHOOK_SECRET`. It also registers English and Khmer command menus. If the platform assigns the public hostname only after creation, update `PUBLIC_URL` to the assigned origin and redeploy.
6. Confirm `/readyz` returns 200 and complete the manual smoke scenarios below with a dedicated test chat before sharing the bot.

The host terminates HTTPS; Express listens on the host-provided `PORT`. The webhook checks Telegram's `X-Telegram-Bot-Api-Secret-Token` header with a timing-safe comparison before parsing JSON. It acknowledges only after the session, update ID and reply have committed together. A database failure returns 503 for Telegram to retry.

Render persists only the mounted disk. Its persistent disks are tied to a single instance, and deployments with a disk have operational constraints; consult [Render persistent disks](https://render.com/docs/disks) and the [Blueprint reference](https://render.com/docs/blueprint-spec). The supplied compute plan identifier was checked against that reference on 2026-09-18.

The same Docker image can run on another host with public HTTPS, environment secrets, an always-on single instance and a writable persistent volume. An ephemeral filesystem or a sleeping development workspace is unsuitable for reliable emergency referral support.

## Reliability and privacy

- **Atomic state + durable outbox:** Telegram update IDs are deduplicated for 48 hours. Repeated callbacks carry a random session nonce and revision; old buttons cannot answer a new question. SQLite writes occur synchronously in transactions, so concurrent callbacks cannot overwrite each other's answers within this process.
- **Delivery semantics:** outbound replies retry after transient failures and respect Telegram `retry_after`. A successful send followed by a crash before the database delete may produce a duplicate reply; Telegram `sendMessage` has no application idempotency key. This is at-least-once delivery, not exactly once. Old duplicated question buttons remain inert.
- **Throughput:** one worker, approximately 16 messages/second maximum before API latency, at least 1.1 seconds between queued messages to one chat. A delayed chat does not block other chats except during Telegram's global 429 cooldown. A 40-updates/minute per-chat burst cap excludes emergency/cancel and positive warning callbacks. Excess ordinary requests are ignored until the next window; limited callbacks display a localized notification.
- **Emergency priority:** a red result replaces that chat's unsent messages. A send already in flight cannot be recalled. `/start` and `/cancel` also clear pending replies, except a send already in flight.
- **Retention:** active answers expire after 30 minutes of inactivity (configurable 5–60). The session key is an HMAC of the private chat ID. Answer details are cleared when the result is computed, while the result tier remains until expiry/cancel. The outbox temporarily stores the chat ID and rendered response until delivery or expiry. Update deduplication stores only IDs and expiry timestamps; burst limits retain pseudonymous keys for one minute.
- **Aggregate reporting:** separate tables store daily outcome/referral counts (365 reporting days) and voluntary coarse-grid/province counts (90 reporting days), without Telegram identities or links to individual assessments. Purpose-specific daily HMAC dedup markers expire within 24–48 hours. Operational retention above is unchanged. See [ANALYTICS.md](ANALYTICS.md) for consent, limits and `npm run report`.
- **Outage policy:** queued clinical text expires after the same TTL instead of arriving as old triage advice after a prolonged outage. Purging runs every minute while the worker is active, so physical cleanup may lag the TTL by approximately a minute or until the process recovers. Expired unsent replies log a count; they are not silently described as delivered. Users can restart with `/start` or `/resume`.
- **Logging:** structured operational events only. Do not enable Telegraf debug logging, request-body capture, or proxy logging of secrets. No raw message text, names, phone numbers, usernames, or medical records are stored as input. Free text is not clinically analyzed and receives button guidance.
- **Data protection:** restrict disk access and use host disk encryption. SQLite `secure_delete` and WAL checkpoints reduce remnants but do not guarantee secure erasure from disks, snapshots or backups. Telegram chat history is separate and is not removed by `/cancel`. Do not tell users this is an end-to-end encrypted medical record channel.
- **Operations:** monitor readiness, `delivery_retry`, `delivery_worker_failed`, `expired_undelivered_messages`, disk space and host restarts. A permanent Telegram 400/401 delivery failure fails the process visibly and preserves the queued item for investigation. A 403 block clears that recipient's local state/queue. Use the host's restart policy; do not leave an invalid payload in an endless restart loop.
- **Telegram reconnects:** Telegraf retries transient `getUpdates` failures internally. Initialization and polling launch also retry network timeouts/resets, 429s and server failures, logging only `telegram_retry` or `polling_retry` and the delay. Backoff increases from one to sixty seconds (or Telegram's longer `retry_after`). Invalid credentials, a second poller (409), and storage/programming failures still fail visibly. Reconnects do not discard pending Telegram updates. The health server starts before Telegram API initialization.
- **Scaling:** do not run multiple workers against this SQLite database. For multiple replicas, replace storage with a shared transactional database and implement outbox row claiming/leases and per-user serialization. This implementation is intentionally a single-instance service.

## Verification and release

`npm test` uses Node's test runner, real Telegraf middleware, local HTTP requests and temporary SQLite databases. No real token or external network is required by the tests. Coverage includes both languages, every warning/fever branch, duration boundaries, vulnerability/hydration combinations, locale parity, message/callback size limits, stale/forged buttons, restart persistence, transaction rollback, TTL, user isolation, webhook authentication/body limits, and delivery retries.

Before rollout, use a test bot to manually check:

1. Each language from `/start`; each of the five warning signs must produce red immediately.
2. High fever and mild fever with all other answers normal produce yellow. Fever that has fallen must not produce green.
3. No recent fever with normal answers produces green with explicit limits; uncertain danger signs produce urgent advice immediately.
4. `/emergency` before onboarding gives 119 immediately; area buttons display contacts and readable Khmer addresses.
5. Double taps, old keyboards, `/cancel`, restart and an actual reconnect behave safely.
6. Read and confirm the Khmer wording on low-cost Android devices, including clinical comprehension with parents/community health workers.
7. Confirm local hospital contacts, catchment areas, transport arrangements and clinical policy with the deployment partner. Do not perform test calls to emergency services.

Test success establishes software behavior, not clinical validation. Actual Telegram delivery, Android font rendering, cloud disk permissions and local clinical/contact approval remain deployment acceptance steps.
