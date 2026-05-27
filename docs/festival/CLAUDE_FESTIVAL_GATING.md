# CLAUDE_FESTIVAL_GATING.md — Modul-styring (multi_location + festival)

> **Beslutning:** Festival er et **feature-flag modul** i samme kodebase — ikke en separat app
> eller løs plugin. Følger `BON_V2_PRINCIPPER.md` §7 ("feature flags i `system_settings` per
> modul", single-tenant, white-label). Ingen ny arkitektur; samme server, samme stak.
>
> **Hvorfor ikke separat app:** en løs plugin ville bryde §2/§7 (én server, ingen build-step,
> ingen afhængighedshelvede). Et flag i `system_settings` giver præcis samme til/fra-effekt
> uden den pris.

---

## 1. Kerneindsigt — det meste er IKKE festival

Det vi designede er overvejende **multi-lokation**, ikke festival-specifikt. En kunde uden
festival har bare én lokation, og så er lokations-laget usynligt. Kun et tyndt lag er ægte
festival-only.

| Lag | Hvad | Gating |
|-----|------|--------|
| **Generisk (altid på)** | salg, indkøb, optælling, bonner, moms, status-flow | ingen |
| **Multi-lokation** | lokations-scope (`session.location_id`), `getGrocyConnection`, lokations-badge, fail-closed gate, re-home, **transfer** (send→modtag/retur) | `multi_location` |
| **Festival-only** | afstemnings-view, festival-Zettle-flow, event-tag, waste-bon-kategori, klon-doktrin | `festival_enabled` |
| **Kæde (fremtid)** | løbende stamdata-sync mellem permanente lokationer (fælles katalog) | `chain` (ikke bygget) |

### Tre driftsmønstre — samme fundament

Multi-lokation er fundamentet (scope + transfer + `global_key`-opslag). Oveni ligger to
mønstre for hvordan **stamdata** håndteres (jf. §6d "én master"):

| Mønster | Stamdata | Bygges |
|---|---|---|
| **Festival** | engangsklon af master, disponibel | nu |
| **Kæde** | løbende sync fra master, permanent | fremtid — fundamentet spærrer ikke |

Transfer er fælles for begge; den slår altid op via `global_key`, så den virker uanset om
lokationerne er kloner (id matcher) eller uafhængige (id matcher ikke).

---

## 2. To flags

```
system_settings:
   multi_location   = 0 | 1     (auto-afledt: tænd når locations-tabellen har >1 aktiv lokation)
   festival_enabled = 0 | 1     (manuelt pr. installation)
   chain            = 0 | 1     (fremtid — løbende stamdata-sync; ikke bygget)
```

| Flag | Sættes | Effekt når slukket |
|------|--------|--------------------|
| `multi_location` | automatisk fra antal aktive lokationer | lokations-UI skjult; alt kører mod den ene lokation; fail-closed-gaten viser aldrig et valg (kun HQ findes) |
| `festival_enabled` | manuelt (settings) | afstemning, transfer, festival-Zettle, event-tag skjult/inaktive |

**Afhængighed:** `festival_enabled` forudsætter `multi_location` (en trailer = en ekstra
lokation). Festival uden multi-lokation giver ingen mening; UI bør ikke kunne tænde festival
før der er >1 lokation.

---

## 3. Den vigtige byggeregel

> **Byg lokations-scoping som generisk infrastruktur — IKKE inde i festival-modulet.**

`getGrocyConnection`, `session.location_id`, adapteren og scoping af køkken/indkøb/optælling
er **multi-lokation**, ikke festival. De skal ligge i kerne-laget (`shared/`), gated på
`multi_location`, så de virker for enhver multi-lokations-kunde uanset festival.

Festival-modulet (afstemning, transfer-UI, festival-Zettle) bygger **ovenpå** lokations-laget
og gates separat på `festival_enabled`.

| Forkert | Rigtigt |
|---------|---------|
| lokations-scope inde i festival-kode | lokations-scope i kerne, gated `multi_location` |
| festival_enabled styrer adapteren | adapteren er altid til stede; kun festival-UI gates |

---

## 4. Konsekvens for de øvrige dokumenter

Ingen omskrivning — kun gating-noter:

| Dokument | Gating |
|----------|--------|
| CLAUDE_LOKATION.md | `multi_location` (generisk) |
| CLAUDE_TRANSFER.md | `multi_location` — delt af kæde + festival; `global_key`-opslag gør den begge-klar |
| CLAUDE_INDKOB_TRAILER.md | scoping = `multi_location`; festival-leveringsadresse-UI altid nyttig |
| CLAUDE_FESTIVAL.md | `festival_enabled` |
| CLAUDE_FESTIVAL_AFSTEMNING.md | `festival_enabled` (tidsbegrænset forecast er festival-specifik) |
| §6d klon-doktrin | festival-implementering af "én master"; kæde = sync-implementering (fremtid) |

---

## 5. Buildplan-tilføjelse

I `CLAUDE_FESTIVAL_BUILDPLAN.md`, læg ind tidligt (omkring TRIN 1–3):

```
Etablér to flags i system_settings FØR moduler bygges:
   multi_location (auto fra locations-antal) · festival_enabled (manuelt)
Lokations-laget (TRIN 1+3) gates multi_location og lægges i kerne — ikke i festival-modul.
Festival-only trin (4 transfer-UI, 7 festival-flows, 8 afstemning) gates festival_enabled.
Verifikation pr. trin: med begge flags = 0 er Bon v2 uændret ren HQ-drift (regression).
```

---

## 6. Verifikation

```
begge flags = 0  → Bon v2 = ren single-lokation HQ-drift, uændret (regression)
multi_location = 1, festival = 0  → lokations-scope/badge/re-home aktivt; ingen festival-UI
begge = 1  → fuld festival-funktion
festival kan ikke tændes uden multi_location
white-label: festival-modulet kan slukkes for kunder der ikke vil have det, uden at røre kerne
```
