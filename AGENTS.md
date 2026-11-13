# Working rules for Lina (inbound_final)

This file is the standing contract for anyone (human or agent) changing this
repo. It is deliberately the FIRST thing to read: most of it is written in blood
from real field incidents, and every rule here has a test behind it.

## 0. The owner's standing directive (do not make them repeat it)

> Address limitations FULLY and fix them the harder, right way — for appliance
> reliability and future maintenance. No half-assed job because it is easier.
> No shortcuts, no patches. Straight, clean, bulletproof code, no matter the
> time.

Concretely, that means:

- When a bug is found in a code path you are touching, FIX the cause — including
  the sibling cases. If a refusal shape is broken, sweep the whole family. If a
  lexicon stem misfires, sweep the whole lexicon against the shipped copy.
- Never weaken an assertion, skip a test, swallow an error or add a suppression
  to make a check green. If an expectation was wrong (a typo in the test, a
  phrase that only one bank variant uses), fix the EXPECTATION and say why in a
  comment.
- Verify the artifact through the interface the user/operator actually uses —
  for the TUI that is a real terminal (see §3), not a mock of one.
- Report what did NOT work as a limitation. Never present an unrun or failed
  check as a pass.

## 1. Verification before declaring anything done

```bash
npm run typecheck                       # tsc --noEmit
npm test                                # the whole suite (tsx, authoritative)
npx tsx scripts/tui-frame-check.ts      # headless layout/painter invariants
npx tsx scripts/tui-pty-check.ts        # the REAL TUI under a REAL pty
npm run bank:audit-seeds                # contracts + offensive false positives
```

### The fast loop (do NOT spend 5 minutes per fix)

`npm test` stays the authoritative gate and is untouched: it is the original
command (`tsx --test tests/*.test.ts`, all 276 files) and the independent path
the safety net is measured on. It pays `tsx` boot + transpile per file and takes
~30 min. The four levels below are the door you actually use daily:

```bash
npm run test:smoke                                     # ~7 s  grammar/lexicon/router core
npm run test:t -- tests/<the files you touched>.test.ts # seconds, exactly those files
npm run test:integration                               # handler + sqlite + geo + net
npm run test:c                                         # ALL files, sharded, ~14 min
npm run test:fast                                      # all but the PTY-funnel file
```

All levels run through `scripts/test-run.mjs`: esbuild bundles the selected
files (one invocation, the `require.main` define keeps CLI bodies from running),
then each FILE runs in its own process with its own TAP file under
`.bench/tap/` — so a parallel run can never shred a `not ok` block between two
files' output, which is why the gate used to be run serially at ~55 min. The
runner also kills any file that overruns `TEST_FILE_TIMEOUT` (default 300 s)
and reports it FAILED, so a hang cannot wedge the gate, and it reports a file
that produced zero passing subtests as FAILED, so a crash cannot read as green.
`TEST_CONCURRENCY=n` sets files in flight (default `cores*2`).

`npm run test:profile` runs the full suite and writes `.bench/test-profile.json`
(per-file wall time) — use it to pick the next target instead of guessing.

The PTY funnel file boots the real TUI twice (~25 s) — that is why `test:fast`
leaves it out; it MUST run before a deploy, together with the full `npm test`.

Every one of these must pass. `npm run bank:audit-seeds` also runs the P5
offensive sweep over all seeds and learned variants.

When the question is "are the LLMs actually connected?" (the answer lives
outside the repo — see §6), run the LIVE check instead of inferring it from the
code. It needs keys + network, so it is deliberately NOT part of `npm test`:

```bash
npm run llm:live-check:fast   # config, every Gemini key, Groq, all brain modes
npm run llm:live-check        # + the shipped TUI under a pty (/status, /brain …)
```

It asserts each Gemini key individually, the hybrid/gemini/groq clients, and the
REAL `Responder` escalation path in every `/brain` mode (free mode still
escalates to a real brain — that is the knowledge-based dispatch contract). A
429 is reported as a spent quota window (the key is valid, rotation skips it),
never as a missing LLM.

## 2. The two money ladders (the most expensive area to get wrong)

There are TWO independent money topics, each with its own four rungs, counter
and copy:

| topic | counter | rungs |
| --- | --- | --- |
| visit fee (500 ден buy / 300 ден rent) | `slots.feeRejections` | `fee.ask.*` → `fee.persuade.1.*` → `fee.rule.hold` → `fee.decide` |
| rent commission (50% under 1.000 €, one month at 1.000 €+) | `slots.provisionRejections` | `provision.persuade.1.rent` → `provision.rule.hold` → `provision.decide` |

THE ISOLATION CONTRACT: resisting the commission never burns a visit-fee rung,
and resisting the fee never burns a commission rung. Tests:
`tests/fee-serve-routing.test.ts` (`e2e isolation`, `commission refusal shapes`).

NAG ORDER (both fees, one rule): a nag is ANY resistance — charge accusation
("PARI ZEMATE ZA POSETA ?"), value complaint ("MNOGU NEKAKO 500DEN…"),
universal/"only you" ("NIKOJ NE NAPLATUVA…"), refusal, or a charge question.
Each nag burns exactly ONE rung on that fee's own counter:
1 → `fee.persuade.1.<service>`, 2 → `fee.rule.hold`, 3 → `fee.decide`,
4 → `fee.graceful.close` + queue. Complaints and "nobody charges but you" are
NAGS (they used to be free fee.why answers, which stalled the ladder forever).
A RHETORICAL CHALLENGE is a nag too: `KAJ SE VIDELO PARI ZA OTVARANJE STAN`
(place-word + attribution verb — каде/кај/од каде + виде/гледа/пишува/чита/најде
— beside fee traffic), `KADE PISE DEKA SE PLATKA ZA POSETA`, and a money noun
+ viewing noun with no charge verb at all (`PARI ZA OTVARANJE STAN`).
THE LOCATION LANES STAND DOWN ON FEE TRAFFIC (`isFeeTraffic`): a каде-shaped fee
challenge is NOT a place question — the [22:03] capture read the clause as a
place ("VIDELO PARI ZA OTVARANJE STAN"), missed the lookup, and answered with a
landmark + maps pin for a place the client never asked about. `detectWhereIs`
and `isWhereLandmarkQuestion` return undefined/false on fee traffic; genuine
where-is / landmark questions (`KADE SE NAOGJA GEOLOSKI ZAVOD?`) are untouched.
THE WHY-WORD DECIDES THE LANE BY POSITION: a why-word that LEADS is the
explanation lane (`zosto barate pari za poseta?` → `fee.why`, no rung), while a
why-word TRAILING an accusation is the accusation itself
(`PARI ZA POSETA ZEMATE ? ZOSTO?` → nag, rung 1). The client named the money
first and appended the why as an afterthought.
THE BARE CHARGE QUESTION COUNTS (the [13:09] capture): «NAPLATUVATE ?» — the
whole message is the 2nd-person charge verb and a question mark — is a nag and
climbs rung 1. Families that demand an object noun or a negation miss it, and
the funnel re-serves the SAME fee.ask disclosure (the re-disclosure bug). The
arm is whole-message anchored, so a longer sentence keeps its own lane, and a
payment-METHOD ask («плаќате со картичка?») stays out.
EVERYTHING NON-POSITIVE CLIMBS TO THE END (the [22:0x] field rule, buy AND
rent): a bare hesitation (`NEZNAM`, `OVA NE GO OCEKUVAV`, `ne sum siguren`,
`se mislam`, `ne znam dali da platam`) burns rung 1 — before this it was
answered with the `fee.ask.*` copy AGAIN (the re-disclosure bug) and burned
nothing. MID-ORDER EXITS: a POSITIVE ("DOBRO, SE SOGLASUVAM SO USLOVITE") goes
to contact collection (`contact_collection` + the contact ask) and never burns a
rung; a goodbye ("NE FALA, CAO") runs the bye protocol. Scheduling/location
hesitations are NOT resistance: a timing word (`ne znam koga ke mozam`), a day
word or a каде-word (`ne znam kade e stanot`) keeps its own lane.
PRACTICE DISAPPROVAL IS A NAG (the [23:12] capture): a dislike verb plus a
POLICY noun (`NE MI SE DOPAGJA VAKOV PRINCIP NA RABOTA`, `не ми се допаѓа
вашиот пристап`, `не ми е ок оваа политика`) burns a rung — the client is
rejecting the fee MODEL. A dislike with no policy noun is about a PROPERTY
(`ne mi se dopagja stanot`) and keeps its lane, and a policy ASSERTION
(`тоа се правилата на агенцијата`) is still the `fee.rules` explanation — no
rung (pinned in `tests/fee-serve-routing.test.ts`, the [12:40] e2e).
THE PER-VISIT MATHS QUESTION CLIMBS ONCE THE LADDER IS CLIMBING (the [19:40]
capture): «ZA SEKOJ STAN STO KE SE POSETI PO 500 ?» is `detectFeePerPropertyAsk`
(a per-unit marker + a viewing anchor + a fee-sized figure, currency optional).
On a FRESH question it gets `buildFeePerProperty` — rule confirmed, the client's
own sum named, no rung burned. Once `slots.feeRejections >= 1` it is just
another nag: the lane serves the rung ALONE (no maths prefix) so rung 3 is the
binary decision, never a re-explanation of terms the client already rejected.
The price lanes are vetoed on it (`isFeeTraffic`/`isFeeFrame`/per-property /
fee-amount) — the field answered this very message with `price.negotiate`.
NO PIVOT OUT OF A NAG: `detectCheaperSearch` is vetoed on `detectFeeNag`, so a
fee objection can never be answered with a cheaper-property pair — the [23:12]
burst pivoted to EB 56 + EB 42 instead of finishing the ladder with the binary
question (`fee.decide`: book under these conditions or not — your call).
NOT nags: positive consent, a neutral how-much/why question (`kolku e za
poseta?`, `zosto naplatuvate?` — including the normalised `зосто` spelling),
`prv pat slusam`, and the surprise reaction (`OVA E NESTO NOVO` stays on
fee.why — it is not resistance).
A NEGATED AGREEMENT IS NEVER FEE CONSENT: `detectFeePaymentAgreement` refuses
negated-red phrases ("не ви е во ред, пари за посета земате зошто" contains
"во ред" and used to read as the yes → a resisting client pushed into contact
collection, the rent-capture class).
`detectFeeNag` is the one predicate (grammar families: stems + `\p{L}*`
inflections after `normalizeMc`, so word order, clitics and script do not
matter); both handler legs (fast path + FSM leg) must route through it, and the
classifier must never let a nag stand as `FEE_AGREED`.
THE DISCLOSURE TURN IS NEVER CONSENT: a visit command ("KONTAKTIRAJTE GO",
"DOGOVORI MI") is also an agreement token, so the turn that serves any
`fee.ask.*` clears `viewingFeeAgreed`. Without that, the client's next message —
even a fee question — jumped straight to contact collection (the rent capture).

## 2b. Two room categories, one cap EACH (`slots.categoryBudgets`)

«DVOSOBEN MOZE DO 90000 I TROSOBEN DO 150000» is not "2 rooms + budget". The
[19:14] capture served two ДВОСОБНИ, one of them 110.000 — 20.000 over the cap
the client had named FOR THAT CATEGORY (the 150.000 of the трисобен leg had
become the only budget, and the second category was dropped).

- `detectCategoryBudgets` (`src/llm/deterministic.ts`) pairs each figure with
  the category BY POSITION — each category owns the text up to the next one and
  takes its first figure; a figure BEFORE the first category belongs to it, and
  an already-capped category hands its stretch figure to the next uncapped one
  (the reversed «do 90000 dvosoben» order). One source of truth: the money scan
  (`collectMoneyMentions`) is the SAME one `detectBudget` uses.
- It lands as `slots.categoryBudgets` (room → its own cap), with
  `bedroomsMin/Max` + `bedroomsAlt` carrying the categories and `slots.budget`
  holding the HIGHEST cap so every other lane keeps one honest figure. An exact
  room count or a plain range retires the split (`applySlots`).
- SERVE: `categoryPairQueue` interleaves one card per category per batch, each
  filtered by ITS OWN cap, nearest to the named place first (inside each
  category), and the nearer of the two leads. A drained category hands the
  batch to the survivor (two cards a turn).
