# CLAUDE_UDLEVERING.md

**Modul:** Udlevering på konto (madbilletter m.m.)
**System:** Bon v2 — Node.js/Express/SQLite, vanilla JS frontend
**Status:** v0.3 — spec til gennemlæsning, ikke implementeret. v0.2 flyttede fakturagrundlaget til en almindelig bon i event-order modulet; v0.3 indfører kontobegrebet (event, firmakonto, intern) og spildregistrering
**Dato:** september 2026

---

## 1. Formål

Ristet Rug udleverer mad på festivaler og events mod fysiske madbilletter, som de frivillige har fået af arrangøren. Der modtages ingen betaling i boden. Afregningen sker bagefter ved faktura til arrangøren.

Modulet skal:

1. registrere hvad der udleveres, af hvem, hvornår og mod hvilken billettype
2. give fysisk sporbarhed mellem den enkelte billet og registreringen i Bon
3. trække på lager, så registrering og lager stemmer
4. danne et fakturagrundlag efter eventets aftale, som kan lægges ved fakturaen som bilag

Modulet er generisk: madbillet er én udleveringstype blandt flere (sponsor, smagsprøve, personale, intern). Samme mekanik kan bruges til kundekonti uden for festivalkontekst.

## 2. Afgrænsning

**Modulet er ikke en betalingsenhed og ikke et salgsregistreringssystem.** Der modtages hverken kort eller kontanter i Bon. Bon registrerer *udlevering* og danner *fakturagrundlag*. Kontant- og kortsalg på eventet håndteres fortsat af Zettle eller arrangørens eget kasseapparat, som allerede vælges på eventet.

Denne grænse er bevidst og skal holdes. Den er en forudsætning for Bon v4-positioneringen om at holde sig uden for SAF-T/POS-regulering.

### Uden for v1

| Emne | Begrundelse |
|---|---|
| Split betaling (billet dækker delvist, rest betales af den frivillige) | Rodet i praksis; udskudt til v2 af opgaven |
| Billetkoder, stregkoder, QR | Billetterne er ens og uden koder. Sporbarhed løses med løbenummer |
| Blandede billettyper på samme registrering | Én registrering = én billettype. Kommer nogen med to typer, laves to registreringer |
| Kontant/kort i Bon | Se afgrænsning ovenfor |

## 3. Grundprincip: registrering og prissætning er adskilt

Registreringen fortæller **hvad der blev udleveret**. Den indeholder ikke det beløb arrangøren skal betale.

Afregningen sker senere ved at anvende eventets afregningsregler på de registrerede udleveringer.

**Begrundelse:**

- Aftalen varierer pr. festival (fuld pris, reduceret pris, fast pris pr. billet, fri kvote og betaling derefter) og ændrer sig ofte sent — nogle gange efter eventet
- Fri kvote kan kun tælles korrekt samlet, og slet ikke offline ude i boden
- Fakturagrundlaget kan genberegnes uden at røre registreringerne
- Personalet i boden skal aldrig kende eller indtaste priser

**Konsekvens, som skal håndhæves i review:** det fakturerede beløb gemmes aldrig på registreringen. Registreringen bærer kun snapshot af listepris og kostpris som reference og til lager-/CO2-opfølgning.

## 4. Begreber

| Begreb | Betydning |
|---|---|
| **Udlevering** | Én registrering: én billettype, ét antal billetter, et sæt varelinjer, ét løbenummer |
| **Billettype** | Fx crewbillet, frivilligbillet, sponsorbillet, morgenmad. Defineres pr. event, har egen afregningsregel og egen kvote |
| **Løbenummer** | Nummer som personalet skriver på de fysiske billetter i stedet for beløbet |
| **Nummerblok** | Interval af løbenumre tildelt en enhed ved vagtstart, så numre kan udstedes offline |
| **Afregningsregel** | Hvordan billetter af en type omregnes til kroner på fakturaen |
| **Konto** | Det som udleveringen posteres på: et event, en firmakonto eller en intern konto. Bærer debitor, afregningsregler og faktureringsrytme |
| **Fakturagrundlag** | Beregnet opgørelse pr. konto og periode, som projiceres over på en bon |

### 4.1 Udleveringstyper

`delivery_kind` styrer hvad registreringen medfører. Selve registreringsflowet er ens.

