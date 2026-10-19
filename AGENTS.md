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
