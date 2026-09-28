import json
import logging
import unittest
from threading import Thread
from urllib.error import HTTPError
from urllib.request import urlopen
from unittest.mock import patch

from telegram import Update
from telegram.error import Conflict
from telegram.ext import Application, ExtBot
from telegram.request import BaseRequest

import main

TOKEN = "12345:" + "A" * 35


class FakeTelegram(BaseRequest):
    def __init__(self):
        self.calls = []
        self.fail_ack = False

    @property
    def read_timeout(self):
        return 5

    async def initialize(self):
        pass

    async def shutdown(self):
        pass

    async def do_request(self, url, method, request_data=None, **kwargs):
        name = url.rsplit("/", 1)[-1]
        parameters = request_data.parameters if request_data else {}
        self.calls.append((name, parameters))
        if name == "getMe":
            result = {"id": 12345, "is_bot": True, "first_name": "Test", "username": "kh_dengue_bot"}
        elif name == "sendMessage":
            result = {"message_id": len(self.calls), "date": 1, "chat": {"id": int(parameters["chat_id"]), "type": "private"}, "text": parameters["text"]}
        elif name == "answerCallbackQuery" and self.fail_ack:
            return 400, json.dumps({"ok": False, "error_code": 400, "description": "query is too old"}).encode()
        elif name == "getWebhookInfo":
            result = {"url": "", "has_custom_certificate": False, "pending_update_count": 0}
        else:
            result = True
        return 200, json.dumps({"ok": True, "result": result}).encode()


class HandlerTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.request = FakeTelegram()
        bot = ExtBot(TOKEN, request=self.request, get_updates_request=FakeTelegram())
        # Build the production handler registry, then place it on a mocked transport.
        source = main.build_application(TOKEN)
        self.app = Application.builder().bot(bot).concurrent_updates(False).build()
        self.app.bot_data["sessions"] = main.Sessions()
        for group, handlers in source.handlers.items():
            for handler in handlers:
                self.app.add_handler(handler, group)
        self.app.add_error_handler(main.error_handler)
        await self.app.initialize()
        await source.bot.shutdown()
        self.number = 0

    async def asyncTearDown(self):
        await main.post_shutdown(self.app)
        await self.app.shutdown()

    def update(self, text=None, data=None, chat=55, chat_type="private", edited=False):
        self.number += 1
        user = {"id": chat if chat_type == "private" else 55, "is_bot": False, "first_name": "PRIVATE_NAME"}
        message = {"message_id": self.number, "date": 1, "chat": {"id": chat, "type": chat_type}, "from": user}
        payload = {"update_id": self.number}
        if data is not None:
            payload["callback_query"] = {"id": str(self.number), "chat_instance": "test", "from": user, "message": message, "data": data}
        else:
            message["text"] = text
            if text.startswith("/"):
                message["entities"] = [{"type": "bot_command", "offset": 0, "length": len(text.split()[0])}]
            payload["edited_message" if edited else "message"] = message
        return Update.de_json(payload, self.app.bot)

    async def send(self, **kwargs):
        await self.app.process_update(self.update(**kwargs))

    def last_message(self):
        return [p for name, p in self.request.calls if name == "sendMessage"][-1]

    def state(self):
        return self.app.bot_data["sessions"].get(55)

    async def tap(self, action, value=""):
        s = self.state()
        await self.send(data=main.button(s, "test", action, value).callback_data)

    async def test_start_language_and_immediate_ack_in_both_languages(self):
        for lang in ("en", "km"):
            await self.send(text="/start")
            self.assertIn("Choose your language", self.last_message()["text"])
            menu = self.last_message()["reply_markup"]
            self.assertIn("lang:km", str(menu))
            self.assertIn("lang:en", str(menu))
            before = len(self.request.calls)
            await self.send(data=f"lang:{lang}")
            self.assertEqual(self.request.calls[before][0], "answerCallbackQuery")
            self.assertEqual(self.state().language, lang)
            self.assertEqual(self.last_message()["text"], main.LOCALES[lang]["intro"])

    async def test_greeting_start_reset_and_unknown_command(self):
        await self.send(text="Hi")
        await self.send(data="lang:en")
        await self.tap("begin")
        old_nonce = self.state().nonce
        await self.send(text="Hello")
        self.assertEqual(self.state().stage, "fever")
        await self.send(text="/start@kh_dengue_bot payload")
        self.assertIsNone(self.state().language)
        self.assertNotEqual(self.state().nonce, old_nonce)
        await self.send(text="/unknown")
        self.assertIn("Choose your language", self.last_message()["text"])

    async def test_stale_invalid_and_expired_callbacks_never_answer_new_questions(self):
        await self.send(data="lang:en")
        old = main.button(self.state(), "begin", "begin").callback_data
        await self.send(data=old)
        await self.send(data=old)
        self.assertEqual(self.state().stage, "fever")
        self.assertIn(main.LOCALES["en"]["stale"], self.last_message()["text"])
        for data in ("invalid", "x" * 65, "v1:bad:999:warning:yes"):
            await self.send(data=data)
            self.assertEqual(self.state().stage, "fever")
        self.state().expires = 0
        await self.send(data=old)
        self.assertIsNone(self.state().language)
        await self.send(data="123456abcdef:0:language:km")
        self.assertEqual(self.state().language, "km")

    async def test_expired_ack_does_not_stop_language_selection(self):
        self.request.fail_ack = True
        await self.send(data="lang:km")
        self.assertEqual(self.state().language, "km")

    async def test_private_only_and_edited_messages_ignored(self):
        await self.send(text="/start", chat=-55, chat_type="group")
        await self.send(text="/start", edited=True)
        self.assertEqual([m for m in self.request.calls if m[0] == "sendMessage"], [])

    async def test_red_immediate_and_cancel_clears_state(self):
        await self.send(data="lang:km")
        await self.tap("begin")
        await self.tap("fever", "none")
        await self.tap("warning", "yes")
        self.assertEqual(self.state().result, "red")
        self.assertEqual(self.last_message()["text"], main.LOCALES["km"]["red"])
        await self.send(text="/cancel")
        self.assertIsNone(self.state())

    async def test_startup_clears_webhook_once_and_registers_commands(self):
        await main.post_init(self.app)
        calls = [p for name, p in self.request.calls if name == "deleteWebhook"]
        self.assertEqual(calls, [{"drop_pending_updates": True}])
        self.assertEqual(len([n for n, _ in self.request.calls if n == "setMyCommands"]), 3)
        await self.send(text="/start")
        self.assertEqual(len([n for n, _ in self.request.calls if n == "deleteWebhook"]), 1)

    async def test_wrong_bot_prevents_destructive_cleanup(self):
        with patch.dict("os.environ", {"EXPECTED_BOT_USERNAME": "different_bot"}):
            with self.assertRaises(ValueError):
                await main.post_init(self.app)
        self.assertNotIn("deleteWebhook", [n for n, _ in self.request.calls])

    async def test_global_error_handler_recovers_and_polling_conflict_does_not_crash(self):
        update = self.update(text="/start")
        with self.assertLogs("dengue_bot", level="ERROR") as logs:
            await self.app.process_error(update=update, error=ValueError("test"))
            await self.app.process_error(update=None, error=Conflict("another poller"))
        self.assertIn("/start", self.last_message()["text"])
        self.assertIn("polling_conflict", " ".join(logs.output))
        await self.send(text="/start")
        self.assertIn("Choose your language", self.last_message()["text"])


