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

`npm test` stays the authoritative gate, but it pays `tsx` boot + transpile for
all 116 files. While iterating:

```bash
npx tsx --test tests/<the files you touched>.test.ts   # seconds
npm run test:fast                                      # compiled, no PTY file
npm run test:c                                         # compiled, everything
```

`test:c`/`test:fast` bundle each file with esbuild and run plain
`node --test` (same tests, same assertions; ~40% faster on 4 cores because the
per-file transpile disappears and the runner oversubscribes the cores, since
the suite is latency-bound). The PTY funnel file owns ~60 s of wall by itself —
that is why `test:fast` leaves it out; it MUST run before a deploy, together
with the full `npm test`.

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
```

Keep it to THREE short rows (a 24-row terminal leaves the chat pane ~10 rows; a
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