| Type | Billettype | Løbenummer | Bon | Lagertræk |
|---|---|---|---|---|
| `madbillet` | ja | ja | ja | ja |
| `sponsor` | ja | ja | ja | ja |
| `smagsprove` | nej | ja | valgfrit | ja |
| `personale` | nej | ja | valgfrit | ja |
| `intern` | nej | ja | nej | ja |
| `spild` | nej | ja | nej | ja |

**Om spild:** det hører ikke hjemme på en bon — der er ingen debitor og intet at fakturere. Men det er præcis samme *registreringshandling*: nogen tager noget ud af lageret, og kostprisen skal kunne gøres op. Derfor samme flow og samme tabel, men projektionen går til ingenting i stedet for til en bon. Det er linjen der skal holdes: bonen er en projektion af de udleveringer der har en debitor, ikke selve registreringen.

Spild kræver en årsag, ellers er tallet ubrugeligt: `overproduktion | afbestilt | holdbarhed | kvalitet | uheld | andet`. Uden årsag er det bare en lagerdifference med ekstra trin.

**Afgrænsning mod Whiteboard.** Madspild i køkkenet vejes på en vægt og registreres i Whiteboard, som holder registreringen til Fødevarestyrelsen. Det er en anden måling med et andet formål: kilo blandet affald til egenkontrol og ESG, uden vareidentitet. Spild i dette modul er identificerede varer og portioner med kostpris, registreret hvor de forlader lageret.

De to må ikke blive to konkurrerende steder at registrere det samme:

- Whiteboard ejer den vejede kg-registrering og FVST-dokumentationen. Dette modul opretter ikke et parallelt spild-UI i køkkenet
- Dette modul ejer det varebærende spild — portioner og varer der skal ud af lageret med kostpris
- Kan en vejning i Whiteboard identificere en konkret vare, bør den udløse en `spild`-registrering her i stedet for at blive tastet to steder. Retningen er Whiteboard → Bon, aldrig omvendt
- Rapporteringen samles ét sted, men de to tal lægges ikke sammen: kilo og portioner er ikke samme enhed

## 5. Datamodel

SQLite, i tråd med Bon v2. Feltnavne er forslag; `tenant_id` medtages for v4-parathed hvis det allerede er konventionen i de øvrige v2-tabeller.

### 5.1 `delivery_accounts`

Det udleveringen posteres på. Ét sted for debitor, afregningsrytme og bon-kobling — så modellen holder uanset om det er en festival, en firmakunde eller intern brug.

```sql
CREATE TABLE delivery_accounts (
  id             INTEGER PRIMARY KEY,
  kind           TEXT NOT NULL,          -- event|firma|intern
  event_id       INTEGER REFERENCES events(id),   -- ved kind = event
  customer_id    INTEGER,                -- debitor i CRM, ved kind = firma
  name           TEXT NOT NULL,
  billing_cycle  TEXT NOT NULL DEFAULT 'event',   -- event|maanedlig|kvartal
  active         INTEGER NOT NULL DEFAULT 1,
  opened_at      TEXT NOT NULL,
  closed_at      TEXT
);
```

**I v1 oprettes kun event-konti, automatisk når udlevering aktiveres på et event.** Der er ingen UI til firmakonti endnu, og ingen ekstra arbejde ved at have feltet med. Pointen er at `deliveries` peger på en konto fra dag ét, så frokostordninger og firmakonti senere kan tændes uden migrering.

Forskellen mellem de to rytmer er reelt kun hvornår bonen lukkes: ved `event` lukkes den når eventet er afregnet, ved `maanedlig` ved periodens udløb, hvorefter der åbnes en ny.

### 5.2 `delivery_ticket_types`

Billettyper hører til en konto. Ved firmakonti bruges de typisk ikke.

```sql
CREATE TABLE delivery_ticket_types (
  id                INTEGER PRIMARY KEY,
  account_id        INTEGER NOT NULL REFERENCES delivery_accounts(id),
  name              TEXT NOT NULL,             -- "Crewbillet"
  marking           TEXT,                      -- "gul, stemplet lørdag"
  color             TEXT,                      -- hex, til knapfarve i UI
  sort_order        INTEGER NOT NULL DEFAULT 0,
  active            INTEGER NOT NULL DEFAULT 1,

  -- afregningsregel
  rule_type         TEXT NOT NULL,             -- se 6.1
  discount_pct      REAL,
  fixed_amount      REAL,                      -- kr pr. billet
  free_quota        INTEGER,                   -- antal gratis billetter
  after_quota_rule  TEXT,                      -- regel efter kvoten er brugt
  after_quota_value REAL,

  created_at        TEXT NOT NULL,
  updated_at        TEXT NOT NULL
);
```

