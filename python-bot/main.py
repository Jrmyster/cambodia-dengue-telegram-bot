"""Single-process, bilingual dengue referral bot. Python 3.11+, PTB 22.8.

Sessions expire in memory; no patient data, location analytics or SQLite writes.
Run exactly one deployment per token. See DEPLOYMENT.md before production cutover.
"""
from __future__ import annotations

import asyncio
import copy
import json
import logging
import os
import re
import secrets
import signal
import sys
import time
from contextlib import suppress
from dataclasses import dataclass, field
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from threading import Thread
from typing import Any

from telegram import BotCommand, InlineKeyboardButton, InlineKeyboardMarkup, Update
from telegram.error import BadRequest, Conflict, Forbidden, NetworkError, RetryAfter, TelegramError
from telegram.ext import Application, CallbackQueryHandler, CommandHandler, ContextTypes, MessageHandler, filters

LOG = logging.getLogger("dengue_bot")
TTL_SECONDS = 30 * 60
MAX_SESSIONS = 10000
HEALTH = {"status": "starting", "bot_username": None}

# Translation strings copied from the existing English/Khmer clinical dictionaries.
# Full UTF-8 dictionaries are embedded below: no extra files or Node runtime required.
LOCALES = {
  "en": {
    "recovery": "An error occurred. Please tap /start to restart. For urgent help, call 119 or go to hospital now.",
    "yes": "Yes",
    "no": "No",
    "unsure": "Not sure",
    "begin": "Begin assessment",
    "restart": "New assessment",
    "resume": "Continue assessment",
    "emergency": "🚑 Emergency contacts",
    "prevention": "🦟 Prevention",
    "cancel": "Cancel / clear answers",
    "intro": "Dengue symptom check\nThis tool helps you decide where to seek care; it cannot diagnose or rule out dengue. Do not wait for the bot if someone is very ill.\n\nTap buttons; do not send names, photos or medical records. Answers expire after 30 minutes of inactivity (operator configurable). Telegram retains chat messages. /cancel clears the bot’s active answers.\n\nDanger signs can appear when fever falls. Tap Emergency contacts at any time.",
    "fever": "Has the person had fever now or at any time in the last 7 days?\nChoose the closest answer. Mild fever can still be dengue.",
    "feverChoices": {
      "high": "High / sudden fever",
      "mild": "Mild fever",
      "falling": "Fever has fallen / stopped",
      "none": "No recent fever",
      "unsure": "Not sure"
    },
    "duration": "How long since the fever FIRST started (even if it has now stopped)?",
    "durationChoices": {
      "short": "Less than 2 days",
      "typical": "2–7 days",
      "long": "More than 7 days",
      "unsure": "Not sure"
    },
    "warningIntro": "Check danger signs now — even without fever.",
    "warnings": [
      "Is there severe or continuous abdominal (belly) pain?",
      "Is there repeated vomiting or inability to keep liquids down?",
      "Is there bleeding from the gums or nose, blood in vomit or stool, or black, tar-like stool?",
      "Is the person extremely sleepy, hard to wake, confused, or unusually restless?",
      "Is the skin cold, pale or clammy, or is there difficulty breathing?"
    ],
    "vulnerable": "Does any apply?\n• Baby under 1 year (especially under 3 months with fever)\n• Pregnant or age 65+\n• Serious long-term illness, weakened immunity, or blood-thinning medicine\n• Unable to reach care quickly or no one available to monitor the person",
    "hydration": "Is the person drinking normally AND passing urine as usual?\nVery little/no urine for about 6 hours, no wet nappies, or poor drinking needs urgent medical review.",
    "red": "🔴 RED ALERT — Emergency care now\nA danger sign was reported. Stop the assessment and arrange transport to the NEAREST hospital able to provide emergency care (district/provincial referral hospital; a pediatric hospital for children if nearby). Do not make a longer journey just to reach a named hospital.\n\nCall 119 for an ambulance. If unavailable, arrange safe transport with another adult; do not delay while calling.\n\nDuring transport: only if fully awake, able to swallow and not vomiting repeatedly, offer small frequent sips of oral rehydration solution (ORS), mixed exactly as the packet directs using safe water. Do not force fluids. Give nothing by mouth if drowsy, unconscious, choking or struggling to breathe.\n\nDo not wait for a blood test. This is urgent referral advice, not a diagnosis of severe dengue.",
    "yellow": "🟡 YELLOW ALERT — Medical assessment today\nDengue or another illness is possible. Visit a local Health Center today, within 24 hours at the latest. A clinician may request NS1/other dengue testing and a complete blood count (CBC), depending on the day of illness and examination. A normal CBC or negative early test does not rule out dengue. Do not delay care to obtain a test.\n\nArrange follow-up as advised and monitor closely, especially as fever drops.",
    "urgentYellow": "🟡 YELLOW ALERT — Urgent in-person assessment now\nAn answer was uncertain, drinking/urine is reduced, fever is prolonged, or a higher-risk situation was reported. Seek medical assessment now; a baby under 3 months with fever needs immediate medical attention. If a danger sign may be present, go to emergency care now. Do not wait 24 hours.",
    "green": "🟢 GREEN ALERT — Home care with close monitoring\nNo danger signs were reported and the answers suggest lower urgency. This does NOT exclude dengue or another serious illness. If fever develops, persists, symptoms worsen, or you are worried, seek medical advice today.",
    "care": "Home care while arranging advice:\n• Rest. Offer frequent fluids/ORS and continue breastfeeding. Prepare ORS exactly as the packet says with safe water.\n• For fever discomfort, use paracetamol only, at the correct age/weight dose on the label or as a clinician advises. Avoid duplicate medicines containing paracetamol.\n• Do NOT give ibuprofen, aspirin or other NSAIDs: they may increase bleeding risk.\n• Watch drinking, urine, alertness and breathing. Danger signs require hospital care immediately, even when fever improves. /emergency",
    "preventionText": "🦟 Prevent dengue\n• Each week, empty and scrub water jars, buckets and vases; cover stored water tightly.\n• Remove or drain old tires, cans and other standing water; clear blocked gutters.\n• Use Abate (temephos) ONLY when approved/provided by local health authorities and exactly as directed for that container. Never guess a dose or add unapproved pesticide to drinking water.\n• Use mosquito nets during daytime naps as well as at night, window screens, covering clothes and age-appropriate repellent. Dengue mosquitoes also bite in daytime.\n• Protect a person with fever from mosquito bites.",
    "emergencyIntro": "🚑 Emergency help\nCall 119 (Cambodia ambulance code). Availability varies; if no answer, arrange safe transport to the nearest emergency facility. Do not wait for a callback.\n\nChoose an area. Named pediatric hospitals treat children; adults should use a general referral hospital. This directory does not locate you or guarantee capacity.",
    "otherArea": "Go to the nearest district or provincial referral hospital for danger signs. For a stable patient, ask your village health volunteer or local Health Center for the local referral route. Call 119 for emergency transport; coverage is not guaranteed.",
    "cleared": "Your active answers and pending messages have been cleared from this bot. Existing Telegram chat messages are not deleted. /start begins a new assessment.",
    "stale": "This button is from an older or expired question. Use the latest buttons below. No answer was recorded.",
    "fallback": "Hello! I can help you use the dengue symptom checker. Please tap the buttons below. Free text is not assessed. /emergency for urgent help; /start to choose a language and restart.",
    "help": "Commands:\n/start — select language and begin\n/resume — show the current question\n/prevention — mosquito control\n/emergency — contacts and referral areas\n/cancel — clear active answers\n/help — this message\n\nThis is not a monitored emergency service. Call 119 or go to hospital for danger signs."
  },
  "km": {
    "recovery": "មានបញ្ហាកើតឡើង។ សូមចុច /start ដើម្បីចាប់ផ្តើមឡើងវិញ។ សម្រាប់ជំនួយបន្ទាន់ សូមហៅ 119 ឬទៅមន្ទីរពេទ្យឥឡូវនេះ។",
    "yes": "មាន / បាទ ឬ ចាស",
    "no": "គ្មាន / ទេ",
    "unsure": "មិនប្រាកដ",
    "begin": "ចាប់ផ្តើមវាយតម្លៃ",
    "restart": "វាយតម្លៃថ្មី",
    "resume": "បន្តការវាយតម្លៃ",
    "emergency": "🚑 ទំនាក់ទំនងសង្គ្រោះបន្ទាន់",
    "prevention": "🦟 ការបង្ការ",
    "cancel": "បោះបង់ / លុបចម្លើយ",
    "intro": "ពិនិត្យរោគសញ្ញាជំងឺគ្រុនឈាម\nកម្មវិធីនេះជួយណែនាំកន្លែងស្វែងរកការថែទាំ ប៉ុន្តែមិនអាចធ្វើរោគវិនិច្ឆ័យ ឬបញ្ជាក់ថាគ្មានជំងឺគ្រុនឈាមទេ។ បើអ្នកជំងឺឈឺធ្ងន់ កុំរង់ចាំបុត។\n\nសូមចុចប៊ូតុង។ កុំផ្ញើឈ្មោះ រូបថត ឬឯកសារពេទ្យ។ ចម្លើយនឹងផុតកំណត់ក្រោយឈប់ប្រើ ៣០ នាទី (អ្នកគ្រប់គ្រងអាចកែបាន)។ Telegram រក្សាទុកសារជជែក។ /cancel លុបចម្លើយដែលបុតកំពុងប្រើ។\n\nសញ្ញាគ្រោះថ្នាក់អាចកើតឡើងពេលកម្ដៅចុះ។ អាចចុចទំនាក់ទំនងសង្គ្រោះបន្ទាន់បានគ្រប់ពេល។",
    "fever": "តើអ្នកជំងឺមានគ្រុនក្ដៅឥឡូវនេះ ឬធ្លាប់មានក្នុងរយៈពេល ៧ ថ្ងៃចុងក្រោយទេ?\nជ្រើសចម្លើយដែលសមស្របបំផុត។ គ្រុនក្ដៅតិចតួចក៏អាចជាជំងឺគ្រុនឈាមដែរ។",
    "feverChoices": {
      "high": "គ្រុនក្ដៅខ្លាំង / ភ្លាមៗ",
      "mild": "គ្រុនក្ដៅតិចតួច",
      "falling": "កម្ដៅចុះ / លែងក្ដៅ",
      "none": "មិនមានគ្រុនក្ដៅថ្មីៗនេះ",
      "unsure": "មិនប្រាកដ"
    },
    "duration": "តើមានរយៈពេលប៉ុន្មានថ្ងៃចាប់តាំងពីចាប់ផ្តើមគ្រុនក្ដៅដំបូង (ទោះបីឥឡូវលែងក្ដៅក៏ដោយ)?",
    "durationChoices": {
      "short": "តិចជាង ២ ថ្ងៃ",
      "typical": "២–៧ ថ្ងៃ",
      "long": "លើសពី ៧ ថ្ងៃ",
      "unsure": "មិនប្រាកដ"
    },
    "warningIntro": "សូមពិនិត្យសញ្ញាគ្រោះថ្នាក់ឥឡូវនេះ ទោះបីគ្មានគ្រុនក្ដៅក៏ដោយ។",
    "warnings": [
      "តើមានឈឺពោះខ្លាំង ឬឈឺពោះជាប់រហូតទេ?",
      "តើមានក្អួតញឹកញាប់ ឬផឹកអ្វីក៏ក្អួតចេញវិញទេ?",
      "តើមានហូរឈាមតាមអញ្ចាញធ្មេញ ឬច្រមុះ ក្អួតឈាម លាមកមានឈាម ឬលាមកខ្មៅដូចជ័រកៅស៊ូទេ?",
      "តើអ្នកជំងឺងងុយខ្លាំង ពិបាកដាស់ វង្វេងវង្វាន់ ឬអន្ទះអន្ទែងខុសធម្មតាទេ?",
      "តើស្បែកត្រជាក់ ស្លេក ឬសើមញើសស្អិត ឬមានពិបាកដកដង្ហើមទេ?"
    ],
    "vulnerable": "តើមានករណីណាមួយខាងក្រោមទេ?\n• ទារកអាយុក្រោម ១ ឆ្នាំ (ជាពិសេសក្រោម ៣ ខែដែលមានគ្រុនក្ដៅ)\n• មានផ្ទៃពោះ ឬអាយុចាប់ពី ៦៥ ឆ្នាំ\n• មានជំងឺរ៉ាំរ៉ៃធ្ងន់ ប្រព័ន្ធភាពស៊ាំខ្សោយ ឬប្រើថ្នាំប្រឆាំងការកកឈាម\n• ពិបាកទៅដល់មន្ទីរពេទ្យឆាប់រហ័ស ឬគ្មានអ្នកមើលថែ",
    "hydration": "តើអ្នកជំងឺផឹកបានធម្មតា ហើយនោមបានដូចធម្មតាដែរទេ?\nនោមតិចខ្លាំង ឬមិននោមប្រហែល ៦ ម៉ោង កន្ទបទារកមិនសើម ឬផឹកមិនសូវបាន ត្រូវឱ្យគ្រូពេទ្យពិនិត្យជាបន្ទាន់។",
    "red": "🔴 សញ្ញាក្រហម — ត្រូវសង្គ្រោះបន្ទាន់ឥឡូវនេះ\nមានការរាយការណ៍សញ្ញាគ្រោះថ្នាក់។ ឈប់វាយតម្លៃ ហើយរៀបចំដឹកអ្នកជំងឺទៅមន្ទីរពេទ្យដែលអាចសង្គ្រោះបន្ទាន់នៅជិតបំផុត (មន្ទីរពេទ្យបង្អែកស្រុក ឬខេត្ត; មន្ទីរពេទ្យកុមារសម្រាប់កុមារ ប្រសិនបើនៅជិត)។ កុំធ្វើដំណើរឆ្ងាយជាង ដើម្បីទៅមន្ទីរពេទ្យដែលមានឈ្មោះក្នុងបញ្ជីប៉ុណ្ណោះ។\n\nហៅ 119 រករថយន្តសង្គ្រោះ។ បើមិនអាចទាក់ទងបាន សូមរៀបចំមធ្យោបាយដឹកជញ្ជូនមានសុវត្ថិភាព ជាមួយមនុស្សពេញវ័យម្នាក់ទៀត។ កុំពន្យារពេលដោយរង់ចាំទូរស័ព្ទ។\n\nពេលធ្វើដំណើរ៖ បើអ្នកជំងឺដឹងខ្លួនល្អ លេបបាន និងមិនក្អួតញឹកញាប់ អាចឱ្យផឹកទឹកអំបិលជាតិស្ករ (ORS) ម្តងបន្តិចៗ ញឹកញាប់។ លាយតាមការណែនាំលើកញ្ចប់ ដោយប្រើទឹកស្អាត។ កុំបង្ខំឱ្យផឹក។ កុំឱ្យអ្វីតាមមាត់ បើងងុយខ្លាំង សន្លប់ ឈ្លក់ ឬពិបាកដកដង្ហើម។\n\nកុំរង់ចាំតេស្តឈាម។ នេះជាការណែនាំឱ្យទៅពេទ្យបន្ទាន់ មិនមែនជារោគវិនិច្ឆ័យជំងឺគ្រុនឈាមធ្ងន់ទេ។",
    "yellow": "🟡 សញ្ញាលឿង — ទៅពិនិត្យថ្ងៃនេះ\nអាចជាជំងឺគ្រុនឈាម ឬជំងឺផ្សេង។ សូមទៅមណ្ឌលសុខភាពថ្ងៃនេះ យ៉ាងយូរក្នុងរយៈពេល ២៤ ម៉ោង។ គ្រូពេទ្យអាចស្នើឱ្យធ្វើតេស្ត NS1 ឬតេស្តគ្រុនឈាមផ្សេង និងរាប់គ្រាប់ឈាម (CBC) អាស្រ័យលើថ្ងៃនៃជំងឺ និងការពិនិត្យ។ CBC ធម្មតា ឬតេស្តអវិជ្ជមាននៅដំណាក់កាលដំបូង មិនអាចបញ្ជាក់ថាគ្មានគ្រុនឈាមទេ។ កុំពន្យារពេលទៅពេទ្យដើម្បីរកតេស្ត។\n\nតាមដានជាមួយគ្រូពេទ្យតាមការណែនាំ និងមើលរោគសញ្ញាឱ្យដិតដល់ ជាពិសេសពេលកម្ដៅចុះ។",
    "urgentYellow": "🟡 សញ្ញាលឿង — ត្រូវទៅពេទ្យពិនិត្យបន្ទាន់ឥឡូវនេះ\nមានចម្លើយមិនប្រាកដ ផឹកឬនោមតិច គ្រុនក្ដៅយូរ ឬមានកត្តាហានិភ័យខ្ពស់។ សូមទៅពេទ្យពិនិត្យឥឡូវនេះ។ ទារកអាយុក្រោម ៣ ខែដែលមានគ្រុនក្ដៅ ត្រូវទទួលការពិនិត្យភ្លាមៗ។ បើសង្ស័យថាមានសញ្ញាគ្រោះថ្នាក់ ត្រូវទៅសង្គ្រោះបន្ទាន់ឥឡូវនេះ។ កុំរង់ចាំ ២៤ ម៉ោង។",
    "green": "🟢 សញ្ញាបៃតង — ថែទាំនៅផ្ទះ និងតាមដានដិតដល់\nមិនមានការរាយការណ៍សញ្ញាគ្រោះថ្នាក់ ហើយតាមចម្លើយ ភាពបន្ទាន់ទាបជាង។ នេះមិនអាចបញ្ជាក់ថាគ្មានជំងឺគ្រុនឈាម ឬជំងឺធ្ងន់ផ្សេងទេ។ បើចាប់ផ្តើមគ្រុនក្ដៅ គ្រុនក្ដៅបន្ត រោគសញ្ញាកាន់តែធ្ងន់ ឬអ្នកបារម្ភ សូមពិគ្រោះគ្រូពេទ្យថ្ងៃនេះ។",
    "care": "ការថែទាំពេលរៀបចំស្វែងរកការណែនាំ៖\n• សម្រាក។ ឱ្យផឹកទឹក ឬ ORS ញឹកញាប់ និងបន្តបំបៅដោះ។ លាយ ORS តាមកញ្ចប់ដោយប្រើទឹកស្អាត។\n• បើមិនស្រួលដោយគ្រុនក្ដៅ ប្រើតែប៉ារ៉ាសេតាម៉ុល តាមកម្រិតសមស្របនឹងអាយុ/ទម្ងន់លើស្លាក ឬតាមគ្រូពេទ្យ។ កុំប្រើថ្នាំច្រើនមុខដែលមានប៉ារ៉ាសេតាម៉ុលដូចគ្នា។\n• កុំប្រើអ៊ីប៊ុយប្រូហ្វែន អាស្ពីរីន ឬថ្នាំក្រុម NSAIDs ផ្សេង ព្រោះអាចបង្កើនហានិភ័យហូរឈាម។\n• តាមដានការផឹកទឹក ទឹកនោម ស្មារតី និងការដកដង្ហើម។ បើមានសញ្ញាគ្រោះថ្នាក់ ត្រូវទៅមន្ទីរពេទ្យភ្លាមៗ ទោះបីកម្ដៅចុះក៏ដោយ។ /emergency",
    "preventionText": "🦟 បង្ការជំងឺគ្រុនឈាម\n• រៀងរាល់សប្តាហ៍ ចាក់ទឹកចេញ និងដុសលាងពាង ធុង និងថូផ្កា។ គ្របធុងស្តុកទឹកឱ្យជិត។\n• ប្រមូល ឬបង្ហូរទឹកពីសំបកកង់ចាស់ កំប៉ុង និងវត្ថុដក់ទឹកផ្សេងៗ។ សម្អាតលូទឹកស្ទះ។\n• ប្រើអាបាត (Abate/temephos) តែពេលអាជ្ញាធរសុខាភិបាលមូលដ្ឋានអនុញ្ញាត ឬផ្តល់ឱ្យ និងតាមការណែនាំសម្រាប់ធុងនោះប៉ុណ្ណោះ។ កុំប៉ាន់ស្មានកម្រិតប្រើ ឬដាក់ថ្នាំសម្លាប់សត្វល្អិតដែលមិនបានអនុញ្ញាតក្នុងទឹកផឹក។\n• គេងក្នុងមុងទាំងពេលថ្ងៃ និងយប់ ប្រើសំណាញ់បង្អួច សម្លៀកបំពាក់ជិត និងថ្នាំការពារមូសសមស្របនឹងអាយុ។ មូសចម្លងគ្រុនឈាមខាំពេលថ្ងៃដែរ។\n• ការពារអ្នកមានគ្រុនក្ដៅពីមូសខាំ។",
    "emergencyIntro": "🚑 ជំនួយសង្គ្រោះបន្ទាន់\nហៅ 119 (លេខរថយន្តសង្គ្រោះនៅកម្ពុជា)។ សេវាអាចខុសគ្នាតាមតំបន់។ បើគ្មានអ្នកទទួល សូមរៀបចំដឹកជញ្ជូនមានសុវត្ថិភាពទៅកន្លែងសង្គ្រោះបន្ទាន់ជិតបំផុត។ កុំរង់ចាំគេហៅត្រឡប់។\n\nសូមជ្រើសតំបន់។ មន្ទីរពេទ្យកុមារព្យាបាលកុមារ។ មនុស្សពេញវ័យគួរទៅមន្ទីរពេទ្យបង្អែកទូទៅ។ បញ្ជីនេះមិនកំណត់ទីតាំងអ្នក ឬធានាថាមន្ទីរពេទ្យអាចទទួលបានទេ។",
    "otherArea": "បើមានសញ្ញាគ្រោះថ្នាក់ សូមទៅមន្ទីរពេទ្យបង្អែកស្រុក ឬខេត្តដែលនៅជិតបំផុត។ បើអ្នកជំងឺមានស្ថានភាពនឹងនរ សូមសួរអ្នកស្ម័គ្រចិត្តសុខភាពភូមិ ឬមណ្ឌលសុខភាពអំពីផ្លូវបញ្ជូនអ្នកជំងឺ។ ហៅ 119 សម្រាប់ដឹកជញ្ជូនបន្ទាន់ ប៉ុន្តែមិនអាចធានាសេវាគ្រប់តំបន់ទេ។",
    "cleared": "បានលុបចម្លើយកំពុងប្រើ និងសាររង់ចាំផ្ញើពីបុតនេះ។ សារចាស់ក្នុង Telegram មិនត្រូវបានលុបទេ។ /start ដើម្បីចាប់ផ្តើមថ្មី។",
    "stale": "ប៊ូតុងនេះមកពីសំណួរចាស់ ឬផុតកំណត់។ សូមប្រើប៊ូតុងថ្មីខាងក្រោម។ មិនបានកត់ត្រាចម្លើយទេ។",
    "fallback": "សួស្តី! ខ្ញុំអាចជួយអ្នកប្រើកម្មវិធីពិនិត្យរោគសញ្ញាជំងឺគ្រុនឈាម។ សូមចុចប៊ូតុងខាងក្រោម។ បុតមិនវាយតម្លៃអត្ថបទដែលវាយបញ្ចូលទេ។ /emergency សម្រាប់ជំនួយបន្ទាន់ ឬ /start ដើម្បីជ្រើសភាសា និងចាប់ផ្តើមថ្មី។",
    "help": "ពាក្យបញ្ជា៖\n/start — ជ្រើសភាសា និងចាប់ផ្តើម\n/resume — បង្ហាញសំណួរបច្ចុប្បន្ន\n/prevention — ការពារមូស\n/emergency — លេខទំនាក់ទំនង និងតំបន់បញ្ជូន\n/cancel — លុបចម្លើយកំពុងប្រើ\n/help — ជំនួយនេះ\n\nនេះមិនមែនជាសេវាសង្គ្រោះបន្ទាន់ដែលមានអ្នកតាមដានទេ។ ហៅ 119 ឬទៅមន្ទីរពេទ្យបើមានសញ្ញាគ្រោះថ្នាក់។"
  }
}
COMMON = {
  "chooseLanguage": "សូមជ្រើសរើសភាសា / Choose your language",
  "urgent": "🚑 បើមានសញ្ញាគ្រោះថ្នាក់ សូមទៅមន្ទីរពេទ្យឥឡូវនេះ។ ហៅ 119។\nIf there are danger signs, go to hospital now. Call 119.",
  "privateOnly": "សូមប្រើកម្មវិធីនេះក្នុងការជជែកឯកជនជាមួយបុត។\nPlease use this bot in a private chat."
}


