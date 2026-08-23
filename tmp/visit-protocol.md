# METROPOLIS VISIT PROTOCOL — Complete Documentation

## Overview

The visit protocol is a 4-turn staged disclosure system that keeps the property address secret until the visit is locked in. Each turn is tracked per-party (owner/client) in the `visit_turns` table to prevent double-sends.

**Key principle:** The exact street address is NEVER shown to the client until Turn 3 (2 hours before the visit). Before that, only approximate landmarks are used.

---

## Pre-Protocol: The Conversation Flow

Before the visit protocol starts, the conversation goes through:

1. **Intent** — Client declares buy/rent
2. **Discovery** — Lina asks criteria (location, beds, budget)
3. **Presentation** — Property cards shown (with approximate landmark only)
4. **Closing** — Client expresses interest → fee disclosed → fee agreed
5. **Visit Scheduling** — Client proposes a time ("UTRE POPLADNE")
6. **Owner Check** — Lina pings the owner for availability → owner says OK/counter/gone
7. **Visit Arranged** — Client confirms time → **protocol starts**

---

## TURN 0 — Address Confirmation (OWNER ONLY)

**Trigger:** Client confirms the visit time (e.g., "UTRE POPLADNE")

**Function:** `scheduler.arrange()` → calls `buildAddressConfirm()`

**Sent to:** OWNER ONLY (client does NOT see this)

**Message format:**
```
ДОГОВОРЕНА ПОСЕТА НА ЕВИДЕНТЕН БРОЈ 89; Петок 22.08.2026; 17:30
Адреса: Бул. АСНОМ 134
https://www.google.com/maps/search/?api=1&query=Бул.+АСНОМ+134,+Аеродром,+Скопје

Ми треба потврда од ваша страна за точната локација на недвижноста. Дали адресата е точна?
```