- HONESTY: the drain sentence is decided where the batch is carved
  (`categoryDrainNote`) and applied at the send choke, so no serve lane can drop
  it; when every category is drained in the area the turn offers BOTH pivots —
  «друга населба или во друга категорија». Figures come from the slots, never
  hardcoded. Pinned in `tests/category-budget-pairs.test.ts`.
- TWO TRUTHS, TWO SENTENCES (the [03:45] capture): a category the client has
  NEVER seen a card of, in THIS geography, is a gap in the system — «Моментално
  во системот нема двособни до 120.000 евра во Аеродром — Ви покажувам
  трoсобни» at the START of the serve; «Тоа е сè што имав двособни до 120.000
  евра …» is for one that WAS shown and has now run out. `slots.categoriesServed`
  therefore carries `categoriesServedGeo` (location + place anchor): a pair
  served in Центар says nothing about the stock around a landmark named next,
  and without the key the wording lied in both directions. The drain key
  (`categoryDrainedTold`) includes the same geography, so the line is spoken
  once per fact, not once per chat.
- THE SAME SENTENCE COVERS EVERY CATEGORY (`noStockLine`, the [03:45] rule
  applied to every type): a plain single-category miss is a system gap too,
  never the old generic «немам недвижност што одговара на Вашите критериуми». The subject is the client's
  OWN category with its own money — «нема двособни до 120.000 евра», «нема
  трoсобни …», «нема гарсоњери до 300 евра месечно», «нема куќи со две спални
  до 500 евра месечно», «нема плацеви од 300 м² до 30.000 евра», «нема деловни
  простори од 50 м² до 1.000 евра месечно» — and a per-category cap
  (`categoryBudgets`) outranks the single budget for its own tier. Every
  criterion the client stated is in the sentence (a house's спални, a plot's
  м²): the absence is scoped by what emptied the pool, never by less. The area comes from the search
  (location, or the place anchor, never when `anywhere`), and the exits are the
  client's real ones: another neighbourhood only when he pinned one, the price
  only when he gave one, and always the register offer (never drop the lead).
  `fresh` is the truth switch, not styling: it declines when the tier WAS on the
  table here, so the drained family answers instead.
- THE NOTEBOOK IS WRITTEN BY EVERY SERVE (`noteCategoriesOnTable` in
  `loadProps`), not only by the pair lane: «was this category on the table?» is
  a fact about the table, and the single-category answer reads the same record
  the pair contract lives by. Pinned in `tests/no-stock-named-family.test.ts`
  (one tier shown → «Уште?» is the drained family, while a tier this geography
  never served is named — even in the same search).
- THE THREE-ROOM PLURAL IS «трoсобни» (a LATIN o), the owner's own spelling —
  never «трисобни» (`roomCategoryLabel`). Pinned in
  `tests/capture-0342-tier-serve.test.ts`.

Rules for touching this area:

- A refusal aimed at the commission must be detected by the COMMISSION detector
  (`detectProvisionResistance`), in every word order and script — including
  refusals that carry no pay verb at all (`NE SAKAM PROVIZIJA`,
  `ПРОВИЗИЈАТА НЕ ЈА ПРИФАЌАМ`). The commission noun is the object; do not lean
  on the fee-side negated-pay family (`detectNegatedFeePay` only knows fee
  objects: надомест/посета/такса).
- A NEGATED complaint is agreement, not resistance (`провизијата НЕ Е висока`) —
  strip the negated span before the complaint arm.
- The commission tier rule (`1.000 €` threshold, `50%`) is the only sanctioned
  figure in that family. `provision.rule.hold` may contain NO digit at all.
- Copy assertions in tests are CONTRACT-level (sanctioned figure present, ends
  with a question, forbidden claims absent) — never "the sentence I saw last
  week". Bank variants rotate; pinning one wording makes a false failure.
- THE ASK FAMILIES THAT ROTATE WORDINGS, matched as families and not pins:
  `both.ask.type` asks the category as the noun «тип недвижност» OR by
  enumerating it («барате стан, куќа, деловен простор или плац?») — a pin on
  «тип» failed on a good variant; `discovery.ask.location.any` asks «во кој дел
  од градот» / «во која населба» OR «одредена локација во градот», so a pin on
  the first two nouns fails too. Match `/тип|стан, куќа|деловен простор или
  плац/` and `/дел од градот|населба|локациј|градот/`; a NEGATIVE assertion
  must use the same family or it silently stops checking.

## 2c. Alternative budget: one up to X OR two up to Y (`slots.countBudget`)

«MOZE SO EDNA DO 80000 ILI DVE DO 140000» is TWO money rules, not one: a single
card up to 80.000, or TWO cards whose TOTAL stays inside 140.000. `detectBudget`
keeps the largest figure, so the old read made 140.000 "the budget" — the [20:08]
serve paired a 133.000 трисобен with a 55.000 двособен, and the next «DRUGO NESTO
IMA, OSVEN OVIE DVA?» refilled with a 110.000 row because 110.000 ≤ 140.000
looked like a criteria fit.

- `detectCountBudget` (`src/llm/deterministic.ts`) splits the message at the OR
  marker: a count (една/еден/1, две/два/2) AND money on BOTH sides. One side
  without money is the room RANGE («edna ili dve»), never money. The money scan
  is `collectMoneyMentions` — the SAME one `detectBudget` uses.
- `slots.budget` keeps `single` (the STRICTER figure), so every single-card lane
  — pool, pivots, price answers — is honest by construction; the pair total
  rides `slots.countBudget` and is applied where a batch is carved
  (`fitCountBudgetPair` in `loadProps`): a row too rich for THIS pair stays
  queued for a later one.
- THE WHOLE FAMILY VETOES, not the sentence: a count-budget message is never a
  bedroom count (`detectBedrooms`) and never a room range
  (`detectBedroomsRange`); and it is never a counter-offer (`detectNegotiate`,
  whose modal bridge now also carries the cap-word guard B8 shares with B1/B2).
  Without those three the money never reaches the slots at all — the [20:08]
  capture was answered with the fixed-price owner pitch.
- WHICH AXIS THE COUNTS COUNT IS A SESSION DECISION
  (`InboundHandler.countBudgetNamesRooms`), never the words alone: «so edna do X
  ili so dve do Y» means one bedroom / two bedrooms in this market AND one flat
  / two flats in [20:08]. With the size axis still OPEN (no `bedrooms`, no
  `bedroomsMin/Max`, no waiver, no studio/plac/business/yard) the counts ARE the
  two room categories and land in `slots.categoryBudgets` (§2b) — one of each,
  each inside ITS OWN cap, nearest first — and NEVER in `countBudget` (a pair
  TOTAL is a different money rule and must not cap every single card twice).
  The counts are BEDROOMS and the feed's axis is ROOMS: «една спална» is a
  ДВОСОБЕН (2 rooms), «две спални» a ТРИСОБЕН (3) — `roomsFromBedrooms` states
  that convention ONCE for the short forms, exactly as `detectBedrooms` applies
  it inline (the трисобен EB 66 answered «SO DVE SPALNI»). The SINGLE-count
  sibling («MOZE SO EDNA DO 100 000» answering «колку спални?») banks
  `slots.bedrooms` through `detectBareBedroomCount`, same predicate, same
  convention — read as a cap alone, the size slot stayed empty and the funnel
  asked again.
  The [09:46] capture: «MOZE SO EDNA DO 100 000 ILI SO DVE DO 150 000» answered
  the funnel's «колку спални соби?» and, read as flats, left the size slot empty
  so the funnel asked the SAME question again. A `SPALNI BILO KOLKU` waive (same
  message or an earlier turn) or an already-banked room criterion keeps the
  FLAT reading — the [20:08] contract. A property/option noun on the count
  («MOZE EDEN STAN DO 80000», «DAJ MI DVE OPCII») means QUANTITY, never size.
  Pinned in `tests/counted-room-pairs.test.ts` (both axes) next to
  `tests/count-budget-pair.test.ts`.
- SWEEP EVERY SIZE ANSWER, not the one in the bug report:
  `tests/size-answer-sweep.test.ts` drives each captured answer shape through
  the real handler (bare counts «2»/«DVA» and «daj so edna», the plus-notation
  «2+1»/«1+1»/«3+1», rooms named directly «DVE SOBI»/«2 SOBI», the adjectives
  «DVOSOBEN»/«TROSOBNI», ranges «EDNA ILI DVE», the studio «GARSONJERA», and
  the waivers «SPALNI BILO KOLKU»/«NEBITNO») and asserts BOTH that the size
  axis LANDED and that the question never comes back. It is a family test: a
  new answer shape belongs there, or the next capture re-opens the loop. The
  negative assertion matches the QUESTION (`колку спални` / `спални соби…?`),
  never the words alone — every card description says «две спални соби», and the
  waiver ACK says «големината не е проблем».
- WHEN THE MONEY IS SPENT the turn says it with HIS two figures
  (`countBudgetDrainedLine`), offers the pricier pair (they match the
  characteristics; they are simply above his money) and names the third way out
  (change the request/neighbourhood). Options come only AFTER the ask.
- The pricier/similar serve never inherits the anchor's room count when size was
  waived (`slots.sizeWaived`), and when NOTHING is pricier it says so and serves
  the closest same-characteristics rows instead of going silent.
- An answer that NAMES another neighbourhood re-runs the PRIMARY request THERE
  (area = the named one, budget = the primary one), never a silent city-wide
  widen.
- Pinned in `tests/count-budget-pair.test.ts`.

## 2d. A purchase cap is read AT ITS MAGNITUDE — never as an Евидентен број

The [20:11] price sweep (`tests/price-answer-sweep.test.ts`) over the captured
price answers (84 distinct messages) found two defects in one area:

- A BUY cap typed in SMALL EUROS dead-ended the funnel: «DO 200 EVRA» was banked
  as 200 €, the pool had nothing under 200 and the turn answered a NO-MATCH for
  money the client never meant. `purchaseBudgetMagnitude` (`deterministic.ts`)
  scales a euro figure below `PURCHASE_MIN_PLAUSIBLE_EUR` (10.000) by 1000 on a
  PURCHASE — and only then: RENT keeps its literal hundreds (250–1300 € a month
  is the real band, and the same words are CORRECT there), a figure with NO euro
  marker is never touched («100000», «200 ILJADI», «до 100.000»), and the rule is
  idempotent (a scaled figure is over the floor). `extractSlots` applies it to
  the WHOLE money family (budget, `countBudget` pair, `categoryBudgets` caps)
  when the message itself names the purchase; `applyPurchaseMagnitude` applies it
  again in the handler once the SESSION service is known — the buy intent usually
  arrived in an EARLIER turn, which is exactly the capture's shape.
- «KE DADAM 400 E» / «400 E» was read as ЕВИДЕНТЕН БРОЈ 400 — «400 моментално го
  нема во нашата понуда» — for a client naming his own price. The lone market «E»
  is a currency token now, in BOTH readers: the money scan
  (`collectMoneyMentions`) and the EB grammar (`UNIT_TAIL` in `ebNumber.ts`). It
  counts ONLY clause-final (`[eEеЕ](?!\s*[\p{L}\p{N}])`): the copula («DA, 63 E
  TAA» = "63 IS that") and a per-² rate («1286E PO M2») stay non-money, and the
  63 there is still an EB.
- NO figure is ever read as a fraction of a stored/asked budget — the sweep pins
  verbatim reads for every captured shape, so a new shape goes in that file.

## 2e. TWO MARKETS IN ONE SEARCH — rent AND buy, one card each (the [19:19] batch)

«DO 150000 ZA KUPUVANJE» then «DO 350 ZA IZNAJMUVANJE» are TWO caps, not a
correction: the second used to overwrite the first, so the funnel listed sale
flats inside the buy cap and the rent ask then had to be answered by the LLM
(the rows were in the DB the whole time).

- `slots.dualService` + `slots.rentBudget` + `slots.buyBudget` carry the pair;
  every serve is ONE rent card and ONE buy card, each under ITS OWN cap, in the
  pinned area. `slots.budget` is never shared across the two markets.
- A later message that NAMES one market («ZA IZNAJMUVANJE ?») NARROWS the
  search to that leg, hands that leg's own cap over as `slots.budget` and
  retires `dualService` — deterministic, from the DB, never an LLM round trip
  (the source stamp is asserted: an in-DB answer must not be `gemini:*`).