class RedactingFormatter(logging.Formatter):
    """Keep stack frames while removing credentials from messages and tracebacks."""
    def __init__(self, token: str):
        super().__init__("%(asctime)s %(levelname)s %(name)s %(message)s")
        self.token = token

    def format(self, record: logging.LogRecord) -> str:
        output = super().format(record)
        if self.token:
            output = output.replace(self.token, "[REDACTED_TOKEN]")
        return re.sub(r"\b\d{5,}:[A-Za-z0-9_-]{20,}\b", "[REDACTED_TOKEN]", output)


def configure_logging(token: str) -> None:
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(RedactingFormatter(token))
    logging.basicConfig(level=logging.INFO, handlers=[handler], force=True)
    # HTTP INFO logs otherwise print Bot API URLs containing the token.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    logging.getLogger("httpcore").setLevel(logging.WARNING)


@dataclass
class Session:
    nonce: str = field(default_factory=lambda: secrets.token_hex(6))
    revision: int = 0
    language: str | None = None
    stage: str = "intro"
    answers: dict[str, str] = field(default_factory=dict)
    warning: int = 0
    result: str | None = None
    expires: float = field(default_factory=lambda: time.monotonic() + TTL_SECONDS)


class Sessions:
    def __init__(self) -> None:
        self.values: dict[int, Session] = {}

    def prune(self) -> None:
        now = time.monotonic()
        for chat_id in list(self.values):
            if self.values[chat_id].expires <= now:
                del self.values[chat_id]

    def get(self, chat_id: int) -> Session | None:
        self.prune()
        return self.values.get(chat_id)

    def put(self, chat_id: int, state: Session) -> None:
        self.prune()
        if chat_id not in self.values and len(self.values) >= MAX_SESSIONS:
            oldest = min(self.values, key=lambda key: self.values[key].expires)
            del self.values[oldest]
        state.expires = time.monotonic() + TTL_SECONDS
        self.values[chat_id] = state

    def remove(self, chat_id: int) -> None:
        self.values.pop(chat_id, None)


