# CLAUDE_ZETTLE_POS.md — Zettle (PayPal POS) → Bon v2

> **Status:** SPEC. Fase 1 verificeret mod produktionskontoen 21. august 2026 (§15) — read-only,
> intet skrevet. Fase 2–4 ikke bygget. Fire faser, se §14.
> **Beslægtet:** `docs/CLAUDE_EVENT_BON_BRIDGE.md` (samme mønster, modsat retning) ·
> `docs/CLAUDE_EVENT.md` §5 (lager-gaten) + §6 (top-up/retur) + §15.3 (festival-bemanding) ·
> `docs/economics/CLAUDE_PENGESTROEM.md` §2.E/§2.F (event-indtægt uden faktura).

---

## 1. Hvorfor

Ristet Rug sælger på events over Zettle. I dag ender de penge i Bon v2 ad én manuel vej:
nogen finder bankindbetalingen i Pengestrøm og taster en salgsbon
(`POST /api/cashflow/create-bon-from-tx`). Indtil det sker, står eventets P&L med
**0 kr i omsætning** — et aktivt event viser et rent underskud svarende til vareforbruget.

Fire ting kommer af at hente salget automatisk, og tre af dem er funktioner der
**allerede er bygget og venter på tallet**:

| # | Udbytte | Hvad det låser op |
|---|---|---|
| 1 | Event-P&L bliver rigtig løbende | `computeEventPL` ([routes/events.js:119](../routes/events.js#L119)) summerer salgsbons |
| 2 | "Solgt" bliver målt i stedet for gættet | Top-up-forslag + retur-forslag (`CLAUDE_EVENT.md` §6) — formlen er `rest = prep − solgt` |
| 3 | Faktisk gebyr + automatisk bankafstemning | Erstatter `event_bridge_fee_pct`-estimatet; lukker den manuelle "Find indbetaling" |
| 4 | Timefordelt salg | `CLAUDE_EVENT.md` §15.3 pkt. 2: festival-kapacitet *"kræver ordre-fordeling pr. time, som vi kun får fra eget POS"* |

Salgskurven i sig selv er det mindst værdifulde — den findes i Zettles egen app. Den er
med som **biprodukt** af data-strømmen, ikke som formålet.

---

## 2. Ansvarssnit

Zettle-broen er **pull-spejlingen af event-broen**. Den ejer nøjagtig én ting:

> **Én salgsbon pr. forretningsdag pr. POS-kilde**, bygget af dagens gennemførte køb,
> reconciled ved hver polling, frosset når nogen fører den videre.

Den rører **ikke**: lager, prep-bons, forecast, priser i Grocy, e-conomic, eller bons
et menneske eller event-broen har lavet.

---

## 3. Beslutninger (Leif, 21. august 2026)

| # | Spørgsmål | Svar | Konsekvens for designet |
|---|---|---|---|
| 1 | Ringes forudbestilte ordrer op i kassen? | **Nej.** Man kan ikke forudbestille til et event hvor der samtidig sælges over Zettle. Forudbestilling dagen inden til levering *på* eventet er OK. | Event-broens `sales`-bon og POS-salgsbonnen er **disjunkte**. De må gerne ligge på samme event og samme dag — de summerer korrekt i P&L. Hver kilde ejer sin egen bon via sin egen ejerskabstabel. |
| 2 | Kun Grocy-varer? | **Nej** — der sælges også andet ved events. | Linjer uden Grocy-kobling er **lovlige**: navn + pris fra Zettle, `grocy_recipe_id = NULL`, ingen kostpris/CO₂. De skal være **synlige** som ukoblede, aldrig droppes. |
| 3 | Hvornår skifter en festivaldag? | Der lukkes typisk ved 24, men det trækker ud. **Skæring 04:00** (indstillelig). | Et køb kl. 01:30 hører til dagen før. Se §6. |
| 4 | Refunderinger? | ~0,5–1 pr. dag, kommer ind som negative betalinger. | Nettes ind i dagens aggregat (§9). Sen-refunderinger kræver et gen-synk-vindue. |
| 5 | Hvordan ved vi hvilket event et køb hører til? | **Eventet slår det til selv** — et flueben på eventet. Zettle har nu flere salgssteder, så det forberedes; men vi bestræber os på ikke at have to events samtidig. | `events.pos_enabled` + `events.pos_store_ref` (§6.2/§6.3). Ingen dato-inferens, ingen POS-bon uden tilvalg. |
| 6 | Lager? | **Rør det ikke nu.** | POS-salgsbonnen får `event_id` → `CLAUDE_EVENT.md` §5's no-deduct-gate springer trækket over. Prep-bonnen ejer lageret. Skal testes eksplicit. |

---

## 4. Datamodel

**Migration:** næste ledige nummer (**152** pr. 21. august 2026 — verificér først, jf. #500).

### 4.1 `pos_purchases` — rå køb, ét sted

```sql
CREATE TABLE pos_purchases (
    id             INTEGER PRIMARY KEY,
    source         TEXT NOT NULL DEFAULT 'zettle',
    purchase_uuid  TEXT NOT NULL,              -- Zettles egen UUID → idempotens
    purchase_no    INTEGER,                    -- Zettles løbenummer (til opslag i deres app)
    occurred_at    TEXT NOT NULL,              -- UTC, som Zettle leverer det
    business_date  TEXT NOT NULL,              -- afledt (§6) — dagen købet TÆLLER på
    amount_incl    REAL NOT NULL,              -- kroner INCL moms (negativ ved refundering)
    payment_type   TEXT,                       -- CARD | CASH | MOBILEPAY | …
    is_refund      INTEGER NOT NULL DEFAULT 0,
    raw_json       TEXT NOT NULL,              -- hele købet som Zettle sendte det
    synced_at      TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(source, purchase_uuid)
);
CREATE INDEX idx_pos_purchases_day ON pos_purchases(business_date);
```

**Hvorfor gemme rå køb i stedet for kun at aggregere:** dagens aggregat bliver en **ren
funktion** af rækker vi selv har (testbar uden netværk, gen-kørbar når Zettle er nede),
kurven er et `GROUP BY` væk, og `UNIQUE(purchase_uuid)` gør re-synk gratis idempotent.
Samme instinkt som frosne `cost_price`/`co2e`-snapshots: gem hvad du så.

Varelinjer udledes fra `raw_json` ved aggregering — ikke en tabel mere. Volumen er lille
(nogle hundrede køb på en festivaldag), og hele parse-logikken bor så ét testbart sted.

### 4.2 `pos_sales_days` — ejerskab + dagsopsummering

```sql
CREATE TABLE pos_sales_days (
    id             INTEGER PRIMARY KEY,
    source         TEXT NOT NULL DEFAULT 'zettle',
    business_date  TEXT NOT NULL,
    event_id       INTEGER REFERENCES events(id) ON DELETE SET NULL,  -- NULL = ikke tildelt
    bon_id         INTEGER REFERENCES bons(id)   ON DELETE SET NULL,
    gross_incl     REAL NOT NULL DEFAULT 0,     -- hele dagens salg, alle betalingsmidler
    by_payment_json TEXT,                       -- {"CARD":9105.00,"CASH":420.00,…}
    purchase_count INTEGER NOT NULL DEFAULT 0,
    refund_count   INTEGER NOT NULL DEFAULT 0,
    unmatched_json TEXT,                        -- POS-varer uden Grocy-kobling
    last_synced_at TEXT,
    last_error     TEXT,
    UNIQUE(source, business_date)
);
```

Den er **både** ejerskabsregistret (som `event_bridge_bons`, migration 137) og dagens
opsummering. Betalingsmiddel-splittet bor her, fordi §10's afstemning kun må holde
**kort/MobilePay**-delen op mod Zettles udbetaling — kontanter rammer aldrig banken.

`event_id NULL` er en gyldig tilstand: dagen er hentet, men ingen ved hvilket event den
hører til. Se §6.

### 4.3 `events` — tilvalg pr. event

```sql
ALTER TABLE events ADD COLUMN pos_enabled   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN pos_store_ref TEXT;
```

Default 0 ⇒ migrationen ændrer intet for eksisterende events, og features tændes af
mennesker, ikke af en migration. Se §6.2.

### 4.4 Settings

| Nøgle | Default | Betydning |
|---|---|---|
| `zettle_enabled` | `0` | Master-kontakt. Alt er inert indtil den tændes. |
| `zettle_business_day_cutoff` | `04:00` | Døgnskiftet (§3 pkt. 3) |
| `zettle_poll_minutes` | `10` | Polling-interval |
| `zettle_resync_days` | `3` | Hvor mange dage bagud der gen-synkes (fanger sene refunderinger) |
| `zettle_default_price_category` | `festival` | Priskategori på POS-salgsbonnen |

`.env`: `ZETTLE_CLIENT_ID` (organisations-UUID) + `ZETTLE_API_KEY`.

---

## 5. Adapter — `services/zettleAdapter.js`

Læse-only i alle fire faser. Samme form som `services/smartplanAdapter.js`
(token-cache til udløb, in-memory TTL-cache, credentials fra `.env`, kaster med en
læsbar besked når de mangler).

| Funktion | Endpoint | Bemærkning |
|---|---|---|
| `getAccessToken()` | `POST https://oauth.zettle.com/token` | `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer`, `client_id`, `assertion=<API-nøgle>`. **Ingen OAuth-dans** — API-nøglen er til egen organisation. |
| `getPurchases({from,to})` | `GET https://purchase.izettle.com/purchases/v2` | Paginering via `lastPurchaseHash`. Beløb i **øre, incl moms**. |
| `getFinanceTransactions({from,to})` | `GET https://finance.izettle.com/v2/…` | Udbetalinger + faktiske gebyrer. Præcis sti verificeres i Fase 1. |
| `healthCheck()` | — | Bruges af Settings-panelet (§12). |

**Polling** som `mailService.startPolling()`: hvert `zettle_poll_minutes`, vindue =
dagens forretningsdato + `zettle_resync_days` bagud. Springer stille over når
`zettle_enabled = 0` eller credentials mangler. En fejl må **aldrig** vælte noget andet —
den skrives på `pos_sales_days.last_error` og vises (§12).

> Webhooks (Zettle Pusher) er **fravalgt**. Kurven behøver ikke sekunder, og en webhook
> koster et offentligt endpoint, signaturverifikation og retry-håndtering for ingenting.
> Polling er idempotent i kraft af `purchase_uuid`.

---

## 6. Forretningsdag og event-kobling

### 6.1 Forretningsdag

`zettleBusinessDate(utcIso, cutoff)`: UTC → `Europe/Copenhagen` → træk `cutoff` fra → tag datoen.

> ⚠️ Skal gå gennem projektets egne dato-helpers. `new Date().toISOString().slice(0,10)`
> er UTC og er forbudt (pre-commit-hook, `tests/dato.test.js`). Testen skal **pinne
> tidspunktet** — ellers består den 22 timer i døgnet uanset om koden er rigtig.

### 6.2 Event-kobling: eksplicit tilvalg, ikke gætteri

**Eventet slår Zettle til selv.** Det er ikke systemet der udleder hvilket event et køb
hører til — det er den der opretter eventet der erklærer det:

```sql
ALTER TABLE events ADD COLUMN pos_enabled   INTEGER NOT NULL DEFAULT 0;
ALTER TABLE events ADD COLUMN pos_store_ref TEXT;   -- Zettle-salgssted, NULL = alle
```

- **`pos_enabled = 0` (default): der oprettes ingen POS-salgsbon.** Et event skal aktivt
  vælge det til. En ny feature må ikke begynde at lave bons på gamle events af sig selv.
- Feltet sættes i event-modalen ved siden af `model` og datoerne (§ Fase 2).

**Reglen** for en forretningsdag:

| Antal events med `pos_enabled = 1` der dækker datoen | Handling |
|---|---|
| Præcis 1 | Kobl |
| 2+ | Skil dem ad på `pos_store_ref` (§6.3). Kan de ikke skilles → **utildelt** |
| 0, men der ER POS-salg den dag | **Utildelt** — vises som "POS-salg uden event" |

**Hvorfor det er bedre end datointervallet alene:** erklæringen er billig at give (ét
flueben når eventet oprettes) og fjerner hele gætteklassen. Et forkert gæt ville lægge det
ene events omsætning på det andet — og det ville se helt rigtigt ud. Samtidig kan
butikssalg og private arrangementer aldrig komme til at fabrikere en event-bon.

**Nul-tilfældet er ikke tavshed.** Er der omsat over kassen på en dag hvor intet event har
Zettle slået til, er det næsten altid et flueben nogen glemte. Dagen står som utildelt med
beløb og antal køb, og kan kobles til et event bagefter — så bygges bonnen med det samme.
Det er kernen i §12: en dag må aldrig forsvinde bare fordi vi ikke ved hvor den hører til.

### 6.3 Flere salgssteder (forberedelse)

Zettle understøtter nu flere registrerede salgssteder. I dag bestræber vi os på ikke at
have to events kørende samtidig, så feltet er forberedelse — ikke en funktion vi bruger fra dag ét.

- `events.pos_store_ref` = Zettles identifikator for salgsstedet. `NULL` = "alt POS-salg
  på datoen hører til dette event" (dagens virkelighed).
- Har to samtidige events **hver sit** `pos_store_ref`, fordeles købene pr. salgssted, og
  begge får deres egen bon. Det er hele grunden til at feltet skrives ind nu i stedet for
  at skulle eftermonteres midt i en festival.
- Har to samtidige events ingen (eller samme) `pos_store_ref`, er dagen **utildelt** for
  dem begge. Vi deler ikke omsætning efter et gæt.

> Hvad salgsstedet præcist hedder i købets payload (felt og format) er **ikke antaget her**.
> Det er et af spørgsmålene Fase 1 besvarer mod ægte data (§15). Indtil da er `pos_store_ref`
> en ren tekstkolonne uden fortolkning.

## 7. Produktkobling — tre niveauer

Zettle-produkter har egne UUID'er. `bon_lines.pos_product_id` findes (migration 002) men
er `INTEGER` og har aldrig været brugt — en UUID passer ikke. Koblingen bor derfor i
`raw_json` + en opslagstabel/regel, ikke i den kolonne.

| Niveau | Hvad | Målt resultat (12 mdr, 19 distinkte POS-varer) |
|---|---|---|
| **A1. Eksakt navn** (normaliseret) | `"Fisken"` → `Fisken` | 6/19 varer · **50 % af omsætningen** |
| **A2. Ordsæt** (samme ord, vilkårlig rækkefølge) | `"Slider kartoflen"` → `Kartoflen slider` | 9/19 varer · **65 % af omsætningen** |
| **B. Manuel kobling** | POS-UUID → Grocy-opskrift, gemt pr. UUID | dækker resten |
| **C. Grocy → Zettle push** | Menuen skubbes ud i kassen, vi ejer id'erne | slutmålet |

> ⚠️ **Delstrengs-match er forbudt.** Målt på ægte data giver det **forkerte** match på tre
> varer — hver gang en slider mappet til den fuldstore ret:
>
> | POS-vare | Delstreng finder | Rigtigt |
> |---|---|---|
> | `Slider kartoflen` | `Kartoflen` | `Kartoflen slider` |
> | `Slider     fisken` | `Fisken` | `Fisken Slider` |
> | `Slider Falaflen` | ` Falaflen` | `Falaflen - slider` |
>
> Konsekvensen er ikke kosmetisk: en slider til 55 kr ville få den fuldstore rets kostpris,
> CO₂ og **stykliste** — og dermed forgifte top-up- og retur-forslaget der eksploderer
> salget via Grocy-BOM. Et forkert match er værre end intet match, fordi det ser rigtigt ud.
> **A2 er den yderste grænse for automatik**; alt andet er manuel kobling.

**Manuel kobling (B) skal med i Fase 2**, ikke udskydes: selv med A2 står 35 % af
omsætningen uden kobling, og en tredjedel af det er varer der findes i Grocy under et
andet navn.

**Niveau C er den rigtige løsning på sigt.** Grocy har allerede et **ubrugt**
`sellableZettle`-checkbox-userfield på opskrifter (CLAUDE.md's userfield-tabel). Pusher vi
menuen ud i kassen i stedet for at gætte os tilbage, ejer vi id'erne, og koblingen kan
ikke drive fra hinanden når nogen omdøber en vare. Nøjagtig samme argument som event-broens
`menuFromGrocy`: **én menu-kilde**.

Den er ikke i de fire faser, fordi den er den **første skrivning** mod Zettle og bør vente
til vi kan læse pålideligt. Tages som selvstændig opgave når Fase 1's tal siger at
navnematch ikke rækker.

**Ukoblede varer er lovlige** (§3 pkt. 2): linjen kommer med som omsætning med navn og
pris fra Zettle, `grocy_recipe_id = NULL`, ingen kostpris/CO₂. Løssalg uden produkt
(indtastet beløb i kassen) håndteres samme vej. De listes i `unmatched_json` og vises —
en vare der forsvinder stille er værre end en vare uden kostpris.

---

## 8. Salgsbonnen

Spejler event-broens `BRIDGE_ROLES.sales` ([routes/event-bridge.js:265](../routes/event-bridge.js#L265)):

| Felt | Værdi |
|---|---|
| `event_role` | `sales` |
| `price_category` | `festival` (indstilling) |
| status | `BETALT` |
| `payment_type` | `pos` |
| `event_id` | fra §6 — **nødvendigt** for lager-gaten |
| `is_internal` | 0 |
| `delivery_date` | forretningsdagen |
| linjer | pr. produkt: netto-antal, `unit_price` **incl moms** fra Zettle, `cost_price`/`co2e` snapshottet fra Grocy når der er kobling |

**Reconcile:** fuld-erstat af dagens linjer ved hver polling — samme mønster som broen
(rækkefølge ligegyldig, gen-kørsel harmløs).

**Frys:** kun mens status ∈ `NY, GODKENDT, BETALT`. Fører nogen bonnen videre
(FAKTURERET/AFSLUTTET), rører vi den aldrig igen og rapporterer `frozen`. Derudover
stopper synk af en dag efter `zettle_resync_days`.

**Moms:** Zettle-priser er incl moms og `bon_lines.unit_price` er incl moms (§6b) →
**ingen omregning**. Ingen `* 1.25` nogen steder (pre-commit-hook).

**Afledte effekter, med vilje:**
- **Lager:** `event_id` + `model='light'` + priskategori ≠ produktion ⇒ no-deduct-gaten
  springer trækket over med grund `event_prep_owns_stock`. **Skal testes eksplicit.**
- **Enheder:** `total_units` tæller kun kategorier i `unit_count_categories`. Koblede
  linjer bærer Grocy-kategorien og tæller rigtigt; ukoblede har ingen og tæller ikke.
- **Fakturering:** `payment_type = 'pos'` ⇒ bonnen kommer aldrig i `cf_invoices` og kan
  ikke udløse faktura-vagten (#319).
- **Driftsregnskab:** forretningsdagen ER `delivery_date`, så dagstallene flugter.

---

## 9. Refunderinger, betalingsmidler, kontant

- **Refunderinger** (§3 pkt. 4) nettes ind i dagens aggregat: antal og beløb pr. produkt
  er summen inkl. de negative. Går et produkt i minus, bliver det stående — det er
  virkeligheden (solgt i går, refunderet i dag). `refund_count` vises, så tallet kan
  forklares.
- **Sene refunderinger** er grunden til `zettle_resync_days` (default 3). Uden gen-synk
  ville en refundering dagen efter aldrig nå bonnen.
- **Kontant** kommer med i salgsbonnen (det ER omsætning), men holdes ude af
  bankafstemningen (§10) — pengene ligger i en kasse, ikke på kontoen.
- **Drikkepenge** indgår ikke i vareomsætningen. Behandling fastlægges i Fase 1 hvis de
  overhovedet optræder.

> ⚠️ **Der findes ingen refundering at kigge på.** Fase 1 scannede 12 måneder (646 køb,
> 8 salgsdage): **0** med `refund = true`, **0** med `refunded = true`. Felterne
> (`refund`, `refunded`, `refundsPurchaseUUID`) findes i payloaden, men formatet kan
> **ikke verificeres empirisk** endnu. Håndteringen skal derfor være defensiv, og den
> første ægte refundering skal efterprøves i hånden mod bonnen. Det samme gælder rabatter
> (0 forekomster) og drikkepenge (0 forekomster).

**Ikke alt over kassen er event-omsætning.** Terminalen bruges også til at tage imod
betaling på en faktura — 22. juni 2026 ligger der ét køb på 5.321,25 kr med varenavnet
`Fakture 4087`, og 2. juli ét på 3.500 kr med navnet `Foodtrucken`. En faktura er allerede
bogført i `cf_invoices` og e-conomic; blev den også lavet om til en POS-salgsbon, stod
omsætningen to gange.

Tilvalget pr. event (§6.2) er værnet: de dage havde intet event Zettle slået til, så der
opstår ingen bon — de vises som "POS-salg uden event". **Restrisikoen** er en faktura
betalt over terminalen *midt på en eventdag*. Den kan ikke afvises automatisk uden at
gætte, så Fase 2 nøjes med at gøre den synlig: et køb med én varelinje uden Grocy-kobling
og et beløb langt over dagens gennemsnit markeres i dagens opsummering.

---

## 10. Afstemning mod banken (Fase 3)

Zettle udbetaler **netto** (brutto − gebyr), samlet, typisk med et par dages forsinkelse.
`cf_allocations` (migration 115) kan allerede udtrykke det: én transaktion → flere mål med
beløb, herunder en negativ `fee`-linje. `CLAUDE_PENGESTROEM.md` §2.F.4 beskriver præcis
brutto+gebyr-modellen.

Med Finance API'et bliver to ting bedre:

1. **Faktisk gebyr** i stedet for `event_bridge_fee_pct`-estimatet på 3 %.
2. **Foreslået match**: udbetalingens beløb + dato → kandidat-bankpostering, som office
   godkender.

> ⚠️ **Vigtigst i hele fase 3:** Pengestrøms `create-bon-from-tx` **opretter** i dag en
> salgsbon ud af indbetalingen. Når POS ejer dagens bon, skal den vej i stedet
> **allokere til den eksisterende bon**. Ellers står omsætningen to gange — og det er
> netop den fejlklasse (`project_silent_sideeffect_failures`, #305/#319) hvor tallet ser
> rigtigt ud og ingen opdager det. Den knap skal se at dagen allerede har en POS-bon.

---

## 11. Kurve og timefordeling (Fase 4)

`GET /api/pos/day?date=` → timefordeling (`GROUP BY` time på `pos_purchases`) + top-varer
+ betalingsmiddel-split. Vises på event-detaljen ved siden af P&L-strippen.

Formålet er ikke at kopiere Zettles graf, men at få **ordre-fordeling pr. time** ind i
huset — datagrundlaget for festival-bemanding som `CLAUDE_EVENT.md` §15.3 pkt. 2 har
parkeret indtil vi havde det.

---

## 12. Synlighed — ingen tavse fejl

Bygges **sammen med Fase 2**, ikke bagefter. Huset har en dokumenteret fejlklasse hvor en
bivirkning aldrig fyrer og intet sted opdager det (`project_silent_sideeffect_failures`,
og senest varemodtagelsens webhook der havde stået tavs siden april).

**Settings → Integrationer → Zettle** (samme form som Whiteboard-panelet fra #414):
tændt/slukket, credentials fundet, sidste vellykkede synk, sidste fejl, antal utildelte
dage, antal ukoblede POS-varer, "synk nu"-knap.

Kravene:
- En dag der ikke kunne kobles til et event **forsvinder ikke** — den står som utildelt
  med beløb og antal køb ("POS-salg uden event"), og kan kobles bagefter. Det er typisk
  et glemt flueben på eventet, og det skal kunne ses frem for at gættes.
- En POS-vare uden Grocy-kobling **droppes ikke** — den bliver til en linje og listes.
- En synk der fejler **skriver fejlen et sted et menneske ser den**.

---

## 13. Tests

| Hvad | Hvordan |
|---|---|
| Adapter | Optagne payloads i `tests/fixtures/zettle/` (som `tests/fixtures/lobo/`). Ingen netværk i testen. |
| Forretningsdag | **Pinnet klokkeslæt** (som `tests/dato.test.js`): 23:59, 00:30, 03:59, 04:01, sommer/vintertid. |
| Aggregering | Ren funktion: refundering nettes, ukoblet vare kommer med, løssalg, rabat. |
| Event-kobling | Kun `pos_enabled = 1` kobles · 1 træffer → koblet · 0 → utildelt ("POS-salg uden event") · 2+ skilles på `pos_store_ref`, ellers utildelt · at et event **uden** tilvalg aldrig får en bon. |
| Bon-livscyklus | opret → reconcile → frys ved FAKTURERET · ejerskab: rører aldrig andres bons. |
| Lager | POS-salgsbon på let event trækker **ikke**. |
| Moms | Total incl moms uændret gennem hele kæden (`moms_audit_e2e`-mønstret). |

Alt **mutations-testes**: rul hver kerneregel tilbage og bekræft at en navngiven assert
falder. En test der består af den forkerte grund er værre end ingen test.

---

## 14. Faser

### Fase 1 — Adapter + verifikation (ingen bons)
`services/zettleAdapter.js` + et read-only endpoint/script der henter en afholdt
event-dag og lægger den ved siden af Zettles egen rapport. **Skriver ingenting til bons.**

Måler det vi ikke kan gætte: refunderingernes format, betalingsmiddel-koder, hvor mange
varer der matcher Grocy på navn, om løssalg optræder, hvordan rabatter ligger, hvad
Finance API'et faktisk giver, rate limits, hvor langt tilbage historikken rækker.

**Afslutningskriterium:** Zettles rapport for en dag kan genskabes fra vores tal.

### Fase 2 — Salgsbon pr. event-dag
Migration (§4), forretningsdag (§6), aggregering (§7+§9), bon-livscyklus (§8), polling,
**og synligheden fra §12**. Kun `sales`. Prep, forecast og lager røres ikke.

### Fase 3 — Faktisk gebyr + bankafstemning
Gebyr fra Finance API erstatter estimatet. Foreslået match af udbetaling → bankpostering.
`create-bon-from-tx` allokerer til den eksisterende POS-bon i stedet for at oprette en ny
(§10 — dobbelttællings-værnet).

### Fase 4 — Kurve + timefordeling
`GET /api/pos/day` + visning på event-detaljen (§11).

---

## 15. Målt mod ægte data (Fase 1, 21. august 2026)

Kørt read-only mod produktionskontoen. Periode: 2025-08-22 → 2026-08-22 (646 køb, 8 salgsdage)
+ festivalen 13.–15. august (512 køb, 73.495 kr).

| # | Spørgsmål | Svar |
|---|---|---|
| 1 | Refunderingernes format | **Ingen stikprøve** — 0 i 12 måneder. Felterne findes; formatet kan ikke verificeres endnu (§9). |
| 2 | MobilePay som eget betalingsmiddel | **Ja.** Observeret: `IZETTLE_CARD`, `MOBILE_PAY`. **Ingen** `CASH`. |
| 3 | Rabatter på linje eller kvittering | Begge felter findes (`purchase.discounts`, `products[].discounts`). **0 forekomster.** |
| 4 | Finance API's gebyr-granularitet | Ikke afprøvet endnu — `READ:FINANCE` er tildelt. Afklares i Fase 3. |
| 5 | Hvor mange POS-varer matcher Grocy | Eksakt **50 %** af omsætningen, ordsæt **65 %**. Delstreng er farligt (§7). |
| 6 | Drikkepenge | **Nej.** 0 forekomster, `customAmountSale` = 0. |
| 7 | Identifikator for salgsstedet | **Ja:** `purchase.site` = `{uuid, displayName, addressLine, postalCode, city, primary}`. I dag ét salgssted ("Primært salgssted"). ⇒ `events.pos_store_ref` = `site.uuid`. |

**Payload-form** (bekræftet):

- **Køb:** `purchaseUUID`, `purchaseNumber`, `timestamp` (`2026-08-14T10:19:45.170+0000`),
  `amount`, `vatAmount`, `currency`, `products[]`, `payments[]`, `discounts[]`, `site`,
  `refund`, `refunded`, `customAmountSale`, `userDisplayName`/`userId`, `gpsCoordinates`.
- **Varelinje:** `name`, `quantity`, `unitPrice`, `productUuid`, `variantUuid`,
  `variantName`, `vatPercentage`, `costPrice`, `sku`, `fromLocationUuid`.
- **Betaling:** `uuid`, `amount`, `type`, `createdAt`.

**Moms:** alt er 25 %, og `brutto ÷ 1,25 = brutto − vatAmount` på kronen (73.495 → 58.796).
Priserne er **incl moms** ⇒ ingen omregning mod `bon_lines.unit_price` (§6b).

**API-detaljer der koster tid at genopdage:**
- `endDate` er **eksklusiv** — `startDate=endDate` giver 0 køb.
- Token holder **7200 sek (2 timer)**. Scopes ligger i JWT-payloadens `scope`, ikke i
  token-svaret (svaret har hverken `scope` eller `token_type`).
- Tildelte scopes: `READ:PURCHASE READ:FINANCE READ:PRODUCT READ:USERINFO WRITE:PRODUCT`.
- Paginering: `lastPurchaseHash`, `limit` op til 1000.

**Volumen:** 8 salgsdage på et år, største dag 230 køb. Polling og lagring af rå køb er
gratis i praksis.

**Døgnskiftet er forsikring, ikke mekanik:** 0 køb før kl. 04 i 12 måneder. Reglen skal
stadig være der (der lukkes sent på festival), men den er endnu aldrig blevet udløst.

### Udestår stadig

- Gebyr-granularitet fra Finance API (Fase 3).
- Første ægte refundering skal efterprøves i hånden mod bonnen.

## 16. Bevidst ikke bygget

- **Butikssalg gennem POS.** Kræver at POS-bons rutes gennem LEVERET for at trække fra
  HQ (`CLAUDE_EVENT.md` §5's fremtidsnote). Væsentligt større, og lager er fravalgt nu.
- **Grocy → Zettle produkt-push** (§7 niveau C). Den første skrivning mod Zettle; egen
  opgave når Fase 1's tal siger den er nødvendig.
- **Webhooks** (Zettle Pusher). Polling er nok og enklere (§5).
- **Lagertræk fra POS.** Prep-bonnen ejer trækket (§3 pkt. 5).
