# CLAUDE_TILBUD_FLERDAGS.md — Fler-dags-tilbud (#425)

> Ét bilag til kunden, én bon pr. dag ved accept.
> Læs `CLAUDE_TILBUD.md` først (tilbudsmodulets grundmodel).
> **Status: backend + UI færdigt ([PR #436](https://github.com/liffez/bon-v2/pull/436)).**
> Backenden kom først; skrive-vejen til `offer_day_id`, køkken-synligheden,
> SSE-rækkefølgen og `moms_included` blev lukket i en anden runde (se **API →
> rækkefølgen** og **Fælder**), UI'et i en tredje (se **UI**).
> Skrevet 10. august 2026.

---

## Problemet

Et tilbud **er** en `bons`-række med `is_offer = 1` og har derfor præcis **én**
`delivery_date`. Et flerdags-arrangement — tre dages konference med levering hver
dag — kunne kun rummes som **tre separate tilbud**: kunden fik tre PDF'er, ingen
samlet total, og rabat + gyldighedsdato skulle holdes ens i hånden tre steder.
Faldt én dag væk, kunne systemet ikke se at de hørte sammen.

---

## Beslutninger (og hvorfor)

### 1. Event-modulets generator kan IKKE bære konverteringen

Den oprindelige plan var at genbruge `POST /api/events/:id/bons`. **Det holder ikke**,
og det er værd at skrive ned, fordi forslaget virker rigtigt indtil man læser koden:

- Den opretter **én** bon med den dato man giver den — ikke N pr. dag.
  Event-viewet kalder den én gang pr. bon fra en modal
  ([events.js:1582](../office/views/events.js)).
- Den laver **event-bons**: `event_role` er påkrævet (prep/topup/sales/expense),
  priskategorien tvinges til `produktion` eller `festival`, status bliver BETALT
  eller GODKENDT, `delivery_type: 'event'`, `payment_type: 'cash'`
  ([events.js:1126](../routes/events.js)).

En konference med catering skal give **almindelige kundebons**: catering-pris,
leveringsadresse, faktura, plads i faktureringskøen. Presset gennem
event-generatoren ville kunden få festivalpriser på bons markeret som betalt kontant.

**Det der genbruges i stedet er `createBon()`** (`db/helpers.js`) — fra #237, som
allerede var bygget og bruges af web-orders og webhooks.

### 2. Dagene får en tabel, ikke JSON

`offer_block_metadata` bærer allerede pax pr. blok og gemte blokke, og det var
fristende at lægge dagene der. Men en dag bærer en **dato**, og datoer skal kunne
filtreres og joines: *"hvilke tilbud har levering på fredag"* er et rimeligt
spørgsmål, og det kan man ikke stille til en JSON-klump.

### 3. Arv frem for gentagelse

Dagene ligger som regel samme sted med samme antal. Derfor er **kun datoen påkrævet**;
tid, pax og adresse er NULLABLE, og **NULL betyder "brug tilbuddets værdi"** — ikke
"tom". Man skriver kun det der afviger, og ændrer man tilbuddets pax bagefter, følger
alle dage med af sig selv.

### 4. Tilbuddet forbliver et tilbud

Ét-dags-tilbud flipper `is_offer` på sin egen række som hidtil. **Fler-dags gør ikke.**
Tilbuddet bliver liggende med `is_offer = 1` og markeres `offer_status = 'won'`: det er
bilaget kunden sagde ja til, og den aftalte pris, rabatten og gyldigheden skal kunne
slås op bagefter. Bonnerne peger tilbage via `source_quote_id`.

---

## Datamodel (migration 145)

```
offer_days
  id, bon_id → bons(id) ON DELETE CASCADE
  sort_order
  delivery_date        NOT NULL   ← det eneste dagen SKAL have
  delivery_time        NULL = arv
  pickup_time          NULL = arv
  pax                  NULL = arv
  delivery_address_id  NULL = arv
  label, note

bon_lines.offer_day_id → offer_days(id) ON DELETE SET NULL
    NULL = "alle dage", ikke "ingen dag"

bons.source_quote_id → bons(id)
    de N bons → bilaget de kom fra
```

**`NULL = alle dage`** er bevidst: kaffe og emballage går igen hver dag og skal ikke
tastes tre gange for at komme med tre gange. Ved konvertering kopieres en NULL-linje
til hver dagsbon.

**`ON DELETE SET NULL`** er den skånsomme fejl: sletter man en dag, bliver dens linjer
til fælles-linjer i stedet for at forsvinde. Office kan se dem og flytte dem, frem for
at opdage et tab efter at tilbuddet er sendt.

---

## API

| Endpoint | Bemærkning |
|---|---|
| `GET /api/quotes` | hver række har `day_count` (0 = almindeligt ét-dags-tilbud) |
| `GET /api/quotes/:id` | returnerer `days: [...]` og `offer_day_id` på hver linje |
| `PUT /api/quotes/:id/days` | reconcile — send **altid den fulde liste** |
| `PATCH /api/quotes/:id` | `lines[].offer_day_id` — her tildeles dagene |
| `POST /api/quotes/:id/convert` | ≥2 dage ⇒ én bon pr. dag; ellers uændret |

`PUT /days` **bevarer id'erne**. En slet-alt-og-indsæt-forfra ville rive linjernes
dag-tilknytning væk (`ON DELETE SET NULL`), så alle dagens varer stille blev til
fælles-varer og dukkede op på hver eneste dag.

Valideres fuldt ud **før** der skrives: dato-format, dublet-datoer, negativ pax.
Et halvt gyldigt payload må ikke efterlade dagene delvist opdaterede.

### Rækkefølgen er ikke valgfri: dage FØR linjer

Der findes ingen `/lines`-underendpoints på tilbud. Linjerne kommer som et helt
array på `POST /` og `PATCH /:id`, og **PATCH er replace-all** — den sletter alle
linjer og indsætter dem forfra.

Det giver ét kontraktkrav til klienten:

1. `PUT /:id/days` → svaret indeholder dagenes **id'er**
2. `PATCH /:id` med `lines[].offer_day_id` sat til de id'er

Og én fælde: fordi linjerne indsættes forfra, **ejer payloadet dag-tilknytningen**.
En klient der har dage men glemmer feltet, gør i samme åndedrag alle varer til
fælles-varer — de dukker så op på hver eneste dag. Wizarden skal sende `offer_day_id`
med hver gang, også når den er `null`.

`offer_day_id` valideres mod tilbuddets **egne** dage; hele listen tjekkes før der
skrives noget, så et afvist payload ikke efterlader tilbuddet med færre varer end
kunden ser i sit bilag. På `POST /` afvises et sat `offer_day_id` — tilbuddet har
per definition ingen dage endnu — og afvisningen sker før nummerserien trækkes, så
et fejlslagent kald ikke efterlader et tomt tilbud og et brugt T-nummer.

---

## Fælder (fundet undervejs — tred ikke i dem igen)

### `transaction()` kunne ikke indlejres

Et indre `BEGIN` gav *"cannot start a transaction within a transaction"*. Det ramte
hver gang noget wrappede en helper der selv bruger `transaction()` — fx `createBon()`,
som kalder `nextBonNumber()`, der låser nummerserien i sin egen transaktion. **Flere
bons kunne altså ikke oprettes atomisk.**

`db/compat.js` bruger nu SAVEPOINT på indre niveauer, med dybde pr. database-handle
(WeakMap). Ydre rollback tager stadig det hele; indre rollback river ikke den ydre med.

> Ændringen rører systemets mest delte transaktions-helper. Alle transaktions-tunge
> tests blev kørt igennem efter: moms 18, event-menu 42, topup 35, prep-packing 12,
> recipe-factor 8, event-gate 15, event-cancelled 26, subrecipe 16, packing-units 18.

### Leveringsprisen må ikke ganges op

Tilbuddets 800 kr lagt på hver af tre dage bliver 2.400 kr, **uden at nogen har aftalt
det**. Den følger kun første dag; office kan flytte den hvis turen reelt er delt.

### Et vundet fler-dags-tilbud blev hængende i køkkenet

Beslutning 4 har en konsekvens der ikke er til at se fra tilbudsmodulet: `/later`
og `/planning` viste **enhver** `is_offer = 1` uanset `offer_status`. Et ét-dags-tilbud
forsvinder ved konvertering (flaget flippes), men et fler-dags gør ikke — så køkkenet
ville se fire kort for tre dages arbejde, og produktionsplanen ville lægge hele
arrangementet oveni de dagsbons det netop var blevet til. Begge steder ekskluderer nu
`offer_status = 'won'`.

Kalenderen er urørt: den viser tilbud efter status-filteret, og et vundet bilag med
TILBUD-status hører stadig hjemme dér.

### SSE kan ikke rulles tilbage

`createBon()` broadcastede `bon_created` selv, og `convertMultiDay` kalder den inde i
transaktionen. Fejlede dag 3, var dag 1 og 2 allerede annonceret ud i huset — for bons
der aldrig kom til at findes. `createBon()` tager nu `broadcast: false`, og
konverteringen annoncerer selv **efter** commit.

### `moms_included` fulgte ikke med linjen

Kopierings-INSERT'en listede 14 felter uden `moms_included`, så en linje der bevidst lå
EX moms (migration 104) ville blive læst som INCL i dagsbonnen. Ét-dags-stien flipper
bare et flag og beholder alt — de to veje skal ligne hinanden.

> Rettelsen var først virkningsløs: **`getBonLines()` valgte slet ikke kolonnen**, så
> `l.moms_included` var altid `undefined`. Feltet er nu med i helperen — hvilket
> betyder at enhver anden kalder der kopierer linjer videre, havde samme blinde vinkel.

### `createBon()` og NOT NULL-defaults

`delivery_type` og `price_category` er NOT NULL med defaults i skemaet, men et
eksplicit `null` fra koden overskriver defaulten og giver en rå constraint-fejl.
Begge har nu deres skema-default gentaget i koden.

> ⚠️ **Kendt uoverensstemmelse, bevidst ikke rettet her:** `price_category_id`
> defaulter til **catering**, mens tekstfeltet `price_category` bliver **'store'**.
> Tre bons i drift står sådan. At rette det ville ændre priskategorien på web-ordrer
> som en stille bivirkning af en helt anden opgave — egen opgave.

---

## UI (`office/views/tilbud.js`)

**Tomt `_tDays` = et helt almindeligt ét-dags-tilbud, og så er alt herunder
virkningsløst.** Det er den regression der betyder mest.

### Trin 1 — dagene

Sektionen "Flere dage" ligger under Levering og er tom som udgangspunkt. Første
klik går fra **nul til TO dage**, ikke én: én dag ville se ud som et fler-dags-tilbud
og konvertere som et ét-dags (backenden deler først op ved ≥ 2), og den mellemting
er der ingen grund til at føre nogen ud i. Bliver der alligevel kun én tilbage, står
det som en advarsel i stedet for at være tavst.

Arvede felter vises som **placeholder** — man kan se forskel på "arver tilbuddets
42 pax" og "har tilfældigvis også 42".

**Fjernes en dag med egne varer, spørges der først**, og beskeden siger hvad der
sker: varerne bliver fælles og kommer med på alle dage. `ON DELETE SET NULL` er
skånsom over for dataene, men "skånsom" er kun godt hvis det er synligt.

### Trin 2 — faner, ikke rullemenuer

Man vælger **dag** og fylder på, frem for at vælge dag pr. linje. Det er ikke bare
en pænere flade: en rullemenu pr. række kan kun give varen én dag, og så kan
"40 sandwich dag 1, 30 dag 3" ikke udtrykkes. Med faner er varens identitet
`(id, dagsnøgle)`, og samme ret kan ligge på flere dage med hver sin mængde.

**"Alle dage" er førstevalget** og svarer til `offer_day_id = null`.

Blok-headerens tal følger den valgte dag, så de passer med rækkerne under dem.
Hele blokkens sum på tværs af dage står i pristabellen.

### Fælles varer tælles én gang pr. dag

En fælles vare kopieres til **hver** dagsbon ved konvertering. Talte tilbuddet den
kun én gang, ville vi levere N gange og fakturere for én: 42 kaffe × 2 dage stod
som 1.050 kr på tilbuddet, mens de to bons tilsammen bar 2.100 kr.

Grupperne har derfor en multiplikator (`_tDayGroups().mult`), og fælles-sektionen
hedder "Alle dage · leveres hver dag · × N". Det gælder pristabel, forhåndsvisning,
PDF **og** statistik-striben på trin 2 — alle fire steder ville ellers vise et
lavere tal end kunden betaler.

### Preview og PDF

Dag-overskrifter, dagssubtotal, og **én samlet total nederst**. Dagssubtotalen
følger prismoden på samme måde som blokke og levering: i "kun samlet pris" står
der ét tal, og det er hele pointen med den mode. Dagsopdelingen består —
kunden skal kunne se hvad der kommer hvornår, også uden beløb.

Leveringsboksen og undertitlen viser **hele datospændet** og hver dags tid.
`bons.delivery_date` holdes på dag 1, så begge steder skrev før kun den første dag
— et tre-dages tilbud så øverst ud som et endagsarrangement.

### Gem-rækkefølgen

Dagene har en **lokal nøgle** ved siden af serverens id, så en linje kan pege på en
dag der endnu ikke er gemt. Ved gem: `PUT /days` først, nøglerne oversættes til de
id'er svaret bærer, og først derefter går linjerne af sted. Et nyt tilbud gemmes
i to trin (oprettelse kan ikke bære dage), et eksisterende i ét.

### Konvertering

`_tConvertToBon` spørger før den laver N bons og nævner dagene ved navn — det er
ikke til at fortryde med et klik. Kvitteringen lister bon-numrene.

---

## Test

`scripts/test-offer-days.js` — **59 asserts** mod de ægte endpoints over HTTP, isoleret
DB i `/tmp`, prod røres ikke.

```bash
node --experimental-sqlite scripts/test-offer-days.js
```

Dag-tilknytningen sættes gennem `PATCH /:id`, ikke med rå SQL. Den første udgave af
testen skrev `offer_day_id` direkte i databasen — det beviste at konverteringen
fordelte rigtigt, men ikke at nogen kunne komme til at fordele. Der fandtes i
virkeligheden slet ingen skrive-vej.

Mutations-testet (alle fanget):

| Mutation | Falder |
|---|---|
| fælles linjer kopieres ikke til hver dag | 4 |
| leveringsprisen lægges på hver dag | 2 |
| dagens egen pax ignoreres | 1 |
| `offer_day_id` skrives ikke ved PATCH | 5 |
| køkkenet filtrerer ikke vundne tilbud fra | 1 |
| `moms_included` kopieres ikke | 1 |

Regression efter ændringerne i `db/helpers.js` (delt af hele huset): moms-suiten 37,
event-menu 42, topup 35, prep-packing 12, recipe-factor 8, subrecipe-status 16,
packing-units 18 — alle grønne.

---

## Stadig ubesvaret i #425

- **(5) Pris pr. dag** — `offer_price_mode` er i dag total/blok/linje. Skal der være
  en pris pr. dag? Dagssubtotalen findes nu, men som *visning* der følger den
  valgte mode — ikke som en fjerde mode man kan vælge.
- ~~**(6) PDF** — hvor står totalen?~~ **Besvaret:** dagssubtotal pr. dag når
  tilbuddet i øvrigt viser beløb, og altid én samlet total nederst. Det er den
  sum kunden siger ja til.
- **(7) Delvis accept** — kunden vil have dag 1 og 3, ikke dag 2. Backenden kan det
  allerede: slet dag 2 før konvertering. Fælden er at dag 2's linjer så bliver
  *fælles* og dukker op på både dag 1 og 3 — derfor advarslen i punkt 1 ovenfor.
  Uden den er "skånsom" i praksis "tavs".

Kerneproblemet — ét bilag, N bons ved accept — er løst uden dem.