Kontoen kan have en standardregel som nye billettyper arver ved oprettelse. Reglen kopieres ind på typen — den nedarves ikke dynamisk, så en senere ændring på kontoen ikke rykker ved allerede aftalte typer.

### 5.3 `delivery_number_blocks`

```sql
CREATE TABLE delivery_number_blocks (
  id           INTEGER PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES delivery_accounts(id),
  device_id    TEXT NOT NULL,        -- stabil id pr. enhed/browserprofil
  prefix       TEXT NOT NULL,        -- fx "RF26-A"
  from_no      INTEGER NOT NULL,
  to_no        INTEGER NOT NULL,
  next_no      INTEGER NOT NULL,     -- serverens sidst kendte
  issued_to    INTEGER REFERENCES users(id),
  issued_at    TEXT NOT NULL,
  closed_at    TEXT
);
```

### 5.4 `deliveries`

```sql
CREATE TABLE deliveries (
  id                 INTEGER PRIMARY KEY,
  account_id         INTEGER NOT NULL REFERENCES delivery_accounts(id),
  ticket_type_id     INTEGER REFERENCES delivery_ticket_types(id),  -- NULL ved spild/intern
  delivery_no        TEXT NOT NULL,            -- "RF26-A-0042"
  ticket_count       INTEGER NOT NULL DEFAULT 1,   -- 0 ved typer uden billet
  delivery_kind      TEXT NOT NULL DEFAULT 'madbillet',  -- se 4.1
  waste_reason       TEXT,                     -- kun ved delivery_kind = 'spild'
  device_id          TEXT NOT NULL,
  user_id            INTEGER REFERENCES users(id),
  registered_at      TEXT NOT NULL,            -- enhedens ur
  received_at        TEXT,                     -- serverens ur ved sync
  status             TEXT NOT NULL DEFAULT 'registered',  -- registered|voided
  void_reason        TEXT,
  voided_by          INTEGER REFERENCES users(id),
  note               TEXT,
  list_total         REAL NOT NULL DEFAULT 0,  -- snapshot, reference
  cost_total         REAL NOT NULL DEFAULT 0,  -- snapshot, reference
  stock_consumed_at  TEXT,                     -- sat når lagertræk er gennemført
  UNIQUE (account_id, delivery_no)
);
```

`UNIQUE (account_id, delivery_no)` er samtidig idempotensnøglen ved sync.

### 5.5 `delivery_lines`

```sql
CREATE TABLE delivery_lines (
  id               INTEGER PRIMARY KEY,
  delivery_id      INTEGER NOT NULL REFERENCES deliveries(id) ON DELETE CASCADE,
  source_type      TEXT NOT NULL,        -- recipe|product|free_text
  source_id        INTEGER,              -- NULL ved free_text
  name_snapshot    TEXT NOT NULL,
  qty              REAL NOT NULL DEFAULT 1,
  unit             TEXT,
  list_unit_price  REAL,
  cost_unit_price  REAL
);
```

Fritekstlinjer genbruger den mekanik der allerede er bygget til boner. De trækker ikke lager.

### 5.6 `delivery_shift_counts`

Afstemning ved vagtafslutning.

```sql
CREATE TABLE delivery_shift_counts (
  id               INTEGER PRIMARY KEY,
  account_id       INTEGER NOT NULL REFERENCES delivery_accounts(id),
  ticket_type_id   INTEGER NOT NULL REFERENCES delivery_ticket_types(id),
  device_id        TEXT NOT NULL,
  counted_tickets  INTEGER NOT NULL,     -- fysisk optalt bunke
  system_tickets   INTEGER NOT NULL,     -- sum af ticket_count i Bon
  diff             INTEGER NOT NULL,
  gaps             TEXT,                 -- ubrugte/manglende numre i blokken
  note             TEXT,
  closed_by        INTEGER REFERENCES users(id),
  closed_at        TEXT NOT NULL
);
```

### 5.7 `settlement_runs` og `settlement_lines`

