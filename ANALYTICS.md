# Aggregate reporting and optional location contribution

This feature records **service use and voluntary community reports**, not confirmed dengue cases, disease incidence, or measured mosquito/vector risk. The clinical decision rules are unchanged. In particular, urgent yellow remains distinguishable from routine yellow in the reports.

## User flow

`/location` (also available as an optional button after results) opens a bilingual explanation. The user chooses one of Cambodia's 25 provinces/capital or “Not sure / outside Cambodia,” then sends a static Telegram location pin or taps **Province only**. Coordinates are reduced in memory to a **0.1-degree grid cell center** (approximately 11 km north/south) before any SQLite insertion. Users are encouraged to choose a nearby public place instead of their home. No external geocoding service receives the pin; the province is explicitly self-reported and is not verified against administrative boundaries.

Unsolicited pins are discarded and open the consent explanation instead. They are never cached for later insertion. A new pin must be sent after selecting a province. Live and forwarded locations are rejected; edited messages and group/channel messages remain ignored. `/resume`, `/cancel`, `/start`, and emergency navigation leave or clear the optional reporting flow. A location report is not a request for transport, medical follow-up or dispatch.

`/referral` offers local Health Center referral guidance and access to the existing referral-hospital directory. No verified individual Health Center directory is invented. `/emergency` and area-selection buttons also count referral demand. The selected referral area is **a requested care area, not inferred residence or infection location**.

## Additive SQLite schema

The existing `DATABASE_PATH` remains `./data/bot.sqlite` by default. On startup, `Store` adds three tables with `CREATE TABLE IF NOT EXISTS`; existing session/outbox data is preserved. No manual migration command, new dependency, or extra environment secret is required.

| Table | Stored columns | Purpose / retention |
|---|---|---|
| `analytics_events` | `day`, `recorded_at`, `event_type`, `region`, `region_basis`, `count` | Daily aggregate counters, retained for 365 reporting days |
| `location_reports` | `day`, `recorded_at`, `province`, `cell`, `latitude`, `longitude`, `report_count` | Daily coarse-grid counters, retained for 90 reporting days. Province-only contributions use `cell='province_only'` and NULL coordinates |
| `analytics_dedup` | `daily_hash`, `expires` | HMAC-SHA256 markers to prevent repeats, expiring at the end of the following reporting day (24–48 hours) |

`day` uses **Asia/Phnom_Penh (UTC+7)**. `recorded_at` is epoch milliseconds for the **start of that reporting day**, not the exact submission time. The server's receipt day is used, not the sender-provided timestamp. There are no individual event rows or foreign keys connecting the aggregate tables to users, updates, sessions, or each other. Location counts cannot be joined to a particular assessment or severity result.

Event types:

- `RED_FLAG_ESCALATION`: a warning was answered yes and immediately triggered red referral.
- `YELLOW_MONITORING`: completed routine yellow assessment.
- `URGENT_ASSESSMENT`: completed urgent yellow assessment, including an uncertain warning sign.
- `GREEN_PREVENTION`: completed green result; this name does not imply absence of disease.
- `REFERRAL_CONTACT_REQUEST`: opening referral guidance or selecting a directory area. The directory opening uses `region='unknown', region_basis='not_reported'`; an area choice uses `region_basis='requested_care_area'`.

Triage counts always use unknown/not-reported region. This deliberately avoids linking location submissions to clinical outcomes. A separate future design and public-health review would be needed for geographic disease-incidence analysis.

## Deduplication, privacy and limits

- Report tables contain **no Telegram chat/user IDs, usernames, names, phone numbers, session hashes or exact coordinates**. The handler only passes coordinate numbers and boolean live/forwarded flags; it never persists the incoming message, contact attachment, or sender object.
- Daily hashes are **pseudonymous**, not anonymous identifiers. HMAC uses the existing `SESSION_KEY_SECRET`, the Cambodia reporting day and a purpose-specific domain. It is separated from the operational session key and from other analytics categories. An unkeyed hash of a public/predictable Telegram ID is not used.
- Outcome/directory deduplication includes the assessment nonce. A CHW can start another assessment for another patient on the same day and it is counted separately. Resuming a result, repeating a directory button, double taps and webhook retries do not create another count for that assessment/category/area. Never sum directory openings and area requests as unique people.
- Location deduplication deliberately allows **one voluntary location contribution per Telegram account per day**, across restarts and new assessments. Subsequent pins cannot move or add a contribution that day. Multiple people can share an account, and one person can use several accounts; these are neither unique-person counts nor a representative population sample.
- State changes, counters, dedup markers and outbound replies commit together in the existing SQLite transaction. A failed commit rolls everything back, so a Telegram retry can safely retry the contribution.
- The **existing operational** `sessions`, `updates`, `limits` and `outbox` tables are distinct from reporting. The outbox still temporarily holds a chat ID to deliver replies, and sessions still hold the previously documented HMAC key and short-lived triage answers. No claim is made that the entire operational database or Telegram transport is anonymous. Restrict access to the full database and use host disk encryption.
- Telegram and the running bot necessarily receive the original pin. Database tables omit it, but chat history and any externally configured request-body logging may still retain it. Keep body/debug logging off; users can choose province-only instead. This is why the English prompt does **not** promise “completely anonymous.” The requested Khmer invitation is followed by an explicit explanation of these limits.
- `/cancel` clears the active session and queued messages, **not** an already pooled contribution. Because reporting rows have no user linkage, an individual contribution cannot be located and removed later. Dedup markers remain until expiry to prevent repeats after cancellation. The invitation explains this before collection.
- Retention cleanup runs during the existing worker prune cycle (roughly once per minute while running). On an offline/stopped service, physical deletion waits until restart; disk backups/snapshots have their own retention and cannot be reliably erased by SQLite cleanup.

## Internal aggregate report

```sh
npm run report
npm run report -- --date 2026-09-18
```

The first command reports yesterday in Cambodia time. The second accepts any valid **completed** reporting day. The command reads `DATABASE_PATH` read-only and emits JSON containing coarse locations and event counters with **counts of at least 5**. It suppresses lower-count rows and offers no user-level query or public HTTP endpoint. Unknown or missing cells may be suppressed; they must not be interpreted as zero. There is no automatic upload or publication of analytics to GitHub or another service.

The minimum cell count is a safeguard, not a formal anonymity or differential-privacy guarantee. Do not distribute raw tables, expose the entire SQLite database, repeatedly release overlapping breakdowns, or present these counts as diagnosed dengue prevalence. An authorized public-health partner must review sampling, repeat assessments, shared accounts, disclosure risk and interpretation before releasing a report. `reports/` is ignored by Git and Docker so exports placed there do not enter the code repository.

## Deployment

Restart/redeploy the existing single-instance bot from the new commit with the **same persistent volume and SESSION_KEY_SECRET**. New tables are created automatically. Keep one worker per SQLite database; no existing data is dropped or rewritten. Changing the session secret during a day invalidates deduplication and may permit extra contributions.

Publishing this code to GitHub does not itself verify a cloud deployment. If a connected host auto-deploys from `main`, monitor its deployment, `/readyz`, logs and disk access. Manually verify both language flows on a dedicated test bot before rollout. Clinical Khmer review remains necessary, including the new consent and reporting explanations.

Technical reference: [Telegram Location](https://core.telegram.org/bots/api#location). The code uses Telegraf's `bot.on('location', ...)` before its generic message handler; `location` remains inside the already-enabled Telegram `message` update type.