def private_chat(update: Update) -> bool:
    return bool(update.effective_chat and update.effective_user
                and update.effective_chat.type == "private"
                and update.effective_chat.id == update.effective_user.id)


def sessions(context: ContextTypes.DEFAULT_TYPE) -> Sessions:
    return context.application.bot_data["sessions"]


def button(state: Session, text: str, action: str, value: str = "") -> InlineKeyboardButton:
    return InlineKeyboardButton(text, callback_data=f"v1:{state.nonce}:{state.revision}:{action}:{value}")


def language_menu() -> InlineKeyboardMarkup:
    # Stateless preferences: language buttons remain usable after a restart.
    return InlineKeyboardMarkup([
        [InlineKeyboardButton("🇰🇭 ភាសាខ្មែរ", callback_data="lang:km")],
        [InlineKeyboardButton("🇬🇧 English", callback_data="lang:en")],
    ])


def screen(state: Session) -> tuple[str, InlineKeyboardMarkup]:
    if not state.language:
        return COMMON["chooseLanguage"] + "\n\n" + COMMON["urgent"], language_menu()
    t = LOCALES[state.language]
    rows = [[button(state, t["emergency"], "emergency")], [button(state, t["cancel"], "cancel")]]
    stage = state.stage
    if stage == "intro":
        text = t["intro"]
        rows.insert(0, [button(state, t["begin"], "begin")])
    elif stage in ("fever", "duration"):
        text = t[stage]
        rows = [[button(state, label, stage, value)] for value, label in t[stage + "Choices"].items()] + rows
    elif stage in ("warning", "vulnerable", "hydration"):
        text = (t["warningIntro"] + f"\n\n{state.warning + 1}/5: " + t["warnings"][state.warning]
                if stage == "warning" else t[stage])
        rows = [[button(state, t[value], stage, value)] for value in ("yes", "no", "unsure")] + rows
    elif stage == "result":
        text = t[state.result] + ("" if state.result == "red" else "\n\n" + t["care"])
        rows = [[button(state, t["restart"], "restart")], [button(state, t["prevention"], "prevention")]] + rows
    else:
        raise ValueError("Unsupported session stage")
    return text, InlineKeyboardMarkup(rows)


