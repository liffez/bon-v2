# BON_V2_ROADMAP.md — Større projekter på horisonten

> Roadmap over større projekter og paraplyer.
> Adskilt fra `BON_V2_HUSKELISTE.md`, som dækker pligter og småting der skal lukkes ned.
> Opdateres når nye områder identificeres eller status skifter.

---

## Status (maj 2026)

Cutover til Bon v2 på Hetzner er gennemført. V1 sat på pause.
Småfix håndteres løbende via Claude Code; større projekter prioriteres herfra.

---

## Paraply 1 — Levering (3 spor)

Tre separate projekter under ét tema. Udvikles sekventielt — hvert spor bygger på det forrige.

| Spor | Indhold | Status | Afhænger af |
|------|---------|--------|-------------|
| **A** | Templates & booking (By-expressen + Taxa via Settings) | Delvist implementeret | By-expressen credentials fra Sebastian |
| **B** | Ruteplanlægning (OSRM, sekvensering, kapacitet) | Ikke startet | Spor A |
| **C** | Bud-app (mobil/PWA til bud i marken) | Ikke startet | Spor A + B |

**Spec:** `CLAUDE_DELIVERY.md`

---

## Paraply 2 — Web-input (3 kanaler + 1 fundament)

Eksterne kanaler hvor ordrer og leads kommer ind. Hver kanal er selvstændig, men de deler integrationsmønster:

> ekstern kanal → webhook → bon oprettes i Bon v2

| # | Område | Status | Spec |
|---|--------|--------|------|
| 0 | **Formbuilder field-type-engine** *(forarbejde)* — `grocy_product_picker`, `chip_group`, `info_box`, `option_group` som ægte field-types. Erstatter hardcoded `embed/bestilling.html`. Alle 3 kanaler nedenfor får gavn af samme engine | Spec skrives separat — **ikke akut**, nuværende embed-form fungerer | — |
| 1 | **Portal** (`portal.ristetrug.dk`) | Spec klar + visuelt design klar | `CLAUDE_PORTAL.md` |
| 2 | **Event-bestilling** | Standalone system findes (Stripe + MobilePay, Node/Express). Skal integreres med Bon v2 via webhook, samme mønster som embed-bestilling | Eget repo + README |
| 3 | **Kontaktformular** (WordPress embed) | Ny form-variant via eksisterende formbuilder | — |

---

## Paraply 3 — AI / agent

| # | Område | Status | Spec |
|---|--------|--------|------|
| 1 | Menu AI agent | Specced, mangler `ANTHROPIC_API_KEY` på server | `CLAUDE_MENU_AGENT.md` |

Plads til flere AI-features (kundeklassificering, mail-routing-assist, opfølgnings-forslag) — ikke specced endnu.

---

## Paraply 4 — Andre større områder

| # | Område | Status | Spec |
|---|--------|--------|------|
| 1 | **E-conomic adapter** — linje-priser konverteres til EX moms via `inclToExcl()` ved payload-build; modtag fakturanummer → gem på `bons.invoice_number` → status FAKTURERET. Test #7 i `moms_audit_e2e.test.js` er placeholder | Spec klar, ikke bygget | `CLAUDE_ECONOMIC_ADAPTER.md` |
| 2 | Ugeoversigt med capacity ratio | Specced | Feature-flagged default off |
| 3 | Sidekick overlay (Whiteboard) videreudvikling | Status uklar | SSO virker |
| 4 | SOP app integration | Status uklar | Subdomain reserveret (`sop.ristetrug.dk`) |
| 5 | Reports/rapporter videre arbejde | Modul i produktion | Verificér om der er løse ender |

---

## Paraply 5 — Strategisk / V3

| # | Opgave | Status | Spec |
|---|--------|--------|------|
| 1 | V3 scoping for alvor | Baseline-doc findes | `CLAUDE_BON_V2_BASELINE.md` |
| 2 | Grocy replacement som parallel test track | Idé-fase | Kan løbe ind i v4 — ikke committet replacement |

---

## Forslag til rækkefølge

> Min anbefaling — du beslutter.

**Næste op (3–6 uger):**
1. Færdiggør **Spor A (Templates & booking)** når Sebastian leverer credentials
2. **E-conomic adapter** — lille spec, fjerner manuelt arbejde med fakturanummer + status-skift
3. **Kontaktformular** — lille, lukker et hul i WordPress
4. **Portal** — spec + design klar, naturligt at bygge nu

**Derefter (parallel/seriel afhængigt af kapacitet):**
5. **Event-bestilling-integration** — eksisterende system kobles ind
6. **Menu AI agent** — kort ramp-up når API-key er på plads
7. **Ugeoversigt**

**I baggrunden (når der er overskud):**
- Spor B (Ruteplanlægning) — afhænger af Spor A
- V3 scoping
- SOP / Sidekick videreudvikling
- Formbuilder field-type-engine — fundament for hele Paraply 2

**Senere:**
- Spor C (Bud-app)
- Grocy replacement track

---

*Oprettet: maj 2026 · Sidst opdateret: 19. maj 2026 — tilføjet E-conomic adapter under Paraply 4 og Formbuilder field-type-engine under Paraply 2 efter krydsreference mod CLAUDE.md.*