```sql
CREATE TABLE settlement_runs (
  id           INTEGER PRIMARY KEY,
  account_id   INTEGER NOT NULL REFERENCES delivery_accounts(id),
  period_from  TEXT,
  period_to    TEXT,
  ticket_type_id INTEGER REFERENCES delivery_ticket_types(id),  -- én bon pr. billettype
  bon_id       INTEGER,                          -- bonen i event-order modulet (navn verificeres)
  status       TEXT NOT NULL DEFAULT 'draft',  -- draft|approved|invoiced
  total        REAL NOT NULL DEFAULT 0,
  invoice_ref  TEXT,                            -- e-conomic bilagsnr.
  created_by   INTEGER REFERENCES users(id),
  created_at   TEXT NOT NULL,
  approved_at  TEXT
);

CREATE TABLE settlement_lines (
  id                INTEGER PRIMARY KEY,
  run_id            INTEGER NOT NULL REFERENCES settlement_runs(id) ON DELETE CASCADE,
  ticket_type_id    INTEGER NOT NULL REFERENCES delivery_ticket_types(id),
  tickets_total     INTEGER NOT NULL,
  tickets_free      INTEGER NOT NULL DEFAULT 0,
  tickets_billable  INTEGER NOT NULL,
  rule_snapshot     TEXT NOT NULL,      -- JSON: reglen som den så ud ved beregning
  amount            REAL NOT NULL,
  list_amount       REAL NOT NULL,      -- til sammenligning
  cost_amount       REAL NOT NULL       -- råvareomkostning, også for gratis billetter
);
```

Et draft-run kan genberegnes frit. Et approved run fryses; ændringer kræver nyt run.

## 6. Afregning

### 6.1 Regeltyper

| `rule_type` | Beregning |
|---|---|
| `full_price` | Sum af `list_total` for udleveringerne |
| `discount_pct` | `list_total` minus `discount_pct` |
| `fixed_per_ticket` | `fixed_amount` × antal billetter, uafhængigt af hvad der blev udleveret |
| `free_quota` | De første `free_quota` **billetter** er gratis; resten afregnes efter `after_quota_rule` + `after_quota_value` |

**Kvoten tælles i billetter, ikke i registreringer.** En registrering med 3 billetter bruger 3 af kvoten. Ellers bliver 30 gratis billetter i praksis til langt flere.

Rækkefølge ved kvote: kronologisk efter `registered_at` inden for eventet. Voidede udleveringer tæller ikke med.

### 6.2 Beregning

Deterministisk funktion, `settlementEngine.js`, samme mønster som `forecastEngine.js`:

```
beregnFakturagrundlag(account_id, periode) -> { linjer[], total, advarsler[] }
```

Advarsler skal som minimum dække:

- registreringer der endnu ikke er synkroniseret fra en enhed
- vagter uden gennemført optælling
- optællinger med difference ≠ 0
- billettyper uden afregningsregel
- kvote overskredet på en type hvor `after_quota_rule` mangler

Advarsler blokerer ikke beregningen, men vises på grundlaget og skal kvitteres inden godkendelse.

### 6.3 Bonen er fakturagrundlaget

Fakturagrundlaget er ikke et selvstændigt dokument. Det lever som en **almindelig bon på eventet**, oprettet og opdateret fra event-order modulet på samme måde som event-registreringer sker i dag. En udlevering posterer på bonen, ligesom en Zettle-betaling gør.

- **Én bon pr. billettype.** Det giver samtidig mulighed for forskellige debitorer pr. type uden at modellen skal udvides
- **Bonens linjer er afledte, ikke redigerede.** `settlementEngine.js` er sandheden; bonen er projektionen. Afledte linjer markeres med `source = udlevering`
- **Manuelle linjer må stå side om side** med de afledte (fx aftalt opstartsgebyr) og må aldrig forsvinde ved genberegning
- **Opdatering sker ved sync.** Er der ikke net i boden, opdateres bonen når køen tømmes. Kontoret ser den vokse i realtid via SSE
- **Åben bon kan altid genberegnes fuldt ud** fra registreringerne. Ændrer aftalen sig efter festivalen, rettes reglen og bonen bygges om
- **Faktureret bon låses.** Efterfølgende ændringer sker som en ny bon (efterregulering), ikke som en rettelse i historikken

**Linjegranularitet:** én samlelinje pr. vare pr. billettype — antal, listepris, regeljusteret beløb. Ikke én linje pr. udlevering. 300 linjer på en faktura hjælper ingen; detaljen ligger i bilaget.

Gratis billetter under kvote vises som antal, ikke som værdi.

**Typer uden debitor** (`intern`, `spild`) projiceres ikke til nogen bon. De registreres, trækker lager og indgår i kostopgørelsen — men de har ingen fakturaside og skal ikke kunne komme til at have en.