class LogicTests(unittest.TestCase):
    def test_optional_health_listener_is_liveness_only(self):
        server = main.ThreadingHTTPServer(("127.0.0.1", 0), main.HealthHandler)
        thread = Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            origin = f"http://127.0.0.1:{server.server_address[1]}"
            for path in ("/", "/health", "/healthz"):
                with urlopen(origin + path, timeout=2) as response:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(json.load(response)["check"], "process_liveness_only")
            with self.assertRaises(HTTPError) as raised:
                urlopen(origin + "/telegram/webhook", timeout=2)
            self.assertEqual(raised.exception.code, 404)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(timeout=2)

    def test_complete_clinical_paths_and_each_warning_in_both_languages(self):
        for lang in ("en", "km"):
            for fever in main.LOCALES[lang]["feverChoices"]:
                for duration in main.LOCALES[lang]["durationChoices"]:
                    for vulnerable in ("yes", "no", "unsure"):
                        for hydration in ("yes", "no", "unsure"):
                            s = main.Session(language=lang)
                            self.assertTrue(main.advance(s, "begin", ""))
                            main.advance(s, "fever", fever)
                            if s.stage == "duration":
                                main.advance(s, "duration", duration)
                            for _ in range(5):
                                main.advance(s, "warning", "no")
                            main.advance(s, "vulnerable", vulnerable)
                            main.advance(s, "hydration", hydration)
                            urgent = (hydration != "yes" or vulnerable != "no" or fever == "unsure"
                                      or fever != "none" and duration in ("long", "unsure"))
                            self.assertEqual(s.result, "urgentYellow" if urgent else "green" if fever == "none" else "yellow")
            for index in range(5):
                for answer, result in (("yes", "red"), ("unsure", "urgentYellow")):
                    s = main.Session(language=lang, stage="warning", warning=index)
                    main.advance(s, "warning", answer)
                    self.assertEqual(s.result, result)

    def test_locale_parity_message_and_callback_limits(self):
        self.assertEqual(main.LOCALES["en"].keys(), main.LOCALES["km"].keys())
        for lang in ("en", "km"):
            for stage in ("intro", "fever", "duration", "warning", "vulnerable", "hydration", "result"):
                for result in ("red", "yellow", "urgentYellow", "green"):
                    text, menu = main.screen(main.Session(language=lang, stage=stage, result=result))
                    self.assertLessEqual(len(text), 4096)
                    for row in menu.inline_keyboard:
                        for button in row:
                            self.assertLessEqual(len(button.callback_data.encode()), 64)

    def test_sessions_expire_and_are_bounded(self):
        store = main.Sessions()
        store.put(1, main.Session())
        store.values[1].expires = 0
        self.assertIsNone(store.get(1))
        with patch.object(main, "MAX_SESSIONS", 2):
            for chat in range(3):
                store.put(chat, main.Session())
        self.assertEqual(len(store.values), 2)

    def test_logging_redacts_tokens_inside_full_tracebacks(self):
        formatter = main.RedactingFormatter(TOKEN)
        try:
            raise RuntimeError(f"failure at https://api.telegram.org/bot{TOKEN}/getUpdates")
        except RuntimeError as error:
            record = logging.LogRecord("test", logging.ERROR, __file__, 1, "failure", (), (type(error), error, error.__traceback__))
            rendered = formatter.format(record)
        self.assertNotIn(TOKEN, rendered)
        self.assertIn("Traceback", rendered)
        self.assertIn("RuntimeError", rendered)


if __name__ == "__main__":
    unittest.main()