- `captureDualBudgets` is a PURE-DELIVERY reader, and the purity test reads the
  MESSAGE (`extractSlots(text)` + `areaNamed(text)`), NEVER the event: the
  classifier's `SEARCH_REQUESTED` event echoes the session's armed criteria
  (budget, service, bedrooms, garsonjera), so an event-side test swallowed
  «SPALNI BILO KOLKU» (a waiver with no money) and lost the waiver, and a
  message-side test that missed the feed-resolved AREA (extractSlots carries no
  location) swallowed «KIRIJA DO 350E VO CENTAR» and lost the whole search
  geography — the discovery re-asked the area the client had just named and the
  pricier/elsewhere pivots ranked the entire city (the [20:33] regression, a
  деловен простор served inside a Центар rent funnel).
- Pinned in `tests/dual-rent-buy-serve.test.ts` (one test per captured turn,
  including the place+budget message) and `tests/drugo-pivot.test.ts` (the
  drained-pool pivot keeps the area).

## 2f. A YES IS NEVER A WHY — and the arrange VERB is not a contract NOUN

The [19:34] capture: after two nags the client conceded — «STOM TAKA RABOTITE
DOGOVORI TOA E TOA» ("since that's how you work, arrange it, that's it"). The
why-family word inside that sentence made BOTH fee.why legs (fast + FSM) serve a
FOURTH explanation, and the legitimate contact ask never ran.

- Consent outranks the explanation lane everywhere a why-word gates a serve:
  `detectFeeWhy(text) && !detectFeePaymentAgreement(text)`. The same veto sits
  in the router mirror so the predicted intent matches the executor
  (tests/route-coverage.test.ts fails a tag with no calibration row).
- `detectFeePaymentAgreement` reads the concessive yes — a concession clause
  («штом/кога така работите» … договори/«тоа е тоа»), an agreeing opener plus
  the arranging imperative («ок, договори»), and the bare imperative on the deal
  («договори го», «ќе се договориме»). A VISIT COMMAND IS EXCLUDED
  (`VISIT_COMMAND_OBJECT_RE`): «DOGOVORI MI DA GO VIDAM 70» stays the visit lane,
  which owns the fee-first ordering.
- `ARRANGE_VERB_RE` is the shared verb reader, and the documents lane consults
  it: «договори тоа» is not a «договор». Before that, the consent turn was
  answered with the ID-papers lecture (`DOCUMENTS_ASK`), because the two share
  the stem. Only an explicit paperwork token («…, кои документи ми требаат?»)
  keeps the documents lane.
- **A VISIT REQUEST IS NOT MERE INTEREST — the fee-agreement gate asks
  `detectVisitRequest`, never `detectVisitInterest`.** «70 BI SAKAL DA GO
  POSETAM» after the disclosure IS the yes (the [19:32] capture), but «PA VIDI
  STO E SO NEGO / ZAINTERESIRAN SUM» only says he is interested: the broad
  predicate (which also fires on the grammar's bare «види» and on the typo
  fallbacks) turned that tail into consent and jumped to the contact ask. Both
  contracts are pinned — `tests/dual-rent-buy-serve.test.ts` and the older
  `tests/tui-captures-mining.test.ts` — and the split between them is exactly
  the REQUEST verb/noun family: the poseta verbs, «(би) го видам/погледнам/
  разгледам», the arrange imperatives, the viewing-noun asks.
- **«КОЈА АГЕНЦИЈА СТЕ ВИЕ?» IS ANSWERED ON BOTH SIDES, AND ONLY THE STILL-OPEN
  QUESTION IS REPEATED (the [19:36] capture).** Client and owner both asked it
  mid ping-pong and both heard the funnel's next line instead — the client the
  patience line, the owner the term re-asked — which reads as a bot that
  ignores people. `AGENCY_IDENTITY_ANSWER` names Метрополис and the interrupted
  question follows; the OWNER's leg is `ownerQuestionReply` (a question from
  the owner is answered, never parsed as a verdict). Repeat the LAST assistant
  turn's own question only: `lastAskedQuestion` over the whole history re-asked
  a term the client had already given («MOZAM VO VTORNIK VO 6» →
  owner_checking), so when that turn asked nothing the state's standing line
  (`patience.line`) says where the deal really stands.
  Pins: `tests/dual-rent-buy-serve.test.ts`, `tests/owner-relay.test.ts`.

## 3. TUI rendering: one emulator, two harnesses

`src/tui/terminal.ts` is the ONLY screen model. Both render checks use it:

- `scripts/tui-frame-check.ts` — headless: the real `buildLayout()`/`FramePainter`
  over fake streams (no scroll, pane integrity, resize, wait window, heal).
- `scripts/tui-pty-check.ts` + `tests/tui-pty-funnel.test.ts` — the SHIPPED entry
  point (`src/tui/run.ts`) under a real pty via `script(1)`, keystrokes in, the
  emulated screen asserted (boot, key routing, raw mode, the funnel end to end).

Do not write assertions against raw ANSI bytes: a frame can contain the right
text in the wrong row, or wrap the bottom row and scroll the physical screen.
Assert on `Terminal` state (`rowsText`, `paneText`, `paneCollapsed`, `scrolls`).

Hard-won details, all pinned by tests — do not "simplify" them away:

- The emulator MUST carry incomplete escape sequences across `write()` calls and
  decode UTF-8 incrementally: a pty splits sequences/runes across chunks, and a
  parser without the carry buffer prints the tail of `\x1b(B` as text, wraps the
  row and reports a phantom SCROLL (it reported 85 of them once).
- `paneText(label)` locates columns by its OWN label position (the layout puts a
  client list to the left of the chat) and strips scrollbar bones from line ends.
- Measure the no-scroll invariant from the app's first frame
  (`Terminal.scrolls` before/after boot): what a shell or the runtime printed
  before blessed took the screen over is not a frame defect.
- Reads must happen on a SETTLED frame (`PtySession.waitQuiet`) — a reply caught
  mid-repaint is half a block and produces a false rendering bug.
- Turn waits key off the reply's own character, not a counter: at 80 columns the
  top bar's `испратено: N` is truncated and the chat pane scrolls.
