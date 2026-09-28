# Python bot repair and Render cutover

Prepared 2026-09-28 for `@kh_dengue_bot`.

## What was found

The checked-out repository currently deploys **Node.js/Telegraf**, not Python. Its root Dockerfile starts `node index.js`. The supplied production logs included `polling_conflict`, which establishes a conflicting Telegram polling request at that time. That can be temporary during overlapping deployments or persistent if another service/local bot keeps running. It does not identify the competing host. An expired-button response is an application state check; it does not itself establish a webhook or transport failure.

These files form a separate native Python implementation in `python-bot/`. Adding `main.py` alone will not change the existing Docker service. The cutover below changes the runtime and stops the old poller explicitly.

## Deliverables and scope

- `main.py`: self-contained English/Khmer clinical dictionaries; `/start`, `/resume`, `/help`, `/cancel`, `/prevention`, `/emergency`; inline fever/warning/risk/hydration assessment; immediate callback acknowledgement; stale-state recovery; startup webhook reset; global error handler; optional health listener.
- `requirements.txt`: `python-telegram-bot==22.8`, using the v20+ asynchronous architecture.
- `.env.example`: variable names and placeholders only. The application reads process environment variables; it does not automatically load `.env`.
- `test_main.py`: offline tests with actual PTB handler dispatch and mocked Telegram transport.

The Python version keeps sessions in memory for 30 minutes of inactivity, with periodic expiry and a maximum of 10,000 active sessions. Telegram chat identifiers are used only for in-memory routing. It does not log incoming text, full updates, names, phone numbers, answers or locations. All sessions disappear on restart. Telegram itself retains chat history.

**Migration boundary:** the existing Node SQLite analytics, optional location reporting, durable outgoing queue and detailed hospital directory are not ported. The Python version offers bilingual triage and general emergency/referral guidance; it does not claim to record aggregate reports or pins. Keep the Node database and service available for rollback. Review this scope before replacing the current service. Clinical text and referral rules come from the existing project, which still requires native clinical Khmer review and clinical acceptance before community rollout.

## 1. Prepare and test locally

Use Python 3.11 or later. All **14 tests passed** here with Python 3.12.14 and PTB 22.8, and `pip check` reported no broken dependencies. Python 3.11.0 was not available in this local environment; verify the chosen Render interpreter in its build logs. Real Telegram replies and Render's Python deployment have not yet been tested; use the acceptance checklist after cutover.

From the Git repository root (`outputs/dengue-telegram-bot` in this workspace):

```powershell
cd python-bot
py -3.11 -m venv .venv
.\.venv\Scripts\python.exe -m pip install -r requirements.txt
.\.venv\Scripts\python.exe -m unittest -v test_main
```

The tests require no token and make no requests to Telegram. They exercise both languages, `/start`, free text, stale/expired/invalid callbacks, acknowledgement failures, state reset, private-chat restrictions, startup cleanup and wrong-token protection, error recovery, clinical decision paths, session expiry, and token redaction in full tracebacks.

For a real local smoke test, use a **separate test bot** from BotFather. Never start the local copy with the production token while Render is polling. In PowerShell:

```powershell
$secret = Read-Host 'Paste the TEST bot token' -AsSecureString
$env:TELEGRAM_TOKEN = [System.Net.NetworkCredential]::new('', $secret).Password
$env:EXPECTED_BOT_USERNAME = 'your_test_bot_username'
$env:ENABLE_HEALTH_SERVER = 'false'
.\.venv\Scripts\python.exe main.py
```

Stop with Ctrl+C. Then remove the temporary token environment variable:

```powershell
Remove-Item Env:TELEGRAM_TOKEN
$secret = $null
```

## 2. Publish the Python files to GitHub

First disable automatic deploys on the **old Node service** during cutover so publishing files does not unexpectedly restart another poller. Do not delete its disk.

From the repository root, not its parent workspace folder:

```bash
git status
git add .gitignore python-bot
git diff --cached --stat
git commit -m "feat: add Python Telegram polling bot and Render cutover playbook"
git push origin main
```

Review the staged files before committing. `.env`, virtual environments, caches, databases and bot tokens must remain excluded. If the repository folder is marked unsafe by Git on this Windows account, use a per-command `-c safe.directory="<absolute project path>"` for this trusted checkout; do not globally disable Git's ownership check.

Publishing these files alone does not suspend Render services, switch runtimes, or reset the live Telegram queue. Complete the service cutover and acceptance checks below before treating the migration as live.

## 3. Stop competing instances before clearing Telegram

1. In Render, suspend the old Node web service and any other worker/web service using the same token. Wait for its shutdown in runtime logs. Disable its automatic deploys so it does not resume unexpectedly.
2. Stop local terminals, scheduled jobs, Replit/Railway instances and other bots using that token. Exactly one service instance is required. `WEB_CONCURRENCY=1` alone does not stop another Render service or an old deployment from polling.
3. Do not create/start the Python worker until the old process has stopped. Expect a short maintenance window. Do not delete the old service or its database.

