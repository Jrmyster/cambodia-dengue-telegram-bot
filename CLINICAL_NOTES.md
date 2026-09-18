# Clinical and referral notes

Reviewed against the sources below on **2026-09-18**. This implementation is an intentionally conservative layperson referral flow. WHO does not publish or validate this specific three-color Telegram algorithm.

## Evidence and scope

- The [WHO dengue Q&A](https://www.who.int/news-room/questions-and-answers/item/dengue-and-severe-dengue) describes the usual fever course, danger signs, deterioration as fever falls, and the need for immediate care when severe symptoms appear. The bot therefore screens every fever path for danger signs and never equates falling fever with recovery.
- The [WHO dengue fact sheet](https://www.who.int/news-room/fact-sheets/detail/dengue-and-severe-dengue) supports paracetamol, avoidance of aspirin/ibuprofen, mosquito-bite prevention, and weekly water-container cleaning. The bot gives no individualized dose: age, weight, formulation and contraindications require appropriate assessment.
- The [WHO outbreak toolbox](https://www.who.int/emergencies/outbreak-toolkit/disease-outbreak-toolboxes/dengue-outbreak-toolbox) includes laboratory and examination findings that this bot cannot assess. It is not a substitute for a clinician's full WHO classification.
- [CDC clinical care of dengue](https://www.cdc.gov/dengue/hcp/clinical-care/index.html) supports escalation for poor oral intake, abnormal urine output, pregnancy, infants/older adults, comorbidities and poor access to monitoring/care. These extend the user's requested screen to reduce false reassurance. The selected cutoffs and mapping to urgent yellow are product referral rules requiring local review.
- [CDC managing dengue](https://www.cdc.gov/dengue/treatment/index.html) reinforces monitoring as fever resolves and prompt response to warning signs. The bot directs fever patients to a clinician today; “within 24 hours” is an upper bound for otherwise stable users, never a reason to delay when worried or deteriorating.
- [CDC infant guidance](https://www.cdc.gov/dengue/treatment/dengue-infants.html) supports urgent assessment of infant dehydration. Infant fever deserves additional clinical caution; the screen expressly flags babies under three months with fever for immediate medical attention.
- The [CDC dengue case-management pocket guide](https://www.cdc.gov/dengue/media/pdfs/2024/05/20240521_342849-B_PRESS_READY_PocketGuideDCMC_UPDATE.pdf) and [WHO dengue guidelines](https://iris.who.int/bitstream/handle/10665/44188/9789241547871_eng.pdf?sequence=1) provide further clinical context for referral and fluids. Transport text permits small ORS sips only when alert, swallowing normally and not repeatedly vomiting; nothing by mouth when consciousness/breathing/swallowing is impaired. This bot never prescribes IV fluids.
- The [WHO global dengue update](https://www.who.int/emergencies/disease-outbreak-news/item/2024-DON518) supports source reduction and appropriately directed larvicide use. Abate is mentioned only with local-authority approval and product instructions; the bot deliberately supplies no general-purpose pesticide dose.

NS1 and CBC are suggestions for clinician consideration, not a required package, proof of infection, or permission to stay home after a negative result. The bot cannot assess shock, platelet/hematocrit trends, organ involvement, or alternative serious diagnoses. A reported warning sign causes emergency referral; it does not confirm “severe dengue.” Green means lower urgency from these limited answers, not absence of dengue.

## Directory provenance

| Entry | Source | Status and limitations |
|---|---|---|
| Cambodia ambulance 119 | [Telecommunication Regulator of Cambodia](https://www.trc.gov.kh/en/resources/emergency-numbers/) | Official ambulance short code; no guarantee of coverage or response time |
| National Pediatric Hospital, Phnom Penh | [Hospital website](https://nphcambodia.info/) | Published patient hotline 099 761 675, listed as 24/7; address 100 Russian Federation Boulevard. Its administrative number is intentionally not substituted for the hotline |
| Angkor Hospital for Children, Siem Reap | [Hospital contact page](https://angkorhospital.org/contact/) | Published general contact 063 963 409; Tep Vong/Oum Chhay, Svay Dangkum. Website lists a 24-hour emergency room, but the general number is not labeled an ambulance dispatch line |
| Kantha Bopha, Phnom Penh and Siem Reap | [Hospital foundation's facilities page](https://www.beat-richner.ch/kinderspitäler) | Verified campus/city descriptions. No current Cambodian patient number verified; no Swiss foundation number is presented as emergency care |
| Battambang Provincial Referral Hospital | [NSSF facility list mirrored by TBCC, 2019 path](https://www.tbcccambodia.org/images/upload/useful_information/attach_file/11-Apr-2019/LIST_OF_HEALTH_FACILITIES_SIGNED_THE_AGREEMENT.pdf) | Historical ambulance listing 012 269 388; Prek Moha Tep, Svay Por. Search-indexed document text was available, while direct PDF retrieval timed out. Explicitly marked old and unverified in the bot; 2019 is the hosting-path year, not a recent verification date |
| Kampong Cham Provincial Referral Hospital | [NSSF directory, 2016](https://www.nssf.gov.kh/wp-content/uploads/2016/09/en.pdf) | Historical ambulance listing 012 823 709; Village 7, Kampong Cham. Explicitly marked old and unverified in the bot |

No numbers were call-tested. Online publication is not confirmation of current service. The directory is a starter selection, not a national list of all provincial hospitals or local Health Centers. Extend `src/referrals.js` with locally confirmed entries, bilingual addresses, contact type, source and review date; update the area dictionaries and tests if adding areas. Preserve the historical label until an entry is reconfirmed. For new Health Centers, identify them as stable-patient assessment sites, not emergency hospitals.

Map buttons are optional **search links**, not verified coordinates or nearest-facility calculations. Maps send the selected facility name to Google, not the patient's location. Addresses and phone text are available without loading maps. Emergency guidance always favors the nearest appropriate facility over travel to a distant named hospital; pediatric destinations are identified for children only.

## Required local clinical acceptance work

Have the implementing health organization review both dictionaries with a Cambodian clinician and a native Khmer speaker familiar with parent/community-health-worker vocabulary. Perform comprehension checks and back-translation, particularly for altered alertness, black stool, oral rehydration and referral urgency. No independent human Khmer review has been completed as part of this delivery.

Document the approving clinician, Khmer reviewer, version/date, local transport fallback and contact recheck owner before public use. This is a deployment quality step for the supplied medical content, not a claim that the code has been clinically certified.