async def show(update: Update, context: ContextTypes.DEFAULT_TYPE, state: Session, prefix: str = "") -> None:
    text, markup = screen(state)
    await context.bot.send_message(update.effective_chat.id, text=prefix + text, reply_markup=markup)
    # Keep old state if sending fails. Processing is sequential, so taps cannot race.
    sessions(context).put(update.effective_chat.id, state)


async def start(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not private_chat(update):
        return
    sessions(context).remove(update.effective_chat.id)
    await show(update, context, Session())
    LOG.info("start_processed")


def finish(state: Session, result: str) -> None:
    state.stage, state.result = "result", result
    state.answers.clear()


def advance(state: Session, action: str, value: str) -> bool:
    """Same conservative referral rules as the Node version; never diagnose dengue."""
    t = LOCALES[state.language]
    if action == "begin" and state.stage == "intro" and not value:
        state.stage = "fever"
    elif action == "fever" and state.stage == "fever" and value in t["feverChoices"]:
        state.answers["fever"] = value
        state.stage = "warning" if value == "none" else "duration"
    elif action == "duration" and state.stage == "duration" and value in t["durationChoices"]:
        state.answers["duration"] = value
        state.stage = "warning"
    elif action == "warning" and state.stage == "warning" and value in ("yes", "no", "unsure"):
        if value != "no":
            finish(state, "red" if value == "yes" else "urgentYellow")
        else:
            state.warning += 1
            if state.warning == 5:
                state.stage = "vulnerable"
    elif action == "vulnerable" and state.stage == "vulnerable" and value in ("yes", "no", "unsure"):
        state.answers["vulnerable"] = value
        state.stage = "hydration"
    elif action == "hydration" and state.stage == "hydration" and value in ("yes", "no", "unsure"):
        urgent = (value != "yes" or state.answers["vulnerable"] != "no"
                  or state.answers["fever"] == "unsure"
                  or state.answers.get("duration") in ("long", "unsure"))
        finish(state, "urgentYellow" if urgent else "green" if state.answers["fever"] == "none" else "yellow")
    else:
        return False
    state.revision += 1
    return True


async def utility(update: Update, context: ContextTypes.DEFAULT_TYPE, name: str) -> None:
    if not private_chat(update):
        return
    state = sessions(context).get(update.effective_chat.id)
    languages = [state.language] if state and state.language else ["km", "en"]
    if name == "cancel":
        sessions(context).remove(update.effective_chat.id)
    for language in languages:
        t = LOCALES[language]
        text = (t["emergencyIntro"].split("\n\n")[0] + "\n\n" + t["otherArea"] if name == "emergency"
                else t["preventionText"] if name == "prevention"
                else t["cleared"] if name == "cancel" else t["help"])
        await context.bot.send_message(update.effective_chat.id, text)


async def utility_command(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    name = update.effective_message.text.split()[0].split("@")[0][1:]
    await utility(update, context, name)


async def fallback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    if not private_chat(update):
        return
    state = sessions(context).get(update.effective_chat.id)
    if not state or not state.language:
        await start(update, context)
    else:
        await show(update, context, copy.deepcopy(state), LOCALES[state.language]["fallback"] + "\n\n")


async def on_callback(update: Update, context: ContextTypes.DEFAULT_TYPE) -> None:
    query = update.callback_query
    if not query:
        return
    # First await: acknowledge immediately, even if data/state turns out to be invalid.
    try:
        async with asyncio.timeout(3):
            await query.answer()
    except (TelegramError, TimeoutError):
        LOG.warning("callback_ack_unavailable")  # Old query/network failure must not prevent recovery.
    if not private_chat(update):
        return
    data = query.data
    if not isinstance(data, str) or len(data.encode("utf-8")) > 64:
        await fallback(update, context)
        return
    # Accept language buttons from both this implementation and the older Node bot.
    language = {"lang:km": "km", "lang:en": "en", "lang_kh": "km", "lang_km": "km", "lang_en": "en"}.get(data)
    old_language = re.fullmatch(r"[a-f0-9]{12}:\d+:language:(km|en)", data)
    if language or old_language:
        language = language or old_language.group(1)
        await show(update, context, Session(language=language))
        LOG.info("language_selected language=%s", language)
        return
    current = sessions(context).get(update.effective_chat.id)
    match = re.fullmatch(r"v1:([a-f0-9]{12}):(\d{1,8}):([a-z]+):([a-z]*)", data)
    if not current or not current.language:
        await start(update, context)
        return
    state = copy.deepcopy(current)
    if not match or match[1] != state.nonce or int(match[2]) != state.revision:
        await show(update, context, state, LOCALES[state.language]["stale"] + "\n\n")
        return
    action, value = match[3], match[4]
    if action == "restart" and not value:
        await start(update, context)
    elif action in ("emergency", "prevention", "cancel") and not value:
        await utility(update, context, action)
    elif advance(state, action, value):
        await show(update, context, state)
    else:
        await show(update, context, state, LOCALES[state.language]["stale"] + "\n\n")


async def error_handler(update: object, context: ContextTypes.DEFAULT_TYPE) -> None:
    error = context.error
    details = (type(error), error, error.__traceback__)
    if isinstance(error, Conflict):
        LOG.error("polling_conflict: Stop other Render/local instances using this token. PTB will retry.", exc_info=details)
        return  # PTB's polling network loop supplies its own backoff; don't launch a second loop.
    LOG.error("update_or_network_error", exc_info=details)
    if isinstance(error, Forbidden):
        if isinstance(update, Update) and update.effective_chat:
            sessions(context).remove(update.effective_chat.id)
        return
    if isinstance(update, Update) and private_chat(update):
        try:
            async with asyncio.timeout(5):
                await context.bot.send_message(update.effective_chat.id,
                    LOCALES["km"]["recovery"] + "\n\n" + LOCALES["en"]["recovery"])
        except (TelegramError, TimeoutError):
            LOG.warning("recovery_reply_unavailable", exc_info=True)


async def startup_call(operation: Any) -> Any:
    for attempt in range(5):
        try:
            return await operation()
        except RetryAfter as error:
            if attempt == 4:
                raise
            value = error.retry_after
            await asyncio.sleep(value.total_seconds() if hasattr(value, "total_seconds") else value)
        except NetworkError as error:
            if isinstance(error, BadRequest) or attempt == 4:
                raise
            LOG.warning("startup_network_retry attempt=%s", attempt + 1)
            await asyncio.sleep(min(2 ** attempt, 15))


async def cleanup_sessions(application: Application) -> None:
    while True:
        await asyncio.sleep(60)
        application.bot_data["sessions"].prune()


async def post_init(application: Application) -> None:
    expected = os.environ.get("EXPECTED_BOT_USERNAME", "kh_dengue_bot").lstrip("@").lower()
    if expected and application.bot.username.lower() != expected:
        raise ValueError("Token belongs to an unexpected bot; check EXPECTED_BOT_USERNAME")
    # Explicit destructive reset requested for this deployment. Never call this on
    # individual /start commands or every reconnect: it discards queued user messages.
    await startup_call(lambda: application.bot.delete_webhook(drop_pending_updates=True))
    info = await startup_call(application.bot.get_webhook_info)
    if info.url:
        raise RuntimeError("Webhook remains configured; stop the other deployment")
    LOG.info("webhook_cleared drop_pending_updates=true")
    try:
        for language in ("", "en", "km"):
            description = "ចាប់ផ្តើម និងជ្រើសភាសា" if language == "km" else "Start and choose language"
            await startup_call(lambda: application.bot.set_my_commands(
                [BotCommand("start", description)], language_code=language))
    except TelegramError:
        LOG.warning("command_menu_registration_failed; /start handler remains available", exc_info=True)
    application.bot_data["cleanup_task"] = asyncio.create_task(cleanup_sessions(application))
    HEALTH.update(status="initialized", bot_username=application.bot.username)
    LOG.info("startup_ready mode=polling bot_username=%s storage=memory", application.bot.username)


async def post_shutdown(application: Application) -> None:
    task = application.bot_data.get("cleanup_task")
    if task:
        task.cancel()
        with suppress(asyncio.CancelledError):
            await task
    application.bot_data["sessions"].values.clear()
    HEALTH["status"] = "stopped"
    LOG.info("shutdown_complete")


def build_application(token: str) -> Application:
    application = (Application.builder().token(token).concurrent_updates(False)
                   .connect_timeout(10).read_timeout(15).write_timeout(15).pool_timeout(5)
                   .get_updates_connect_timeout(10).get_updates_read_timeout(40)
                   .post_init(post_init).post_shutdown(post_shutdown).build())
    application.bot_data["sessions"] = Sessions()
    private_messages = filters.UpdateType.MESSAGE & filters.ChatType.PRIVATE
    application.add_handler(CommandHandler("start", start, filters=private_messages))
    application.add_handler(CommandHandler(["help", "emergency", "prevention", "cancel"], utility_command, filters=private_messages))
    application.add_handler(CommandHandler("resume", fallback, filters=private_messages))
    application.add_handler(CallbackQueryHandler(on_callback))  # No regex gate: unknown callbacks must recover too.
    application.add_handler(MessageHandler(private_messages, fallback))
    application.add_error_handler(error_handler)
    return application


class HealthHandler(BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path not in ("/", "/health", "/healthz"):
            self.send_error(404)
            return
        body = json.dumps({**HEALTH, "check": "process_liveness_only"}).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, _format: str, *args: Any) -> None:
        pass  # No request paths or visitor addresses in application logs.


def main() -> int:
    # Preserve the existing Render secret when cutting over from the Node service.
    token = (os.environ.get("TELEGRAM_TOKEN", "").strip()
             or os.environ.get("TELEGRAM_BOT_TOKEN", "").strip())
    configure_logging(token)
    server = None
    loop = None
    try:
        if not re.fullmatch(r"\d+:[A-Za-z0-9_-]{20,}", token):
            raise ValueError("Set TELEGRAM_TOKEN in the service environment")
        if os.environ.get("ENABLE_HEALTH_SERVER", "false").lower() == "true":
            port = int(os.environ.get("PORT", "10000"))
            if not 1 <= port <= 65535:
                raise ValueError("PORT must be between 1 and 65535")
            server = ThreadingHTTPServer(("0.0.0.0", port), HealthHandler)
            Thread(target=server.serve_forever, daemon=True).start()
            LOG.info("health_server_started port=%s", port)
        loop = asyncio.new_event_loop()
        asyncio.set_event_loop(loop)
        application = build_application(token)
        LOG.info("starting_polling; only one deployment may use this token")
        application.run_polling(
            allowed_updates=["message", "callback_query"],
            drop_pending_updates=False,  # Already dropped once in post_init; retain new arrivals.
            bootstrap_retries=3, timeout=30, poll_interval=0.25,
            stop_signals=None if os.name == "nt" else (signal.SIGINT, signal.SIGTERM),
        )
        return 0
    except Exception:
        LOG.exception("startup_failed")
        return 1
    finally:
        if server:
            server.shutdown()
            server.server_close()
        if loop and not loop.is_closed():
            loop.close()


if __name__ == "__main__":
    raise SystemExit(main())