**A webhook deletion cannot stop another `getUpdates` process.** Repeated 409 conflicts require finding and stopping the competing instance. If an unidentified instance cannot be stopped, revoke the token in BotFather and configure the replacement token only on the chosen service; never rotate it while both deployments are intended to remain active.

## 4. Optional manual Telegram reset

Startup already performs `await application.bot.delete_webhook(drop_pending_updates=True)` in `post_init`, before polling begins. It verifies `getWebhookInfo().url` is empty. `run_polling(drop_pending_updates=False)` then preserves new messages arriving after this explicit cleanup.

**Resetting with `drop_pending_updates=true` permanently discards undelivered updates queued at Telegram, including unanswered messages and button taps. It does not delete chat history.** The requested startup reset runs on each process start; avoid repeated restarts and send a fresh `/start` only after startup completes. It is not called for individual `/start` commands or every network reconnect.

Exact API URL (replace the placeholder locally):

```text
https://api.telegram.org/bot<TOKEN>/deleteWebhook?drop_pending_updates=true
```

A browser can open that URL, but it puts the token in browser history. Prefer a terminal and never paste the completed URL into this chat, tickets, screenshots or logs.

Bash, macOS, Linux or Git Bash:

```bash
read -r -s -p "Telegram bot token: " TELEGRAM_TOKEN; echo
curl --fail-with-body --silent --show-error --request POST \
  "https://api.telegram.org/bot${TELEGRAM_TOKEN}/deleteWebhook" \
  --data-urlencode "drop_pending_updates=true"
curl --fail-with-body --silent --show-error \
  "https://api.telegram.org/bot${TELEGRAM_TOKEN}/getWebhookInfo"
unset TELEGRAM_TOKEN
```

Windows PowerShell (use `curl.exe`, not the PowerShell `curl` alias):

```powershell
$secret = Read-Host 'Telegram bot token' -AsSecureString
$env:TELEGRAM_TOKEN = [System.Net.NetworkCredential]::new('', $secret).Password
curl.exe --fail-with-body --silent --show-error --request POST "https://api.telegram.org/bot$env:TELEGRAM_TOKEN/deleteWebhook" --data-urlencode 'drop_pending_updates=true'
curl.exe --fail-with-body --silent --show-error "https://api.telegram.org/bot$env:TELEGRAM_TOKEN/getWebhookInfo"
Remove-Item Env:TELEGRAM_TOKEN
$secret = $null
```

Expected reset response: `{"ok":true,"result":true,...}`. Expected `getWebhookInfo` field: `"url":""`. Pending updates may increase if users send new messages before the worker starts. Do not use manual `getUpdates` while the worker is running; that diagnostic can itself compete with polling.

## 5. Configure BotFather

Open the official `@BotFather`, send `/setcommands`, choose `@kh_dengue_bot`, then paste:

```text
start - Start / ជ្រើសភាសា និងចាប់ផ្តើម
```

The command name has no leading slash in the submitted list. This configures the menu; it does not implement a handler or fix transport. The application also registers a localized `start` menu during startup, so its description can replace the BotFather description. `/help`, `/resume`, `/cancel`, `/prevention` and `/emergency` are implemented even though the requested minimal menu lists only `start`.

## 6. Create the native Python Render service

Recommended: **New → Background Worker**, connected to `Jrmyster/cambodia-dengue-telegram-bot`. A worker runs continuously without an inbound HTTP port. Choose an always-on instance with **one instance**; do not use multiple process workers, Gunicorn or a development reloader.

| Setting | Exact value |
|---|---|
| Runtime / Language | Python, not Docker or Node |
| Branch | `main` |
| Root Directory | `python-bot` |
| Build Command | `pip install -r requirements.txt` |
| Start Command | `python main.py` |
| Instance count | `1` |
| `TELEGRAM_TOKEN` | Actual BotFather token, entered as a Render secret |
| `PYTHON_VERSION` | `3.11.0` as requested |
| `EXPECTED_BOT_USERNAME` | `kh_dengue_bot` |
| `PYTHONUNBUFFERED` | `1` |
| `ENABLE_HEALTH_SERVER` | `false` for Background Worker |

Python 3.11.0 is an old initial patch release. For production, prefer a current security-patched 3.11 release supported by Render and verify it with the same tests. The exact requested setting is shown above; dependency installation and runtime logs must confirm it works on the selected Render runtime.

The new variable is **`TELEGRAM_TOKEN`**, not the Node version's `TELEGRAM_BOT_TOKEN`. Copy the token through Render's secret editor. This Python app always polls; `BOT_MODE`, `PUBLIC_URL`, `WEBHOOK_SECRET`, `DATABASE_PATH`, and `SESSION_KEY_SECRET` from the Node service do not configure it.