**Components:**
- `buildAddressConfirm(eb, when, address, mapsUrl)` — builds the message
- `mapsLinkFor(address, location)` — generates Google Maps link from the address
- Written address + Google Maps link (for elderly clients who can't use phones)

**What happens next:**

| Owner's reply | Action |
|---|---|
| "да" / "точна е" / "ок" | → `confirmAddress()` → Turn 1 fires |
| "не, адресата е [X]" | → address corrected in DB → Turn 1 fires with new address |
| No reply for 2 hours | → bump sent: "Ми треба ваша потврда за точноста на локацијата" |
| "ќе ја потврдам подоцна" | → wait (no bump yet) |

**DB changes:**
- `visit_turns`: row created with `turn='address_confirm'`, `status='pending'`, `scheduled_at=now+2h`
- `appointments.visit_at`: set to parsed datetime

**Operator log:** `[ЛОГ ПОСЕТА ЕБ 89] TURN 0 ADDRESS CONFIRM sent to owner — awaiting confirmation`

---

## TURN 0 BUMP — Reminder (OWNER ONLY)

**Trigger:** 2 hours pass without owner confirmation

**Function:** `scheduler.tick()` → `dispatchTurn()` with `turn='address_confirm'`

**Sent to:** OWNER ONLY

**Message:**
```
Ми треба ваша потврда за точноста на локацијата, за организирање на посетата.
```

**Behavior:**
- Sent every 2 hours until owner confirms
- Turns 2+3 are BLOCKED while address_confirm is pending
- Owner can still confirm at any time

---

## TURN 1 — ДОГОВОРЕНА ПОСЕТА (BOTH parties)

**Trigger:** Owner confirms address (via `confirmAddress()`)

**Function:** `scheduler.confirmAddress()` → calls `buildArrangedVisit()`

**Sent to:** BOTH owner and client

**Message format:**
```
ДОГОВОРЕНА ПОСЕТА НА ЕВИДЕНТЕН БРОЈ 89; Петок 22.08.2026; 17:30
Адреса: Бул. АСНОМ 134
```

**Components:**
- `buildArrangedVisit(eb, when, address)` — builds the message
- Written address included (for elderly clients)
- NO Google Maps link yet (only in Turn 3)

**If owner corrected the address:**
- `confirmAddress(newAddress)` stores the corrected address on the appointment
- Turn 1 uses the corrected address
- Turns 2+3 also use the corrected address

**DB changes:**
- `visit_turns`: `address_confirm` → `status='sent'`
- `appointments.corrected_address`: set if owner provided new address

**Operator log:** `[ЛОГ ПОСЕТА ЕБ 89] ARRANGED VISIT — OWNER: Петре (070/111-222) OK / CLIENT: Марко (078/914-196) OK`

---

## TURN 2 — Morning Confirmation (BOTH parties)

**Trigger:** Morning of the visit day (09:00 for morning visits, 10:00 for afternoon)

**Function:** `scheduler.tick()` → `dispatchTurn()` with `turn='confirm'`

**Sent to:** BOTH owner and client

**Message format:**
```
ДОГОВОРЕНА ПОСЕТА НА ЕВИДЕНТЕН БРОЈ 89; Петок 22.08.2026; 17:30; АГЕНТ ЗА КОНТАКТ 076/247-467
Адреса: Бул. АСНОМ 134
```

**Components:**
- `buildMorningConfirm(eb, when, agentPhone, address)` — builds the message
- Agent phone number included (for direct contact)
- Written address included

**Client follow-up (if client asks after receiving):**
```
Ќе бидете известени за деталите и локацијата 2 часа пред посетата.
```
- `CLIENT_LOCATION_FOLLOWUP` — sent automatically after Turn 2

**DB changes:**
- `visit_turns`: `confirm` → `status='sent'`

**Operator log:** `[ЛОГ ПОСЕТА ЕБ 89] VISIT CONFIRMATION 2 TURN — OWNER: ... / CLIENT: ...`

---

## TURN 3 — EXACT Location (BOTH parties)

**Trigger:** 2 hours before the visit time

**Function:** `scheduler.tick()` → `dispatchTurn()` with `turn='location'`

**Sent to:** BOTH owner and client

**Message format:**
```
ЛОКАЦИЈА ЗА ЕВИДЕНТЕН БРОЈ 89; Петок 22.08.2026; 17:30; АГЕНТ ЗА КОНТАКТ 076/247-467
Адреса: Бул. АСНОМ 134
https://www.google.com/maps/search/?api=1&query=Бул.+АСНОМ+134,+Аеродром,+Скопје
```

**Components:**
- `buildLocationMsg(eb, when, agentPhone, address, mapsUrl)` — builds the message
- **ONLY time the exact address is revealed via Google Maps link**
- Written address included (for elderly clients)
- Agent phone for direct contact

**DB changes:**
- `visit_turns`: `location` → `status='sent'`

**Operator log:** `[ЛОГ ПОСЕТА ЕБ 89] 3 TURN LOCATION SENT — OWNER: ... / CLIENT: ...`

---

## CANCELLATION — Any Time Between Turn 0 and Turn 3

**Trigger:** Client or owner says they can't make it

**Detection:** `detectVisitCancellation(text)` — regex matches:
- "не можам да дојдам", "не сум во можност"
- "треба да откажам", "откажувам"
- "болен сум", "болна сум", "болест"
- "дојде работа", "имам проблем"
- "cancel", "canceled", "cancelled"

**Works in states:** visit_scheduling, owner_checking, time_confirm, pending, queued

### Client cancels:

**Function:** `scheduler.cancelVisit(appointmentId, 'client')`

**Sent to:** BOTH owner and client

**Message:**
```
Откажана посета по желба на клиент за Евидентен број 89.

Метрополис се извинува за непланираните околности.
Ќе бидеме во контакт.
```

### Owner cancels:

**Function:** `scheduler.cancelVisit(appointmentId, 'owner')`

**Sent to:** BOTH owner and client

**Message:**
```
Откажана посета по желба на сопственикот за Евидентен број 89.

Метрополис се извинува за непланираните околности.
Ќе бидеме во контакт.
```

**DB changes:**
- `visit_turns`: ALL pending turns → `status='skipped'`
- No more turns will fire

**Operator log:** `[ЛОГ ПОСЕТА ЕБ 89] CANCELLED by client — OWNER: Петре / CLIENT: Марко`

---

## Timeline Example

For a visit on **Петок 22.08.2026 at 17:30**:

| When | Turn | Who gets it | Message |
|---|---|---|---|
| Четвртак 21.08 ~15:30 (when visit is arranged) | **Turn 0** | Owner only | Address confirm + maps link |
| Четвртак 21.08 17:30 (2h later) | **Bump** | Owner only | "Ми треба ваша потврда..." |
| Четвртак 21.08 17:30+ (owner confirms) | **Turn 1** | Both | ДОГОВОРЕНА ПОСЕТА + address |
| Петок 22.08 09:00 | **Turn 2** | Both | Confirmation + agent phone + address |
| Петок 22.08 15:30 (2h before) | **Turn 3** | Both | EXACT location + Google Maps link |

---

## Key Functions

| Function | File | Purpose |
|---|---|---|
| `buildAddressConfirm()` | messages.ts | Turn 0 message |
| `ADDRESS_CONFIRM_BUMP` | messages.ts | Turn 0 reminder |
| `buildArrangedVisit()` | messages.ts | Turn 1 message |
| `buildMorningConfirm()` | messages.ts | Turn 2 message |
| `buildLocationMsg()` | messages.ts | Turn 3 message |
| `buildCancelledByClient()` | messages.ts | Client cancellation |
| `buildCancelledByOwner()` | messages.ts | Owner cancellation |
| `mapsLinkFor()` | messages.ts | Google Maps link builder |
| `scheduler.arrange()` | scheduler.ts | Initiates protocol (Turn 0) |
| `scheduler.confirmAddress()` | scheduler.ts | Owner confirms → Turn 1 |
| `scheduler.cancelVisit()` | scheduler.ts | Cancellation handler |
| `scheduler.tick()` | scheduler.ts | Periodic check (fires Turns 2+3) |
| `scheduler.forceTurn()` | scheduler.ts | TUI/testing: fire a turn now |
| `detectVisitCancellation()` | deterministic.ts | Detects cancellation messages |

---

## Address Privacy Rules

1. **The exact street is NEVER shown to the client** during the conversation
2. **Only approximate landmarks** are used: "во близина на Парк Авионче"
3. **Turn 0** reveals the address to the OWNER only (they need to confirm it)
4. **Turn 1** includes the written address (but NO maps link)
5. **Turn 3** is the ONLY time the Google Maps link is sent (2h before visit)
6. **If the owner corrects the address** → stored in `appointments.corrected_address` → used for all subsequent turns
7. **Written address always accompanies the maps link** (elderly clients can't use phones)

---

## Edge Cases

| Scenario | Handling |
|---|---|
| Vague time ("утре попладне") | Turn 1 sent directly (no Turn 0), turns 2+3 skipped, operator notified |
| Owner doesn't confirm in 2h | Bump sent every 2h until confirmed |
| Owner says wrong address | Address corrected in DB, new maps link generated, Turn 1 uses corrected address |
| Client cancels after Turn 0 | Both get cancellation message, all turns skipped |
| Owner cancels after Turn 1 | Both get cancellation message, turns 2+3 skipped |
| Server restarts mid-protocol | `tick()` resumes from DB state (turns tracked in `visit_turns`) |
| Visit already happened | Stale turns auto-marked as skipped |