### 6.4 Bilag

Bonen kan vedhæftes et bilag i PDF og CSV med:

- pr. billettype: antal billetter, heraf gratis, fakturerbare, beløb, anvendt regel i klar tekst
- pr. dag: antal billetter og beløb
- linjeliste: løbenummer, tidspunkt, billettype, antal og udleverede varer

Linjelisten er den eneste reelle dokumentation der findes, når billetterne ikke har koder. Nogle arrangører vil have den, andre vil bare have en total — og en lang bilagsliste kan i sig selv invitere til diskussion. Bilaget genereres derfor altid, men vedhæftes efter et valg på eventet.

## 7. Løbenumre og offline

### 7.1 Nummerblokke

Numre kan ikke udstedes af serveren når nettet er væk. Hver enhed får derfor en blok ved vagtstart, fx `RF26-A-0001` til `RF26-A-0200`. Præfikset indeholder eventkode og enhedsbogstav.

- Blokken hentes og caches ved vagtstart, mens der er net
- Enheden tæller selv op i blokken
- Løber en blok tør uden net: enheden fortsætter i en reserveserie `…-A-R001`, som markeres og flages ved sync
- Huller i nummerrækken er i sig selv et kontroltal og opgøres ved vagtafslutning

### 7.2 Offline-drift

Kravene er lave, netop fordi der ikke er betaling.

**Vagtstart (kræver net):** enheden henter en eventpakke — billettyper, menu, listepriser, kostpriser, nummerblok, brugerliste — og lægger den i IndexedDB.

**Registrering:** skrives lokalt og lægges i en synkø. Bekræftelsesskærmen viser løbenummeret stort, så det kan skrives på billetterne.

**Sync:** `POST /api/udlevering` med hele udleveringen. Idempotent på `(account_id, delivery_no)`; en gentagelse returnerer den eksisterende post frem for at oprette en ny. Kø tømmes automatisk når der er net, og kan tvinges manuelt.

**Synlighed:** vedvarende tæller i UI'et — "12 ikke synkroniseret". Ved vagtafslutning må enheden ikke lukkes med ikke-synkroniserede poster uden en eksplicit advarsel.

**Ure:** både `registered_at` (enhed) og `received_at` (server) gemmes. Kvoteberegningen bruger `registered_at`.

## 8. Lager

Lagertræk sker serverside ved sync, ikke på enheden.

- Linjer med `source_type = recipe` eller `product` trækkes på den Grocy-instans der er knyttet til eventet (typisk traileren)
- `stock_consumed_at` sættes når trækket er bekræftet; fejlede træk lægges i en retry-kø og vises som advarsel på eventet
- Fritekstlinjer trækker ikke lager
- Void efter lagertræk skal lave en modpostering, ikke slette registreringen

Gratis udleveringer trækker lager på lige fod med resten. Det er hele pointen: kostprisen på det der gives væk, bliver synlig i stedet for at forsvinde.

## 9. Brugerflows

### 9.1 Vagtstart

1. Personalet logger ind på enheden
2. Vælger event (kun events med udlevering aktiveret vises)
3. Bon tildeler nummerblok og henter eventpakken
4. Skærm: "Klar — blok A-0001 til A-0200"

### 9.2 Registrering

1. Vælg billettype — store farvede felter øverst, kun typer der er aktive på eventet
2. Vælg menu — 3–5 store knapper, plus fritekstlinje
3. Vælg antal billetter. Default er antallet af hovedretter på bonen og kan overskrives
4. Afslut
5. Kvitteringsskærm viser **løbenummeret stort**: "Skriv A-0042 på billetterne (3 stk.)"
6. Bekræft → tilbage til start, klar til næste

Ingen priser vises nogen steder i dette flow.

### 9.3 Fortryd

Void er tilladt for den registrerende bruger indtil vagten lukkes, og derefter kun for leder-roller. Voidede poster slettes aldrig — nummeret forbliver brugt, og hullet skal kunne forklares.

### 9.4 Vagtafslutning

1. Sync tvinges
2. Pr. billettype: indtast antal fysisk optalte billetter
3. Bon viser system-antal, difference og eventuelle huller i nummerrækken
4. Note ved difference
5. Vagten lukkes; blokken markeres `closed_at`

### 9.5 Kontor