Do not configure an HTTP health check for a Background Worker. It has no public URL. There is no database disk required for this memory-only Python version.

### Web Service alternative

Create a **new native Python Web Service** using the same branch/root/build/start settings and one always-on instance. Set `ENABLE_HEALTH_SERVER=true`. Render supplies `PORT`; the included health listener binds `0.0.0.0:$PORT`. Set Health Check Path to `/health`. Do not set a fixed port over Render's value.

The health listener is only liveness, not a Telegram webhook or proof that polling can receive updates. Telegram messages are outbound long-polling traffic and do not count as incoming HTTP visits to the health endpoint. A free web service can spin down after inactivity, so do not rely on it for continuous polling or urgent referral support. A Background Worker or paid always-on Web Service is appropriate.

**Run either the Worker or the Web Service, never both with the same token.** The old Node `/readyz` endpoint does not verify the new Worker.

## 7. Force a fresh build and inspect runtime logs

1. Confirm GitHub has the commit containing `python-bot/main.py` and `requirements.txt`.
2. In the new service, open **Deploys → Manual Deploy → Clear build cache & deploy**. Clearing cache rebuilds dependencies; it does not clear a persistent disk or terminate a different service.
3. In build logs, verify the Python interpreter version and installation of `python-telegram-bot==22.8`.
4. Open the service's **Logs** page/log explorer and select the current deployment/time window. Inspect runtime output, not only the successful pip install log. Search for `starting_polling`, `webhook_cleared`, `startup_ready`, `Application started`, `polling_conflict`, `startup_failed`, and `update_or_network_error`.
5. Expected startup order includes:

```text
INFO dengue_bot starting_polling; only one deployment may use this token
INFO dengue_bot webhook_cleared drop_pending_updates=true
INFO dengue_bot startup_ready mode=polling bot_username=kh_dengue_bot storage=memory
INFO telegram.ext.Application Application started
```

Timestamps/prefixes vary. `startup_ready` means bootstrap completed, not that a user message was successfully received. PTB handles network retry/backoff; the global error handler logs polling conflicts without starting another polling loop. Repeated conflicts require operator action on the other instance.

## 8. Post-deployment acceptance checklist

- [ ] Exactly one process/service uses the token. The old Node service is suspended.
- [ ] The runtime logs show Python/PTB startup, not JSON Node `started` events.
- [ ] `bot_username=kh_dengue_bot` matches the intended bot.
- [ ] `getWebhookInfo` has an empty URL; no recurring conflicts or authentication failures.
- [ ] Send a **new** `/start`. Language buttons appear, and logs show `start_processed`.
- [ ] Tap English: spinner stops, English intro appears, `language_selected language=en` appears.
- [ ] Send `/start` again and tap ភាសាខ្មែរ: Khmer intro appears, `language_selected language=km` appears.
- [ ] Begin a synthetic assessment; an old question button must not record an answer for the new question.
- [ ] Send `Hi`, `Hello`, and an unknown command. Each returns the language menu or current button guidance.
- [ ] `/start` midway through a synthetic assessment resets it. `/cancel` clears its in-memory state.
- [ ] Synthetic positive warning signs immediately show red referral advice; no warning paths skip the warning screen.
- [ ] After a deliberate restart, send a new `/start`; old clinical buttons recover to language selection safely.
- [ ] For Web Service only, `/health` returns 200; still complete the Telegram tests above.

If Telegram is still silent: verify the exact bot username, latest deployed commit, native Python runtime and start command; check conflicts; verify the token is in `TELEGRAM_TOKEN`; then examine redacted stack traces. Delivered check marks in Telegram do not prove this application consumed the update. Telegram privacy mode is a group-message setting and is not a fix for a private-chat `/start` problem.

## Rollback

Stop/suspend the Python service first. Only then resume the preserved Node service and its original environment/database. Never resume it while the Python poller remains active. Python sessions and any messages deliberately dropped during cleanup cannot be recovered by rollback.

## References

- [PTB Application lifecycle and run_polling](https://docs.python-telegram-bot.org/en/stable/telegram.ext.application.html#telegram.ext.Application.run_polling)
- [PTB post_init startup hook](https://docs.python-telegram-bot.org/en/stable/telegram.ext.applicationbuilder.html#telegram.ext.ApplicationBuilder.post_init)
- [Telegram deleteWebhook](https://core.telegram.org/bots/api#deletewebhook)
- [Render Background Workers](https://render.com/docs/background-workers)
- [Render Python version configuration](https://render.com/docs/python-version)
- [Render deployment and cache clearing](https://render.com/docs/deploys)
- [Render runtime logs](https://render.com/docs/logging)
- [Render Web Service port binding](https://render.com/docs/web-services#port-binding)
- [Render free-service limits](https://render.com/docs/free)