- Any wide/ambiguous-width rune reaching the screen wraps its row (the frame
  check's `hasWideGlyph` guard exists for the `⏳ клиентот пишува…` incident).

THE NOTEBOOK IS READABLE FROM THE TERMINAL (`/state`, alias `/slots`): the pty
check used to assert COPY only, so a correct sentence with a wrong counter was
invisible — the atom-side (handler) tests saw `slots`, the real-TUI test could
not. `/state` renders exactly three short rows from the live `SessionStore`:

```
[slots] state=<fsm state> svc=<service>
[slots] fee=<feeRejections> prov=<provisionRejections> agreed=<yes|no>
[slots] any=<anywhere> bud=<budget>
```Keep it to THREE short rows (a 24-row terminal leaves the chat pane ~10 rows; a
taller dump scrolls the newest reply and its own first rows off), and never wrap
  a value: the harness asserts these rows, so a scrolled-away counter is a check
that silently stops checking. The funnel asserts `fee=4` after the ladder (three
rungs + the [22:03] challenge) and `any=true bud=80000` after the discovery pass.

## 4. The strike classifier must never fire on our own copy

`classifyOffensive` runs deterministically on every inbound message; a hit spends
a strike and serves the professional-tone warning instead of the funnel. So a
lexicon stem that matches ordinary client words is an appliance defect:

- `'fakj'` matched `прифаќам` → `prifakjam` (severity-3 sexual strike for saying
  "I don't accept the commission"). `'erot'` matched `менаџерот` → `menadzEROT`.
- New stems that are convertible into innocent words (prefixes, inflections,
  multi-word phrases) need `boundary: true`, and then every real surface form
  gets its own stem — the boundary guard rejects embedded occurrences.
- `tests/offensive-lexicon-audit.test.ts` sweeps the whole bank + curated client
  vocabulary; `npm run bank:audit-seeds` sweeps seeds + learned variants. Add the
  new word to the curated lists when you add a guard.
- A FAMILY IS THE WHOLE CASE LADDER, NOT THE NOMINATIVE. The [11:57] capture
  «MA IDI U PICKU MATER» — the hardest thing a client can type — was served the
  neighbourhood-exhaustion line: the `pick` morphology row listed `picka/picki/
  picke` but not the ACCUSATIVE `picku` (the object of «у пичку»), and the mother
  word had no severity-3 row at all (`jebem ti`/`materina` were severity-2 heavy
  insults). The pick family now carries `picku/picko/pickom/pickama/pickami/
  picketina/pickiste`, and `S0c3` enumerates the mother-curse phrases
  (`idi u picku mater`, `u picku materinu`, `jebem ti majku`, `majcinu ti`,
  `idi u materinu`, …). When a row is a NOUN FAMILY, add the case ladder; when it
  is a CURSE IDIOM, enumerate the phrases — a single short phrase is too easy to
  embed, so `S0c3` is `boundary: true` against exactly that (unbounded «u mater»
  fired inside «U MATERIJALU E OPISANO»).
- SEVERITY DOES NOT CHANGE THE OUTCOME (every offence is a strike, one rung at a
  time), so a missing row is not cosmetic — it is a curse answered as business
  copy. The e2e pin lives in `tests/stuck.test.ts` (the insult-protocol block):
  a curse mid-funnel must leave `state` untouched and serve the rebuff.

## 4b. Property identity: the mention binder and "last shown"

A client names a property by ANYTHING (type noun, price, m², landmark, EB) —
never only by EB. Three rules, all pinned in `tests/mention-resolve.test.ts`
(the [23:09] capture: EB 70 ДВОСОБЕН + EB 76 Гарсоњера, "GARSONJERAVA KAJ SE
NAOGJA TOCNO?" answered with the OTHER property's landmark):

1. THE FEED'S `studio` FLAG IS AUTHORITATIVE for the Гарсоњера type
   (`isStudio`): `mentions.bedrooms === 1` is only the LEGACY fallback for rows
   imported before the flag. A STUDIO carries NO room count, so scoring the
   type noun on the bedrooms guess marked the real гapсоњера negative and
   left the mention unbound.
2. THE TYPE ADJECTIVE IS INFLECTED: `двособен → двособниот/двособна`, so the
   room-count match is `соб` + inflections, not the bare nominative `собен`.
   Without it "KADE E DVOSOBNIOT STAN ?" yielded no signal at all.
3. "THE LAST SHOWN" MEANS THE LAST PRESENTED — `presentedIds[last]`, never the
   tail of a feed-ordered filter. The WHERE_IS lane built `shown` by filtering
   the feed, so its fallback could be a card from the TOP of the batch.
   Every other site in `inbound.ts` already read `presentedIds[last]`.

## 4c. Discovery: a released criterion is an ANSWER, never a blank

`buildDiscoveryAsk` only asks for what is still missing — so when the client
RELEASES a criterion, the answer must land in a slot or the funnel asks the
SAME question again (the [23:47]/[23:48] capture: "во кој дел од градот?" →
"NEBITNO KADE" → "дали веќе имате избрано одредена населба?" → "BILO KOJA").

- `slots.anywhere` = `detectAnywhere` — BUILT from `grammar.ts`
  (`buildAnywhereSlots` + `buildAnywhereBareSlots`), never enumerated at the
  call site: the adverb slot (`било каде/кај/где`, `каде и да е`, `секаде`,
  `во секој дел`, `по цел град`, `anywhere`), the quantifier slot
  (`во/по/низ` + `секој/секоја/секое/цел/целиот/целата` + place noun), the
  wh+`било` slot in either order (`било која`, `која било`, `која и да е`),
  and the predicate slot (`не ми е битно/важно/гајле`, `нема врска`, `сеедно`,
  `се е еднакво`, `свеедно`, `не сум ограничен`, `без ограничување/преференца`)
  with an optional governing preposition. The noun-elided ANSWER shapes
  (`NEBITNO`, `BILO KOJA`, `SEEDNO`) are the BARE builder. Latin is normalised,
  but a spelling it cannot map must still fire — test both raw and normalised.
- Inflect the stems: `or()` boundary-guards every alternative, so a bare stem
  (`политик`) never matches `политика`. Build slots as `stem + \p{L}*`
  (`buildFeePracticeDislikeSlots` does), or enumerate the inflected forms.
- The guard is the criterion the dismissal NAMES: `небитно колку соби` is the
  size waive, `bilo koja cena` releases the price, `bilo koja kukja` / `bilo
  koj stan` release the TYPE. None of them says the area is free; marking them
  `anywhere` silently skips the location ask.
- With `anywhere` true the location AND bedrooms questions are skipped and the
  presentation is city-wide, ordered from the most popular neighbourhoods.

## 4c-bis. A banked answer may never borrow a term

The learned bank stores sentences, and `retrieveDynamic()` is a fuzzy,
STATE-AGNOSTIC match — so a stored sentence has to be true for ANY client. A
calendar entry never is. The [01:51] capture: «KOMPLICIRANI STE» during term
negotiation was answered by generated prose promising the owner would be asked
about «четврток во 17:00», the row was banked, and any later complaint scoring
0.55 against that phrasing could be told about someone else's Thursday.

- `pinsBorrowedCommitment(answer, userMsg)` in `src/llm/dynamicFallback.ts` is
  the ONE reader: a day (`понеделник…недела`, `денес`, `утре`, Latin + inflected)
  or a clock (`17:00`, `10.11`, `во 6`, `околу 17 часот`) in the answer is a
  violation UNLESS the client's own message names it. Comparison is canonical:
  the day maps to mon…sun, the hour to a bucket where `6` ≡ `18:00` (a client
  writing «во 6» means the afternoon). Durations, units and floors are not
  appointments (`во 5 минути`, `на 5 кат`, `за 3 дена`).
- It runs at generation, on recall AND in the nightly row audit — so a row
  stored before the rule stops serving instead of being purged by hand.
- The live half is closed too: `Responder.escalate()` refuses prose that pins a
  borrowed term while `inProtocolState(session)`, and the escalation door now
  asks `dynamicAllowedHere()` — the visit/fee/contact ladder is answered by its
  own copy, never by a paraphrase (a paraphrase is exactly how the term was
  invented). Echoing a time the CLIENT named stays legal.
- Pinned in `tests/dynamic-borrowed-time.test.ts` (including the e2e that a
  `visit_scheduling` turn can never serve the promised term).

## 4d. One gate for the advice lanes — deny by default

Every pre-classifier lane that answers with ADVICE PROSE (off-topic, defer,
negotiate, comparison, feature, neighbourhood, documents, mortgage) was, one
capture at a time, found claiming a SEARCH. Those vetoes used to be eight
separate copies inside the detectors, so a lane added tomorrow inherited
nothing and re-opened the hole (the [22:34] class, then [01:48]).

The policy is now ONE table — `ADVICE_GATES` + `adviceLaneAdmits(intent, text)`
in `src/llm/deterministic.ts` — consulted in BOTH places a lane can fire:

- `dispatchSimple` applies it BEFORE the detector runs, so a lane added to
  `SIMPLE_DETECTORS` with no row and no veto of its own is still kept off a
  search turn;
- each detector calls it itself, so the `inbound.ts` fast paths, the
  `ROUTING_ORDER` mirror and `isGenuineQuestion` see the same policy.

Members are shared predicates, never lanes' private checks:
`needsAskShape` (`hasAskShape`), `standsDownOnSpecs: 'always' | 'unlessAsk'`
(`carriesSearchSpecs` → `extractSlots`, the funnel's own parser),
`standsDownOnStockSearch` (`isStockSearch`), `standsDownOnRecommendAsk`
(`detectRecommendAsk`), `standsDownOnInventoryAsk` (`detectInventoryAsk`).

- **DEFAULT IS DENY.** An intent with no row is treated as an advice lane.
- A lane that legitimately OWNS spec-bearing turns declares `exempt` **and says
  why** (`PROVISION_ASK`, `PROVISION_WHO`, `FEE_WHY`, `ESCALATION`,
  `WORKDAYS_QUESTION`, `SCHEDULING_FLEX`). An exemption is a decision a reviewer
  can argue with, never an absence of code — the money and hours protocols name
  amounts by design (see §2).
- Lane grammar that is about THAT lane stays in the lane (`BANK_PLACE_RE` — a
  bank is also a place; `DOCUMENTS_NEGATED_RE` — a negated paperwork mention;
  `DISCUSSED_PROPERTY_RE` — a question about the flat on the table). Moving
  those into the table would hide lane meaning in a policy flag.
- Pins: `tests/advice-lanes-search-answers.test.ts` proves the inheritance with
  a fake lane pushed into `SIMPLE_DETECTORS` (it must NOT answer a search) and
  a row for every real one; `tests/place-inventory-ask.test.ts` pins the
  inventory family.

THE INVENTORY ASK CARRIES A QUALIFIER ([01:36], the RENT sibling): «STO IMATE
POVOLNO VO TOJ REON?» missed the family because the grammar demanded the
preposition immediately after the have-verb, so the AREA-ADVICE lane claimed the
turn on the word «реон» and answered a rent search with a philosophy paragraph.
`INVENTORY_ASK_RE` and `INVENTORY_VERB_RE` share one qualifier gap (`INV_GAP`,
no clause punctuation, ≤20 chars); the place reference after the preposition is
still required, so the shape stays a have-ask about a place.
THE PROXIMITY OPENER IS TYPED BY HUMANS: «OKOU BUNJAKOVEC» («околу» with the л
dropped) must name the place, or the funnel asks for a location the client just
gave and the next turn («во тој реон») has no referent. The dirty spellings live
in ONE Cyrillic-canonical family (`PROXIMITY_OPENER_SRC`) and every reader of
the wish uses it — including the whole-word veto that runs BEFORE the extractor
(`окоу` is what normalizeMc folds «OKOU» to); a word list that knows only
«околу» kills the message before any regex sees it. Latin forms are NOT listed
in the extractor: the raw pass runs first and would return «KAPITOL BISER»
where every caller expects the folded tail.
THE INVENTORY ASK IS A SEARCH ([01:48]): «ШТО ИМАТЕ ВО ТОЈ РЕОН?» after «SAKAM
DA KUPAM STAN VO BLIZINA NA ZELEZNICKA» asks WHAT IS AVAILABLE there — the
show-me family, never an essay about neighbourhood character.
`detectInventoryAsk` (what-word × have-verb × a demonstrative place reference or
a feed area) feeds `detectSeeOffers`, and both AREA-ADVICE and OFFTOPIC stand
down on it.

A TYPED ANSWER TO A REMEMBERED INVENTORY ASK IS A SERVE ([02:16]): «ШТО ИМАТЕ
ВО БУЊАКОВЕЦ?» remembers the place (`slots.inventoryPending`), and the next
message — «SAKAM DA IZNAJMAM STAN VO BUNJAKOVEC» — has service + TYPE + the
place, which is enough to present a pair ranked from it and ask THAT type's
characteristics (спални + цена for стан/куќа, м² + цена for деловен простор/плац).
Two traps, both fixed and pinned in `tests/inventory-type-ask.test.ts`:
- the event is `INTENT_DECLARED`, so the turn never entered the presentation
  composition branch — it fell through to the LLM-less fallback, which served
  cards with NO anchor, NO distance and NO question. The branch now also admits
  the `seeOffers` lane; ANY future lane that sets `next = 'presentation'` must
  check it reaches a composition site, not the fallback.
- the protocol ask beside the cards is `buildDiscoveryAsk(session.slots)` — the
  shared type-aware builder — never a hard-coded «колку спални + цена на станот»
  pair, which asked a ДУЌАН for bedrooms.

AN UNKNOWN TYPE IS NEVER NAMED (the [04:17] capture): «ZDRAVO. STO IMATE VO
BUNJAKOVEC?» names a PLACE and nothing else, and the service ask defaulted to
the `.stan` bank batch — «Дали станот го барате за да го купите или сакате да го
земете под закуп?» asked about an apartment the client never mentioned.

THE TYPE IS KNOWN TWO WAYS, and the flat is a real category (it just has no
flag of its own):

- a POSITIVE category flag — `house` (a `yard` wish implies one), `business`,
  `plac`;
- FLAT EVIDENCE — `flat` (the handler records `detectFlat(text)`: стан/станот/
  станови/апартман/гарсоњера, with a TRAILING boundary so «станбена површина»
  is not a flat), `garsonjera`, `house === false`, or any bedroom count (only a
  residential unit has спални).

`slots.flat` is reconciled ONCE per turn in `inbound.ts` (after `applySlots`,
before the FSM block): a positive category on file retires it, otherwise the
message's own flat word sets it. Without that slot «MI TREBA STAN» and «STO
IMATE VO BUNJAKOVEC?» were the same message, so the same apartment wording
served both the right case and the guess.

WHAT AN UNKNOWN TYPE DOES NOW:

- the MARKET ask is the type-neutral one (`discovery.ask.service.any`: «Дали Ве
  интересира купување на недвижност или претпочитате изнајмување?»), whose
  variants are validated to name no property type — a flat is not a safe default
  either, the client may want a shop or a plot;
- the LOCATION ask is neutral too (`discovery.ask.location.any`);
- THE STOCK-AT-A-PLACE ASK OWES THE TYPE (`slots.inventoryPending`, the [02:15]
  family): «Кој тип недвижност Ве интересира — стан, куќа, деловен простор или
  плац?» (`both.ask.type`), with the type-specific pair HELD BACK — «колку
  спални» is a question a дуќан never has, and a price cap is worded per
  category;
- ANY OTHER FUNNEL KEEPS ITS RESIDENTIAL SEQUENCE unchanged. An area + budget
  search is already inside it, and a type question there re-asks what the client
  does not treat as missing — the [13:44] capture answered «EDNA» to a type
  question and the funnel re-asked (the loop class).

Pins: `tests/respond.test.ts` (the builder: neutral market/location, the type
ask only on `inventoryPending`, no collateral on house/flat), and
`tests/landmark-intake-discovery.test.ts` (the exact capture end to end: market →
type → flat, plus the anchor path unchanged). Bank keys are added to BOTH
`src/data/responses.ts` and the generator spec (`src/scripts/generateResponses.ts`)
with a ban list, so a regeneration cannot reintroduce a type word.

NOT EVERY EDGE INTO `presentation` IS A REFINEMENT. The FSM also lands there on
`presentation.STAY`, `presentation.REJECTED`, `property_query.REJECTED`,
`closing.REJECTED` — no `DETAILS_PROVIDED`/`SEARCH_REQUESTED` event, so the
composition branch is skipped and the turn falls to `Responder`. With a brain up
that is the LLM's turn; with every brain DOWN the code-built fallback served the
batch with no place, no distance and no question (the audit probe's
`HMMM INTERESNO` after an anchored serve). The fallback is now a composition
site in its own right: the handler wires `setPlaceResolver` (its own
`landmarks.findPlace`) into the responder ONCE in the constructor, the fallback
passes that pin to `buildPropertyCards` (so every card states its measured
distance) and appends `missingCriteriaAsk(session.slots)`. Pins:
`tests/presentation-fallback-anchored.test.ts`. When you add a lane that sets
`next = 'presentation'`, ask TWO questions: does a composition branch take it,
and does the fallback still name the place if every brain is down?

A PLACE NAMED IN A SEARCH MUST SURVIVE TO `slots.poiAnchor` ON *EVERY* PATH.
The [01:48] capture lost «VO BLIZINA NA ZELEZNICKA» because the DETERMINISTIC
classify path built its own event and dropped the wish the LLM path carried —
the resolver was already right, the anchor simply never got there. When a
place-shaped fix is made, check both classify paths (`classify.ts` deterministic
core + the LLM-down recompute), not just `resolvePlace`.

LATIN ARMS GO ON THE RAW TEXT: `normalizeMc` is PHONETIC («STO IMAS» → «сто
имас», s→с not ш), so a grammar matched only on the fold is blind to Latin
typing. Match the raw text first, then the fold — the same reason
`SEE_OFFERS_RE` carries its own Latin arms.

## 4h. THE OWNER IS A PARTY, NOT A CONFIRMATION BUTTON (the [20:16]–[20:33] batch)

The visit ping-pong ran four defects in one session; each is now a rule:

- **ONE missing-fact line per turn, IN ROTATION.** `INFO_NO_DATA_LINES` holds the
  two ways of saying the same thing and `noDataLine()` advances one per miss.
  The old constant glued them («Немам информација во системот; немам податок во
  базата — …»), which reads like two admissions in one breath. Never concatenate
  variants of one theme; rotate them.
- **«ISTO VREME» REUSES THE CLOCK, IT DOES NOT ASK AGAIN.** «CETVRTOK ISTO VREME
  MOZE ?» names the DAY and reuses the HOUR in play. `detectSameTimeReference` +
  `mergeVisitTerm` (visits/time.ts) are the ONE merge for every reader
  (visit_scheduling, time_confirm, both owner_checking legs); the donor chain is
  `ownerCounterTime → ownerTime → visitTime`, so the client only ever moves one
  field and the owner's ping carries both.
- **A DAY-ONLY SLOT + A BARE HOUR IS A COMPLETE TERM.** The exact-hour ask leaves
  «Четврток» in `slots.visitTime`; the client's «6» must reach the owner as
  «Четврток, 05.11.2026 во 18:00», never as a day with no clock. `applySlots`
  owns the raw day-first concatenation — do not canonicalize it in the
  classifier (that destroyed «VO PONEDENIK MOZAM POPLADNE» + «OKOLU 6»).
- **THE OWNER TYPES IN A WINDOW, LIKE THE CLIENT.** The plain-text owner channel
  arms `ownerTyping` (`ownerTypingDelayMs`): a follow-up inside the window
  REPLACES the verdict and resets the timer, and Lina relays the final word
  ONCE. Applying the first sentence instantly relayed half a thought and left
  the next one dead.
- **THE OWNER'S CHANNEL STAYS LIVE WHILE THE TERM IS UNSETTLED.** After the
  first verdict the check is consumed; `InboundHandler.ownerFollowup` re-opens
  it (owner_checking / time_confirm → `applyOwnerVerdict`) so a correction
  reaches the client instead of «нема активна проверка за овој клиент».
  Outside those states it returns false and the console says so.
  Pins: `tests/owner-window-same-time.test.ts`.
- **THE OWNER'S DAY SURVIVES HIS NEXT SENTENCE (the [10:24] capture).** An owner
  answers a clock re-ask in TWO messages — «PETOK», then «OKOLU 5 MOZAM» — so the
  second verdict is a DAY-LESS clock. It used to be dated to TODAY by the display
  normalizer and relayed as «Има друг предлог: Вторник, 03.11.2026 во 17:00» (a
  weekday and a date he never said), while the RAW «Околу 5» was written to
  `slots.ownerTime` / `ownerCounterTime` — the term the client accepts AND the
  term the next owner ping calls "refused" (the [17:45] class, made permanent).
  One rule: `mergeOwnerTerm` (prompts.ts) donates the most specific day on the
  table — the owner's own last named day (`slots.ownerClockDay`), then the day of
  the term he is answering (`ownerAskTime`), then `visitTime` — and the handler
  STORES the canonical dated term. `normalizeOwnerTime` itself never dates an
  undated phrase. Only when NEITHER party named a day does the clock keep its
  next occurrence (`dateOwnerClock`, the [13:16/13:20] contract: his hour must
  still reach the client, not trigger a second question) — today is never used
  against a day somebody named. The TUI mirrors the ACTUAL relay text through
  `onOwnerRelay`, so the operator pane can no longer echo a term the client did
  not receive. Pins: `tests/owner-day-carry.test.ts`.
- **THE DAY IS SETTLED AT EVERY SEAM, NOT ONLY AT THE STORE (the data/tui.db
  day audit).** Replaying the captured sessions showed the same class in the
  paths the first fix did not own: `appointments.time` = «Во 17:00»,
  `visit_confirmed` / `agent_assigned` payloads = «Во 17:00», and the
  `time_confirm` task prompt relaying `slots.ownerTime` verbatim — a visit no
  human could date. `confirmVisit` now computes TWO forms from ONE merge
  (`mergeOwnerTerm(slot, [ownerClockDay, ownerAskTime, visitTime])`):
  `recordTime` — the slot in its own shape ([20:31] stores «UTRE POPLADNE OKOLU
  16» verbatim; the scheduler parses it against its own clock) with a missing
  day donated — goes to the appointment row, `markFinalized` and
  `visits.arrange`; `displayTime` (`normalizeOwnerTime(recordTime)`) — named day
  + date + 24h — goes to the client confirmation and both owner event
  payloads. `stateTask('time_confirm')` merges at read time for slots stored
  before the merge existed. Date the READER, never rewrite the slot, and never
  bake a date into the record: a term that already names its day passes through
  untouched. When adding a relay, ask: does this string name a DAY, or only an
  hour?
- **A GREETING FROM THE OWNER IS GREETED BACK, NOT CALLED «НЕ РАЗБРАВ» (the
  [23:40] capture).** He opened the chat with «ZDRAVO» and heard «Не разбрав.
  Евидентен број 54 — дали недвижноста е достапен…». A courtesy is not an
  unintelligible answer: the same seam (`ownerQuestionReply`) now answers it
  with «Здраво!» + the pending ask, and the client still hears nothing. The
  greeting arm must run BEFORE the verdict guard — «DOBRO VECER» carries
  «вечер», which the owner parser reads as a vague clock, so the guard ate the
  greeting. A greeting whitelist is a WHOLE-DAY list: the evening forms
  («добро вечер», «добро попладне», «добро ноќ», `dobro vece[r]`) are part of it,
  or the same defect returns after 18:00.
- **A CLAUSE IS NEVER A NAME — and a question is answered even while the
  contact is being collected (the [02:31] regression, found by a whole-suite
  run that a single-file run did not reproduce).** After the visit agreement
  the chat sits in `contact_collection`; the client wrote «ako nema lift» and
  `detectContact` mined the first two words as the person «Ako Nema», stored
  it, and asked for a phone — the appointment carried a name nobody has and
  the client's question died. Two rules: `detectContact` refuses a sentence
  (a `?`, a conditional/question word, a wanting/availability verb, a
  property/feature noun, or more than three content words), while the phone it
  carries still counts; and a FEATURE ask in `contact_collection` is ANSWERED
  (`FEATURE_OWNER_CHECK`) with the pending contact ask appended, so the turn
  ends on the question the funnel still needs. Pins:
  `tests/deterministic.test.ts` (the detector) and `tests/fee-serve-routing.ts`
  («ako nema lift» after the visit agreement).
- **A FEMININE SUBJECT TAKES A FEMININE ADJECTIVE — and the sentence's subject
  DECIDES it.** `buildOwnerAskAgain` names «недвижноста» whenever no
  `propertyTypeDef` is passed (which is every TUI re-ask), yet defaulted to the
  masculine «достапен»: «дали недвижноста е достапен». The gender comes from the
  branch that builds the subject, never from a default: the feminine is the
  fallback, and a caller that brings its own definite noun («станот», «плацот»)
  brings its own adjective.
- **A QUESTION FROM THE OWNER IS ANSWERED, NEVER PARSED (the [09:57]/[10:02]
  capture).** A stranger being asked for a viewing checks the request first:
  «TOA E DENES TAKA ?», «DALI PRASUVATE ZA DENES ?». Without a guard the day
  word inside them parsed as a COUNTER («Денес») and one was RELAYED to the
  client as a refusal plus a fictitious alternative the owner never gave — a
  fabricated term is the worst output this channel can produce. Rule: in
  `owner_checking`/`time_confirm`, when the text is a QUESTION (`isOwnerQuestion`)
  and carries no proposal (`detectOwnerVerdict` returns undefined for it), the
  OWNER gets an answer built from the session — the term actually asked for
  (dated, and a «is that today?» answered by FACT, never by echoing his word),
  the flat, and the client's own ask again — and the CLIENT hears NOTHING until
  the owner gives a term or declines. A proposing question («MOZE VO SABOTA ?»)
  is still a verdict. Pins: `tests/owner-relay.test.ts` (the [09:57] test).
- **THE AVAILABILITY HALF IS NOT THE TERM HALF (the [23:41] capture).** The
  owner ask is COMPOUND — «дали е достапна… и дали го прифаќате терминот за
  посета?» — and «DOSTAPNA E DA» answers only the first half. Parsed as a full
  «ok» it closed the deal: the client got «Договорена посета … Вторник,
  10.11.2026 во 17:30», the Turn-0 address confirmation went to the owner, and
  the owner had never agreed to that term. Rules:
  - `isOwnerAvailabilityOnly` (an availability STEM — достап/dostap, слобод/
    slobod — plus no term acceptance, no clock, no day, no day-part) is NOT a
    verdict: `detectOwnerVerdict` returns undefined for it. The bare «да» in
    «DOSTAPNA E DA» echoes the availability yes/no; it is not consent to the
    term.
  - The owner is ANSWERED by the same seam (`ownerQuestionReply` →
    `buildOwnerAvailabilityAck`) — a POOL, not one sentence:
    `owner.availability.ack.term` (a term is on the table: confirm the
    availability, ask whether it suits, invite another proposal) and
    `owner.availability.ack.noterm` (nobody named one: ask which term). Seeds
    are HAND-WRITTEN in `FIXED_SEEDS` (`{prop}` = the flat, `{term}` = the
    RENDERED term), and both keys carry a `POOL_CONTRACTS` entry, so a learned
    or reworded variant can never drop the availability or the open question
    and re-open this bug. The code-built sentence is only the empty-bank
    fallback. The pending check stays open; nothing reaches the client, no
    agent is assigned, no appointment is finalized. THE CHAT WITH THE OWNER IS
    NOT FINISHED UNTIL A TIME AND DATE ARE DEFINED.
  - THE OWNER PANE HAS ITS OWN REPEAT MEMORY (`InboundHandler.ownerRecent`,
    bounded, per chat). Every OWNER-facing pool — `owner.ask`,
    `vague.time.owner`, `owner.availability.ack.*` — draws `recent` from it.
    `assistantTexts(session)` is the CLIENT's history: filling an owner pool
    from it suppressed variants the owner never read and repeated ones he did.
    The owner is one human re-reading the same pane at every viewing, so a
    fixed sentence is a script; four availability answers in a row use four
    different variants (`tests/owner-relay.test.ts`, the rotation test).
  - `npm run bank:audit-seeds` sweeps BOTH seed layers now (generated
    `RESPONSE_BANK` and hand-written `FIXED_SEEDS`) for the P1 contracts and
    the P5 offensive false positives — frozen policy copy served by
    `pickVariant` was previously outside the audit.
  - CONSENT MUST NAME ITS OBJECT (the [23:41] rule, at the VERDICT level). `ok`
    means "agrees to the term on the table"; there is no room for a bare `ok`.
    `applyOwnerVerdict` no longer falls back to `session.slots.visitTime` (the
    CLIENT's proposal) when the verdict carries no term — an ambiguous `ok`
    takes the AVAILABILITY lane (ack + term question, nothing booked). A
    producer that means "yes to 17:30" says 17:30: the TUI shortcut
    `/owner <eb> ok` stamps the pending term (`DeferredOwnerAgent.simulate`),
    and the API accepts `confirm_time` and refuses (409) a term that is not the
    one asked. One apply per verdict object (`appliedVerdicts`, identity keyed)
    so a transport that resolves the check AND asks for the reply text cannot
    answer the same half-answer twice.
  - THE OWNER CHANNEL IS TRANSPORT, NOT A SECOND BRAIN
    (`POST /hermes/v1/owners/:chatId/reply`). A channel that holds the owner's
    conversation relays his RAW message; Lina answers through the same seam as
    the operator pane (`ownerMessage` → `detectOwnerVerdict` /
    `ownerQuestionReply`) and returns `reply_text` to deliver. No parser and no
    copywriter on the other machine: two grammars diverge invisibly, and a
    second copywriter stops the owner pool from rotating. `message_id` makes
    the seam idempotent (`meta`-backed), so a retried webhook answers with the
    SAME sentence instead of taking a second turn.
  - `GET /hermes/v1/work` carries `deliver_text` (Lina's already-composed ask)
    plus the owner's name/phone; `deliver_text: null` means the check was
    re-armed AFTER the owner spoke, so there is nothing to send.
    `owner_check_requested` means WAITING — it is settled when the check is
    answered or superseded, so the queue never lists closed checks or answered
    local checks. A verdict with no pending check is a 409 and writes NO
    `owner_check_result` event (a stray event used to sit in the bus forever).
  - A NEGATED availability («NE E DOSTAPNA», «не е слободна») is a REFUSAL and
    can never set `agree` — the agreement family matches the bare predicate
    inside the negation, so it used to LOCK the visit on the exact opposite
    answer. It parses as a bare counter (the client is asked for another term).
  - The `ok` branch refuses to confirm with NO term on the table at all (an
    empty `ownerTime` + no `visitTime`): it asks HIM for the term instead of
    sending a «Договорена посета …» with a blank term.
  - A QUESTION is still a question («DALI E SLOBODNA ?» keeps the [09:57]
    lane) — the availability ack is for a STATEMENT only.
  Pins: `tests/owner-relay.test.ts` (the [23:41] and [09:57 sibling] tests),
  `tests/hermesApi.test.ts` (the transport seam, idempotency, `confirm_time`).

## 4i. THE SERVICE QUESTION PRESUMES NO PROPERTY TYPE (the [21:20] capture)

«ZDRAVO , STO IMATE INTERESNO OKOLU KAPITOL MOL ?» was answered «Дали барате
СТАН за купување или за изнајмување?» — the client named a PLACE, never a flat.
The bank copy was already clean ("…купување или изнајмување на недвижност?");
the leak is the GENERATED path (badge `dynamic`), where an LLM writes the
sentence. **Prompt wording is not a guard** — this is why the same class keeps
returning: every brain that improvises re-opens it.

- **A POST-CONDITION, not a prompt sentence.** `validateDynamicAnswer` now
  takes `{ typeKnown }` and REJECTS any candidate that asks the service
  question (купување/изнајмување, either order, both scripts) while naming a
  property type — the turn degrades to the clean deterministic line. The same
  check runs on RECALL (`recallDynamic`, the exact-recall lane in `inbound.ts`),
  so rows stored before the rule existed can never serve.
- **THE CLIENT OWNS THE TYPE.** `typeEstablished(slots, userMsg)` is true only
  when `applySlots` set one (`flat/house/business/plac/garsonjera/yard`) or the
  client's own message names it — then «станот» is legitimate and the answer
  passes untouched.
- **WHOLE WORDS.** `PROPERTY_TYPE_NOUN_RE` is boundary-guarded both ways: a
  place word is not a type, and «стандард», «станбена површина», «станар» are
  not types. Latin forms (`stan/stanot/stance/kukj/lokal/plac`) count — the
  field typing is Latin (`MI TREBA STANCE KAJ KAPITOL MOL`).
- **THE CATEGORY QUESTION IS NOT THIS.** «барате стан, куќа, деловен простор
  или плац?» enumerates every type and is sanctioned (§4); only a SERVICE ask
  that singles out one type is the defect. The service is asked first, the
  category after it.
- **AND NO OTHER INVENTED FACT.** The same post-condition refuses the rest of
  the property data: rooms (`двособен`, «со две спални»), area (квадрати),
  year of build and the floor — row facts exactly like the price. The honest
  miss («немам податок … ќе го прашам сопственикот») is the only shape a
  generated answer may use for a datum it does not own.
- **SWEEPING STORED ROWS.** `dynamicRowViolations(row)` is the single predicate
  over a stored `bank_dynamic` row (its `msg` is the client turn, so a type
  presumption is judged against the question that produced it). Recall refuses
  bad rows anyway, but the nightly digest would fold them into `bank_variants`
  first — so `npm run bank:audit-dynamic` reports them and
  `npm run bank:audit-dynamic -- --apply` deletes them.
  Pins: `tests/dynamic-fallback.test.ts` ([21:20]).

## 4g. ONE FLAT IS A RATE, NOT A MARKET BAND (the EB reader)

The [20:11] capture: «KOLKU DOAGJA CENA PO KVADRAT ZA 53?» asked EB 53's own
rate and was answered with Аеродром's €/m² band. The band lane already carried
the right guard — «a named property owns its lane» — but the reader behind it
(`inferPropertyId`) vetoed the WHOLE MESSAGE as soon as a unit word appeared:
`…|м2|м²|kvadrat|евра|спални|(?:до|околу|под)\s*\d{2,3}\b…`. The very word
«kvadrat» that ASKS for the rate destroyed the number that names the flat.

- **`src/llm/ebNumber.ts` is the ONE reader** (`ebNumbersInText` /
  `firstEbNumber`): a number with a UNIT after it, behind a CAP/comparison word,
  or inside a thousands figure is a criterion; a free number is a listing. The
  judgement is LOCAL to the number, so «STAN 53, 50 M2, DO 90000 EVRA» names 53.
  `inferPropertyId`, `collectMentionedEbs` and the market-band veto all consult
  it — a second copy of this grammar is what produced the bug.
- **THE FOLD IS MANDATORY HERE, not a second chance.** This reader answers with
  a NUMBER, so «raw first, fold else» keeps the raw form's false positive:
  «12 SPALNI» read as EB 12 because the Latin unit word missed the
  Cyrillic-canonical unit list. Normalize once; the digits pass through.
- **A NAMED FLAT IS NEVER A MARKET LEVEL.** `detectMarketPriceAsk` returns false
  when the message names a flat, so the mirror (router) and the executor agree —
  the band lane owns the CATEGORY («ceni po kvadrat za stanovi», «kako se
  dvizat cenite vo Аеродром»), the info lane owns one flat's price ÷ м².
  Pins: `tests/eb-number.test.ts`, `tests/market-price.test.ts` ([20:11] e2e).
- **SWEEP THE GUARD FAMILY, NOT THE SENTENCE.** Any lane that guards on
  «a named property» (`inferPropertyId(...) === undefined`) inherits this reader;
  when it changes, rerun the classify/route-corpus suites, not just the lane.

## 4e. A CLOCK IS NEVER A PLACE (the visit ping-pong)

The [00:59] capture: the owner countered «Петок 18:00», the client answered
«DALI KE MOZE PORANO MALCE . NAKAJ 5 ?» (an hour earlier — around 5), and Lina
served the property's landmark + a maps pin. Two rules keep that from returning:

- **«накај/nakaj N» IS A CLOCK on BOTH sides.** The owner parser has read
  «NAKAJ 4» since [17:45]; the client detector did not, so the turn carried no
  time, the slot stayed empty and the owner was never asked. The prefix lives in
  `visits/time.CLOCK_RE`, `hasClockHint` and `detectVisitTime`'s `VISIT_TIME_RE`
  — one family, three readers, never re-declared. A digit after «накај» is never
  a place: `detectSurroundingsAsk` stands down on it (and on any earlier/later
  word carrying an hour), because «накај» is also a SIDE trigger.
- **The client's counter keeps the OWNER'S DAY.** `counterMergedTerm` in
  `llm/classify.ts` is the ONE merge for `time_confirm` and both
  `owner_checking` legs: a bare clock (or an hour adjustment) takes the day from
  `slots.ownerTime` first, then from a day-only stored slot — a stored CLOCK
  never resurrects. The owner is re-asked with the client's hour, and the
  follow-up names his refused term (that is why 18:00 must appear in the ask).

## 4f. ROOMS ARE NOT BEDROOMS, AND A RECALL IS NOT A SEARCH

The [09:07–09:11] capture ran three defects in a row, each one a WRONG SUBJECT:

- **THE FEED'S ROOM COUNT IS NOT A BEDROOM COUNT.** `tip_na_sobi` carries ROOMS
  (еднособен / двособен / трисобен = дневна + спални) — the same convention
  `slots.bedrooms` uses («две спални» → 3). Copy that quotes it as bedrooms is
  off by one: EB 66, a трисобен with две спални, answered «Има 3 спални соби.»
  (`infoAnswer.bedroomPhrase` now speaks `rooms − 1`, and a гарсоњера / еднособен
  is named as having no separate bedroom). Every site that speaks the count does
  this — the inventory labels did it right all along, which is how the info lane
  stood out.
- **A SIZE-ONLY RECALL IS A DESCRIPTION, NOT A NEW SEARCH.** «IMAVTE EDEN STAN
  KAJ СЈО SO DVE SPALNI?» names a LANDMARK + size and no price. The seen-listing
  lane demanded a remembered price, so the shape fell to the locate funnel —
  which, with his SEARCH budget (120.000) below the flat he meant (145.000), had
  nothing to serve and answered an owner-consult line plus a criteria ask. The
  lane now owns `landmark + size` as well as `area/landmark + remembered price`:
  rows with THAT room count at THAT place, nearest first WITHIN the size tier
  (`roomTier`), the session's own service instead of re-asking buy-or-rent, and
  `buildAboveBudgetNote` when the rows cost more than the search cap — hidden
  behind the budget it claims the flat does not exist, silently served it
  claims it fits. A self-describing recall also owns the turn when cards are
  already on the table: he is naming a DIFFERENT listing.
  THE SIZE LEG REQUIRES THE LANDMARK, NOT JUST A NEIGHBOURHOOD: «со две
  спални во Маџар маало, за купување» with no money is a SEARCH awaiting its
  price — the [madjari] money-anchor gate asks for it and serves nothing
  (`tests/locate-money-anchor.test.ts`). Кај/до/близу + a map row is one-place
  reading; a bare area keeps the funnel.
- **THE FLAT UNDER DISCUSSION OWNS ITS OWN NUMBERS.** «66 DALI E DOSTAPEN USTE?»
  pins 66; the next turn's distance question named no EB, so the DISTANCE_BATCH
  arm answered with the two cards of the OLD batch and stamped the nearest of
  THEM onto the slots — the client had to say «TE PRASAV ZA 66» twice. The batch
  is the subject only while nothing else is: no flat under discussion, or the
  discussed one IS in the batch (the two-card comparison the arm exists for).
  A single-flat distance that has more than one card behind it NAMES the flat
  («…со Евидентен број 66»); one card needs no number.

## 4i. A PLACE'S CLASS IS NOT ITS NAME — but the row must carry it (the [01:05] KAPITOL MOL batch)

«ZDRAVO. MI TREBA STANCE KAJ KAPITOL MOL» produced «На кој дел од градот …?» —
about a mall the map holds THREE times («ТЦ Капитол», «Трговски центар
Капитол», «Shopping Center Capitol Mall»). `data/place-misses-2026-11-03.jsonl`
records the exact death: `{"text":"капитол мол","refused":"Kupi Moment
Capitol Mall"}`. Three layers, all fixed in `src/handlers/inbound.ts`:

- **THE CLASS TAIL** (`PLACE_CLASS_FAMILIES` + `placeClassFamily`): the noun a
  client TACKS ONTO a name (мол/mall, маркет, хотел, болница, училиште, црква,
  парк, кафе, аптека, банка, станица) is a class word, and the map rarely
  stores it («ТЦ» / «трговски центар» / «Mall» are one class, three spellings).
  It may be dropped from the CLIENT'S run ONLY when the map row DECLARES the
  same class — one of its own words is in the family, OR the row's OSM `type`
  is (a mall filed as «Олимпико» with no class word in its name still declares
  `mall`). That is what keeps the old refusals: «ВОЕНА БОЛНИЦА» still never
  reaches «Воена академија …» (no hospital word, a `School` type) and «ВЕРО
  ЦЕНТАР» never reaches the shop «Веро 9» (a `Supermarket` declares the market
  family, not the mall). A blanket drop of institution nouns is how that
  refusal was born in the first place — do not reintroduce it.
  THE TYPE IS WIRED END TO END: `OfflineMapStore.findPoiByName` /
  `findPoisByName` / `findPoiByNameLoose` return the row's `type`,
  `LandmarkService.findPlace` / `findPlaceLoose` pass it through, and
  `poiNameCoversClientWords(client, name, type)` reads it. Do not drop the
  column again on the way out — a name-only guard silently loses the class for
  every brand-only row.
- **THE LEADING CLASS RUN** (`leadingVenueRun`): the head test already skips
  the map's leading venue words (the identity of «Shopping Center Bunjakovec»
  is «Bunjakovec»), but the contiguity walk allowed only ONE skipped map word,
  so any client word sitting further in was unreachable — even bare «капитол»
  never bound «Трговски центар Капитол». Slice the leading run, BUT only as far
  as the client did not say those words, or a row stops binding its own name
  («Трговски центар Капитол», «Центар за ментално здравје» — the 27/5992
  self-bind regressions the map-wide sweep catches immediately).
- **THE LOOKUP MUST BE ASKED WITHOUT IT**: `resolvePlace` appends every try with
  its class tail removed, because `findPoisByName` needs the row to CONTAIN the
  whole phrase and no row contains «капитол мол». The coverage guard still
  signs off on whatever comes back, so the trim can never bind a different
  place.

Pinned in `tests/place-class-tail.test.ts` (guard units + the e2e capture);
the map-wide sweeps in `tests/place-bind-sweep.test.ts` and
`tests/place-coverage-sweep.test.ts` are the regression fence for any future
tweak of this guard.

THE SWEEP IS A COMMAND, NOT AN INVESTIGATION: `npm run place:misses -- --sweep`
replays every captured class-tail miss through the shipped handler and prints
the place each one binds (or the honest unbound list). Run it after touching
the guard or the class vocabulary. Current state (2026-11-03): kapitol mol →
ТЦ Капитол, бисер и капитол мол → ТЦ Бисер, дајмонд мол → Diamond Mall, чаим
беут ѓамија → Чазим Беут Ѓамија, zeleznicka/зелезницка stanica → the station,
komercjalna banka → Комерцијална Банка; the centar family binds the AREA and
must never bind a mall. Still unbound and NOT closable: «ок хоттел» (the map
holds no ОК Хотел row) and «вардрска 1 - кон центар» (a street, not a place).

TWO GUARD RULES FOUND BY THAT SWEEP — do not lose them:
- THE SLIP BUDGET OPENS AT FOUR LETTERS (`oneSlip`): «чаим» IS «Чазим» (the
  mosque's own name). The old five-letter floor required a real row to be
  refused because 4 of its 5 letters were right. First letter must still
  agree, and three-letter names (KAM/KAN) stay exact.
- THE SOUND KEY MAY NOT CARRY A SHORT WORD ALONE: `canonicalWordKey` folds
  vowels and k/c, so «чаим» and «KAM» are both «km» — the extractor's second
  candidate bound a SUPERMARKET for a mosque. A key-only match now needs a
  word of five letters or more, or a run whose other words carry the context;
  a lone short word must be the word itself.

### 4e. The place survives WHOEVER answers the turn

The funnel's slot binding (`applySlots`) runs on the CLASSIFIER path. Every lane
that answers EARLIER returns before it — the learned/dynamic serve at the top of
`processMessage` (`tryLearnedServe`) is the big one — so a place the client named
in THAT message used to vanish together with the answer.

The [22:58] capture: «STO IMTE INTERESNO KAJ KAPITOL MOL ?» → a learned
`[dynamic]` intro (correct prose, the operator kept it) → «ZA KUPUVANJE SUM» →
«Кажете ми во која населба или дел од градот…». The client was asked for the area
he had just named. THIS is why the same landmark bug kept returning after each
fix: every earlier repair landed in `applySlots` / the discovery intake, which
that lane never reaches.

Rules:

- `tryLearnedServe` binds the named place before it returns: `poiAnchor`, the
  area (via `areaAtPlace`) when the location is void or the anchor CHANGED (a new
  place is a new geography), and `inventoryPending` for a stock-at-a-place ask —
  the same two effects the discovery intake applies. An echo of the same place
  costs nothing; a new one clears the pair queues carved for the old one.
- When adding any lane that sends a reply BEFORE `applySlots`, ask what slot the
  turn would have written and write it there too. The place is the one that is
  silently lost (nothing throws; the next turn just asks again).
- The have-ask family reads **«кај»** as well as «во/на» (`INV_ASK_KAJ_RE` +
  `INV_PLACE_KAJ_RE`) and tolerates the dropped-vowel verb («IMTE»): «што имате
  кај X» is the most natural stock-at-a-place phrasing in Macedonian, and it was
  not an inventory ask at all. A pronoun tail («кај вас/нас») is not a place.

### 4f. A learned place answer is stored TWICE — prose and a `{place}` template

A generated answer that names a place is true only for that place: «Во близина
на Капитол Мол имаме одлични понуди…» is right for Капитол and a fabricated
location for Ѓорче. `bank_dynamic` therefore keeps, beside the verbatim
`answer`:

- `tmpl` — the same sentence with its place span replaced by `{place}`
  (`PLACE_SLOT` in `src/llm/placeTemplate.ts`),
- `place` — the anchor it was written for,
- `hits` — CLEAN serves: the promotion counter.

Rules:

- `placeTemplateFrom` refuses a DISTRICT-BOUND sentence: an answer naming a
  FEED AREA (`KNOWN_NEIGHBORHOODS`, shared with `detectInventoryAsk` — one list,
  no second copy) is never templated, or one district's stock claim would be
  handed to a place in another one. Such a row keeps verbatim-only recall,
  exactly as before the template layer existed.
- `tryPlaceInventoryServe` renders the template with the map's name for the
  place the CURRENT client named and passes the SAME `validateDynamicAnswer`
  gate a fresh generation does. It runs before the learned lane, and it writes
  the anchor + `inventoryPending` FIRST — so the follow-up asks the TYPE, never
  the neighbourhood.
- B — after `PLACE_PROMOTE_AFTER` (3) clean serves the template joins the copy
  layer under `PLACE_TEMPLATE_KEY` (`discovery.place.inventory`), so it survives
  the dynamic store's FIFO purge and serves places that never had a row.
- A CORRECTION INVALIDATES THE TEMPLATE: `updateDynamicAnswer` / `rewriteDynamic`
  clear `tmpl`/`place` and reset `hits`. The operator said the prose was wrong,
  so its templated copy is wrong too.
- Never template a sentence whose FACTS ride the place (availability, price,
  stock counts): that is the data-driven class, and `FORBIDDEN_FACTS` already
  refuses such prose at generation.
- NO STOCK CLAIM IN THE PLACE PROSE (the [20:38] owner rule): «Имаме одлични
  опции во регионот околу Беверли Хилс» was the FIRST sentence a client heard
  and it asserts inventory nobody has looked at — it reads as «we have something
  special everywhere». `assertsStockAtPlace` refuses such a template at serve
  time AND at backfill time, and `place.stock.ask` carries the owner's plain
  shape only: the place acknowledged neutrally, the market question
  («дали Ве интересира купување на недвижност или претпочитате
  изнајмување?») — no hype, no claim. A test pins every seed variant.

Tests: `tests/place-template-serve.test.ts` (the slot + district guard, the
reworded serve, the 3-serve promotion at a new place, the correction reset) and
`tests/dynamic-fallback.test.ts` (the generate seam stores the template).

### 4g. The order is the owner's: define the ask, THEN serve the pair

Every landmark, every opening (the [17:43] rule, restated at [20:39]): market →
TYPE → the category's own criteria → the pair. A pair on the table before the
criteria are named is the defect, twice captured:

- the category-ask lane gated on an ARMED SLOT, so «STANCE SAKAM DA ZEMAM» — the
  plural the field writes, which `detectPropertyTypeWord` knew and `detectFlat`
  did not — armed nothing, fell through to the serve lane, and got the cards
  with «колку спални / која цена» AFTER them. The lane now keys off the WORD (the
  same predicate the serve lane trusts) and writes the slot itself, so the two
  lanes can never disagree about whether the client named a category.
- a stock ask whose CATEGORY is already on file and whose criteria are missing
  (`stockAskWithType`) is answered with `buildDiscoveryAsk` — never a pair.
- the same applies to the PLURAL of a category noun: «stance», «stancevi»,
  «станови» are the field's spellings of «стан», and a detector that knows the
  category word but not its plural arms nothing (`detectFlat` now carries them).

Tests: `tests/inventory-type-ask.test.ts` (the [20:39] chain end to end, the
plural detector, no card before the criteria).

### 4h. The landmark lookup is paid ONCE, and the suite budget depends on it

The geo layer is a hot path, and it used to be quadratic in the wrong places:
«STO IMATE KAJ KAPITOL MOL» cost **18.5 s per turn, every turn** (measured), and
the test suite inherited it (files with place traffic took minutes each). Two
causes, both now contracts:

- **PER-ROW FACTS ARE DERIVED ONCE PER STORE** (`poiRows()` + the lazy accessors
  in `src/geo/offlineMap.ts`: `catOf`, `isShop`, `isTransit`, `isResidential`,
  `tokensOf`, `phoneOf`, `canonSetOf`, `typoWords*`). Healed name, folded and
  transliterated forms, category, tenant/transit/residential flags, token /
  phonetic / canonical / typo keys are properties of the ROW, never of the
  needle. A name pass must not run its own `SELECT … FROM pois` and must not
  re-derive a row it can ask for.
- **RANKS ARE ROW-WIDE, NOT PAIRWISE.** `matchRank` / `partOfVenue` scored
  inside the sort comparator re-tokenize every candidate O(n log n) times; they
  are computed once per candidate (the `scored` array).
- `findPoiByName` is MEMOIZED, misses included (a place the map does not hold
  stays a miss), and hands out copies so no caller mutates the cache.
- `pruneOutsideBbox()` must invalidate the index — any future writer of `pois`
  calls `invalidatePoiIndex()`.
- The `/tmp/landmark-debug.log` trail is opt-in (`LINA_LANDMARK_DEBUG`); it used
  to be an unconditional `appendFileSync` on every match (28 MB of runtime
  side effect on this box).
- `toLatin`/`toCyrillic`/`translitToLatin` use module-level lookup tables (they
  built/linear-scanned per call, and `soundKey` runs them over every map word).

Bound, stated plainly: the first DEEP lookup in a process (one the cheap
substring pass cannot answer — «KAPITOL MOL» is one, its spelling only meets
the map in the canonical pass) pays ~1.4 s to derive the key families for all
5.992 rows; after that a lookup is ~1 ms and a whole turn ~190 ms. That one-time
cost is per process, which is invisible in the running appliance but is paid
once per test bundle. Persisting the derived keys in the DB is the next step if
that bound ever matters (it would need a staleness check against `pois`).

Tests: `tests/place-lookup-cache.test.ts` (one row-set read, the index built in
one place, 20 cached lookups under the ceiling, copies, a remembered miss, the
answers unchanged).

### 4j. NEAR IS ONE KILOMETRE — and the ring ASKS, it never decides

The owner's number, for every type and both markets: a property may be called
«близу до X» only within **1 km** of X; 1,5 km is not near. `LANDMARK_NEAR_M`
(now 1000) is the ONE radius — the anchored serve, the cross-place queue and
the locate ring all read it.

- **NOTHING IN THE RING → ONE QUESTION, NO CARDS.** The turn names the place,
  states the MEASURED distance to the nearest option and asks exactly one
  binary question: «подалеку во истата населба, или во друга населба?»
  (`slots.poiTooFarAsk` / `poiTooFarAnchor`, `detectSameAreaWiden` vs
  `detectExplicitWiden`). The pick releases the ring (`slots.poiWidenScope` =
  `'area'` / `'city'`), the next batch is drawn from that side, and the opener
  SAYS which widen it was — a far card never wears the plain «до X». A NEW place
  clears the pick: a widen released for one place says nothing about another.
- **THE RING IS PER CARD.** A pair at 250 m + 1,8 km is not a near pair; the
  far row waits for the widen like the client asked.
- **THE CLIENT'S FARTHER ASK RELEASES THE RING — EVEN WITH NO ASK OPEN.**
  «DAJ MI STO IMAS PODALEKU» after a near pair (`detectSameAreaWiden` with an
  anchor, no new area in the message) IS the same-naselba widen: the pool is
  re-drawn from the anchor's own naselba with the 1 km bound lifted, and the
  batch says «Тоа е сè што имав двособни до 120.000 евра … понатаму ги
  покажувам трoсобни» before it serves the 1,4 km card. Two traps this rule
  closes: the criteria-done lane claims the more-verb («STO IMAS») and answers
  «Ги исцрпивме …» while the card exists, and `nearRing` measures the WHOLE
  pool — one near row that can never serve (over its category's cap) kept the
  ring armed and cut the far stock, so the widen branch is checked BEFORE the
  nearRing arm in `loadProps`.
- **A CROSS-PLACE SEARCH IS NOT ONE RING.** «воена болница ИЛИ City Mall»,
  «Универзална, Буњаковец, Католичка, Собрание»: each named place is measured
  separately (`placePairQueue`) and the pool is measured against the NEAREST
  named place, never against the first — otherwise the second place's stock is
  cut out of the pool and the rotation reports it empty.
- **AN ADDRESS THAT NAMES THE PLACE *IS* THE PLACE.** A flat on «Ул. Буњаковец
  8» measured 1,4 km from the map's Буњаковец pin (a long street has ONE point)
  and under this ring became «nothing near Буњаковец». Address identity beats
  point geometry.
- **A BARE CLASS NOUN IS NEVER A PLACE** (`refusesGenericNeedle`): «болница»,
  «мол», «црква», «училиште», «амбасада», «аптека»… name a KIND — the map
  refuses them instead of guessing the shortest row of that kind, and
  `NOT_A_PLACE_ALONE` refuses the closed-class words («други», «секој», «прв»)
  the same way. Two words, or one word that IS the institution's name
  («Собрание», the Assembly — one building), still resolve. «воена болница» is
  the HOSPITAL row (ГОБ 8-ми Септември), never the bus stop of that name.

Tests: `tests/place-ring-widen.test.ts` (the ask, the two picks, the
once-spent ask, «DRUGI» while it is open), `tests/capture-0342-tier-serve.test.ts`
(the farther ask with no ask open — the same-naselba serve and the drain
wording), `tests/place-class-noun-veto.test.ts`,
`tests/place-pairs.test.ts` (the per-place rotation), `tests/place-no-stock.test.ts`,
`tests/landmark-intake-discovery.test.ts` (the address identity and the echo
that walks on after the pick).

## 4k. THE TERM IS RENDERED, NEVER ECHOED (the [18:49]/[18:52] batch)

The visit ping-pong produced two defects in one exchange:

- **«PA NEKA BIDE 5» IS A CLOCK.** The client answered the exact-hour ask
  («Во колку часот планирате да дојдете?») with a consent frame and a naked
  digit. `CLOCK_RE` wants a preposition and `HOUR_WORD_RE` wants the hour noun,
  so the whole term question came back. The family lives in
  `visits/time.ASSENT_HOUR_RE` and is read by the detector, `hasClockHint`
  (the merge gate) and `parseVisitDateTime` — one pattern, three readers. The
  visit window decides AM/PM (5 → 17:00), and a money/room tail («neka bide 5
  iljadi», «neka bide 5 spalni») is vetoed inside the regex.
- **A STORED TERM IS SHOWN IN CANONICAL FORM.** The owner panel read
  «Клиентот не е во можност за посета во Среда во 6» — the raw counter with a
  naked hour, because the refused half used `mkTimePhrase` while the new half
  used `normalizeOwnerTime`. `prompts.renderVisitTerm` is now the ONE renderer
  for every term shown to a person (owner panel AND client panel): translit,
  then the day+clock resolution; a day-less phrase keeps its own form (the
  [10:24] rule). A relay never composes a term from a raw slot.
  Pins: `tests/visit-assent-hour.test.ts`, `tests/visit-term-rendered.test.ts`.

## 4l. THE CATEGORY IS NEVER THE DEFAULT (the [19:06]/[19:07] capture)

«MI TREBA NESTO INTERESNO KAJ CITY MOL» → «PA DA KUPAM BI SAKAL» was answered
with «Колку спални соби би Ви одговарале во станот?» — a flat nobody named —
and the correction «SAKAM DUKJAN DA ZEMAM , NE STAN» was answered with the SAME
bedroom question, because «NE STAN» armed the flat flag and vetoed
`detectBusiness`.

- **THE TYPE IS ASKED WHEREVER THE FUNNEL STANDS.** `typeHeld = !typeKnown` in
  `buildDiscoveryAsk` (it used to be scoped to `slots.inventoryPending`).
  Bedrooms, м² and the price wording are category-specific, so none of them may
  be asked before the category is on file. The AREA question is type-NEUTRAL and
  keeps firing — only its category-worded form is held back. The [13:44] loop is
  still safe: a bare «EDNA» supplies `flatEvidence`, so `typeKnown` is true and
  the type question can never follow it.
- **A NEGATED CATEGORY IS NOT THE CATEGORY.**
  `deterministic.stripNegatedCategoryWords` removes a category word behind a
  correction negation («ne/не/namesto/наместо/без» + optional want-verb/clitic)
  and every category reader (`detectFlat`, `detectBusiness`, `detectHouse`,
  `detectPlac`) must read the stripped text. Symmetric on purpose: «NE SAKAM
  DUKJAN, BARAM STAN» releases the business category the same way.
  Pins: `tests/type-unknown-ask-and-correction.test.ts`.

## 4m. A NAMED ЕВИДЕНТЕН БРОЈ IS NOT AN AMOUNT (the [19:12] capture)

«ZNACI KOLKU PARI TREBA DA IMAM SO MENE ZA DA GO IZNAJMAM 57 ?» was answered
with a visit-fee pitch. Three causes, all in the money lane:

- `detectTotalCostAsk` bailed on ANY digit, so the Евидентен број in the same
  sentence discarded the question. It now strips EB references with the shared
  `EB_NUMBER_SOURCE` reader first — an EB is a LISTING, not a price.
- The «колку пари треба да ИМАМ со мене» shape (the have-family) was missing
  from the grammar; it is anchored on the bring-with phrase, so a count
  question («колку спални треба да има станот») can never read as money.
- The lane's anchor came from session subjects only. `firstEbNumber(text)` is
  now read FIRST (still verified against the feed: rent + a real price), so the
  flat the client names in the question is the subject of the arithmetic.
  Pins: `tests/rent-cash-math-named-eb.test.ts`.

## 4n. A RECALL CAN NAME TWO LISTINGS, AND A PRICE IS NEVER AN ЕВИДЕНТЕН БРОЈ (the [22:26] capture)

One chat, six turns, one root cause per turn:

- «IMAVTE EDNA GARSONJERA … OKOLU 200E ILI KUKJA … ZA 250» names TWO
  descriptions. `extractSlots` merges them (one set of flags, the LAST price),
  so the serve answered with the куќа alone. `splitRecallCategories` splits on
  the client's own «или/ili», keeps each half's category AND price, and the
  recall lane serves one locked row per half — each half's category is a LOCK
  (a гарсоњера half never comes back as a three-room flat that costs the same).
  A half we do not hold is NAMED as missing.
- A GLUED CURRENCY IS A PRICE: «200E» in `ebNumber.ts` (`GLUED_UNIT_TAIL`, no
  «\s*» prefix) — «200E DALI E DOSTAPNA» was read as Евидентен број 200 and
  answered «200 не се наоѓа во моменталната понуда». The SPACED «63 E TAA»
  copula keeps its number.
- An availability ask about a flat ON THE TABLE (`AVAILABILITY_TABLE`) is the
  ack + the owner question for THAT flat, never a fresh criteria grill. It
  stands down on an EB, a room count, a plural type noun or an inventory ask —
  those are searches with their own lanes.
- TWO FLATS ON THE TABLE → the availability ack NAMES its Евидентен број
  (`availabilityReply`); a bare «сè уште е достапна» belongs to no flat, and the
  client then has to ask «KOJ BROJ E?».
- «KOJ BROJ E?» is the which-property family (`detectWhichPropertyAsk`), and
  the info ask BY PRONOUN («KAZI MI INFORMACII ZA NEJZE») is the describe lane:
  the card plus the confirm question «Дали ова е недвижноста што ја баравте?».
  The pronoun's GENDER picks the row (`pickByReferentGender`).
- «KAKO KE GO KONTAKTIRAS AKO NE ZNAES KOJ BROJ E ?» is a CHALLENGE, not a
  deferral: `detectDefer` refuses any second-person contact verb (its subject
  is HER), and `detectContactMechanicsChallenge` answers with the number she
  holds + the mechanism.
- HER ORIGIN IS A BOUNDARY (`personal.ts` kind `origin`): «OD KOE SELO SI?» gets
  the owner's one wording — «Од каде сум и што сум не би требало да Ве
  интересира … Тука сум за да Ви помогнам во изборот на недвижност. Повелете.»
- The sexual-demand family («da mi popusis…») is a severity-3 row; the bare
  verb is never listed (попуст/пуши are ordinary words), and smoking contexts
  are excluded.
  Pins: `tests/capture-2226-bunjakovec.test.ts`.

## 5. Tests and expectations

- Every fix ships with a regression test that FAILS before it and passes after.
- Prefer e2e tests that drive `InboundHandler` (the real pipeline) over unit
  tests of a detector in isolation; the routing order matters as much as the
  regex.
- Assert server-side state (`sessions.get(chatId).slots.*`) AND the served copy.
- Departures from production speed (0 ms typing windows, 1 ms send delay) are
  documented in the harness as speed knobs, never behaviour knobs.
- When a test fails, read the failure: the last two mis-fires in this repo were
  a typo in a test string (`PLALKA`) and a collapse-comparison without case
  folding (capital `Дали`), not product bugs. Fix the test with a comment.

## 6. Data and environment

- Secrets live in `~/.lina/lina.env` (mode 600), never in the repo; a `.env` in
  CWD trips a Node-18 loader bug. `lina.env.example` documents every key.
- `src/config.ts` loads that ONE file (`dotenv.config` with an absolute path) on
  every entry point, whatever the cwd; real process env (pm2/systemd) wins over
  it. So a rule that greps this repo for `.env`/`GROQ_API_KEY` proves NOTHING
  about whether the keys exist — if a report says "no LLM keys", verify with
  `npm run llm:live-check:fast` and `grep -c '^GROQ_API_KEY=' ~/.lina/lina.env`,
  not by listing the project directory.
- The TUI's brain chooser has four modes — `hybrid` (default: Gemini pool →
  Groq), `gemini` (the rotating pool only), `groq` (Groq only), `free` (no LLM
  for known answers; novelty still escalates to the real boot brain). `/status`
  must show `config: …/lina.env (loaded)` and `llm: gemini=N keys, groq=yes`;
  when it shows a key count of 0 the process env is wrong, not the code.
- The offline map DB resolves through the `src/geo` symlink (`canonicalPoisDb`),
  so the answer follows the geo code, not the cwd. A stale copy in `data/` was a
  silent landmark-quality bug once — do not reintroduce one.
- Long copy, prices and counts are data: quota numbers, fees and the commission
  tier live in the bank/constraints, never hardcoded in a handler.

## 4o. THE BATCH IS COMPARED, NEVER RE-SERVED (the [09:41]–[09:51] batch)

Over ONE pair of cards (EB 91, ad «Маџар Маало»; EB 74, ad «Дебар Маало») the
client asked three questions and got the same pair back twice:

- **«KOJ OD NIV E VO MADJAR MAALO?» IS A COMPARISON.** No lane owned a question
  that DISCRIMINATES the offered rows by place, so the recall path read the place
  as a new search and re-served both. `detectWhichOfBatchPlace` (data/properties)
  is the ONE detector: which-word + batch reference (`od niv/ovie/tie`) + a place
  phrase — a bare search («koj stan e vo centar?») and a nearest-ask are excluded
  by construction. The answer is PER ROW from each row's OWN words: the flat that
  IS there is named (and becomes `slots.propertyId`), every other row is said
  where it really stands via `adArea(p)` — the area the ad itself names, never the
  feed's municipality. This matters because «Маџар Маало» canonicalises to
  «Центар», and `inArea`'s naselba leg would then match EVERY Центар row.
  `isAdDefinedArea` decides which of the two legs is honest.
- **A SINGULAR DISTANCE ASK IS ABOUT THE FLAT UNDER DISCUSSION.** «NA KOLKAVO
  RASTOJANIE **E** OD …» (one flat) after a two-card serve answered BOTH rows and
  stamped the nearest onto the slots, so the discussed flat lost its anchor. The
  batch arm is now gated by `distanceAskIsPlural` — the PLURAL form
  («… **SE** OD …», «dvata/ovie») keeps the per-row comparison, the singular one
  falls through to the single-flat arm, which NAMES the EB when several cards
  have been shown.
- **THE COMMISSION ASK IS NEVER A FUNNEL POSITION.** «KOLKU VI E PROVIZIJATA ?»
  in `property_locate` was skipped by the state gate and the cards were served
  again. `SIMPLE_DETECTORS`'s PROVISION_ASK row now allows EVERY client-side
  state — and the ROUTING_ORDER mirror carries the executor's own list, because a
  narrower gate there predicts FALLTHROUGH for a turn the lane really serves.
Pins: `tests/capture-0941-batch.test.ts`, `tests/route-coverage.test.ts`.