1. Event → fanen Udlevering: registreringer, optællinger, advarsler
2. Dan fakturagrundlag for perioden
3. Gennemgå advarsler, godkend
4. Eksportér bilag og opret fakturaudkast mod e-conomic

## 10. Roller og rettigheder

| Handling | Rolle |
|---|---|
| Registrere udlevering | Eventpersonale |
| Void inden vagten er lukket | Registrerende bruger |
| Void efter vagtlukning | Leder |
| Oprette billettyper og afregningsregler | Leder/kontor |
| Godkende fakturagrundlag | Kontor |

Afregningsregler må ikke kunne ændres fra bodens registreringsflow.

## 11. API-skitse

```
GET  /api/udlevering/konto/:id/pakke         -> eventpakke til offline-cache
POST /api/udlevering/konto/:id/blok          -> tildel nummerblok til device_id
POST /api/udlevering                         -> opret (idempotent på delivery_no)
POST /api/udlevering/:id/void
POST /api/udlevering/konto/:id/optaelling    -> vagtafslutning
GET  /api/udlevering/konto/:id               -> liste, filtre
POST /api/udlevering/konto/:id/afregning     -> draft run
POST /api/afregning/:run_id/godkend
GET  /api/afregning/:run_id/bilag.pdf|.csv
```

Kontoen findes ved event-opslag fra event-siden, så UI'et i v1 stadig arbejder i events; kontoen er blot det stabile omdrejningspunkt bagved.

SSE på eventets udleveringsside, så kontoret kan følge med i realtid — samme mønster som resten af Bon.

## 12. Faser

**Fase 1 — registrering.** Billettyper, nummerblokke, registreringsflow, offline-kø, liste på eventet. Ingen afregning, ingen lager. Kan tages i brug på næste festival med manuel opgørelse.

**Fase 2 — afstemning og lager.** Vagtafslutning med optælling, huller i nummerrækken, Grocy-lagertræk med retry.

**Fase 3 — afregning.** `settlementEngine.js`, projektion til bon pr. billettype i event-order modulet, bilag, e-conomic-udkast.

**Fase 4 (senere).** Firmakonti med månedlig faktureringsrytme (frokostordninger), split betaling, billetter med koder hvis en arrangør ønsker det.

### Bemærkning til TRyeIT

Firmakonto-varianten er den kommercielt interessante. "Udlevering på konto" — kantiner, festivalleverandører, bagerier med firmakunder — er en driftsfunktion egenkontrol-spillerne ikke har, og den kan bygges uden at Bon flytter sig ind på POS-territoriet, fordi der aldrig går penge gennem systemet. Derfor er kontobegrebet med i modellen allerede i v1, selvom kun event-varianten bruges.

Bemærk at medarbejderbetalt frokostordning (firma betaler en del, medarbejderen resten) er samme problem som split betaling og hører til i samme fase. Personalegoder har desuden en skattemæssig side, som revisoren skal tage stilling til — registreringen er den samme, men behandlingen er ikke Bons at afgøre.

## 13. Antagelser der skal verificeres mod koden inden implementering

1. Hvordan event-order modulet opretter og opdaterer boner i dag. **Bekræftet af Leif: modulet holder bonen åben.** Tjek stadig hvordan en Zettle-betaling hæfter sig på den, og om der allerede findes et linje-`source`-begreb
2. Hvordan Whiteboards kommende vægtbaserede madspildsregistrering ser ud, og om den kan identificere en konkret vare — det afgør om Whiteboard skal kunne udløse en `spild`-registrering her
3. Events-tabellens navn og nøgler, og hvor Zettle/kasseapparat-valget ligger i dag
2. Hvilken af de fem salgspriser på `recipes` der skal bruges som listepris, og om den kan variere pr. event
3. Hvilken Grocy-instans der er knyttet til et event, og om koblingen allerede findes
4. Om fritekstlinje-mekanikken fra boner kan genbruges direkte eller skal generaliseres
5. Rollenavne i det eksisterende auth-setup (fem roller)
6. Om `device_id` allerede findes som begreb, eller skal introduceres

## 14. Trufne beslutninger

1. **Debitorer:** én pr. event er nok til v1. Flere løses uden modeludvidelse ved at lave én bon pr. billettype
2. **Enheder:** 1–3 samtidige. Præfiks A/B/C pr. event, blokstørrelse 200
3. **Gratis billetter på bilaget:** antal er nok, ikke værdi
4. **Linjelisten på bilaget:** genereres altid, vedhæftes efter valg på eventet
