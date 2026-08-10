# CLAUDE_TILBUD_FLERDAGS.md — Fler-dags-tilbud (#425)

> Ét bilag til kunden, én bon pr. dag ved accept.
> Læs `CLAUDE_TILBUD.md` først (tilbudsmodulets grundmodel).
> **Status: backend færdig og testet ([PR #436](https://github.com/liffez/bon-v2/pull/436), draft). UI mangler.**
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
| `GET /api/quotes/:id` | returnerer nu `days: [...]` og `offer_day_id` på hver linje |
| `PUT /api/quotes/:id/days` | reconcile — send **altid den fulde liste** |
| `POST /api/quotes/:id/convert` | ≥2 dage ⇒ én bon pr. dag; ellers uændret |

`PUT /days` **bevarer id'erne**. En slet-alt-og-indsæt-forfra ville rive linjernes
dag-tilknytning væk (`ON DELETE SET NULL`), så alle dagens varer stille blev til
fælles-varer og dukkede op på hver eneste dag.

Valideres fuldt ud **før** der skrives: dato-format, dublet-datoer, negativ pax.
Et halvt gyldigt payload må ikke efterlade dagene delvist opdaterede.

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

### `createBon()` og NOT NULL-defaults

`delivery_type` og `price_category` er NOT NULL med defaults i skemaet, men et
eksplicit `null` fra koden overskriver defaulten og giver en rå constraint-fejl.
Begge har nu deres skema-default gentaget i koden.

> ⚠️ **Kendt uoverensstemmelse, bevidst ikke rettet her:** `price_category_id`
> defaulter til **catering**, mens tekstfeltet `price_category` bliver **'store'**.
> Tre bons i drift står sådan. At rette det ville ændre priskategorien på web-ordrer
> som en stille bivirkning af en helt anden opgave — egen opgave.

---

## Hvad der mangler

1. **Trin 1** — dags-liste (tilføj/fjern/omarrangér).
   **Arvede felter skal vise tilbuddets værdi som `placeholder`, ikke som udfyldt
   værdi.** Ellers kan man ikke se forskel på "denne dag arver" og "denne dag har
   tilfældigvis samme værdi" — og gemmer man, låses arven fast.
2. **Trin 2** — dag-vælger pr. linje med **"Alle dage" som eksplicit førstevalg**
   (= `offer_day_id: null`). Kun synlig når `days.length > 1`.
3. **Preview + PDF** — dag-overskrifter når `days.length > 1`. Totalen samlet nederst.

**Ét-dags-tilbud skal se ud og opføre sig præcis som i dag.** Det er den regression
der betyder mest, og den er første test i suiten.

---

## Test

`scripts/test-offer-days.js` — **43 asserts** mod de ægte endpoints over HTTP, isoleret
DB i `/tmp`, prod røres ikke.

```bash
node --experimental-sqlite scripts/test-offer-days.js
```

Mutations-testet (alle fanget):

| Mutation | Falder |
|---|---|
| fælles linjer kopieres ikke til hver dag | 4 |
| leveringsprisen lægges på hver dag | 2 |
| dagens egen pax ignoreres | 1 |

---

## Stadig ubesvaret i #425

- **(5) Pris pr. dag** — `offer_price_mode` er i dag total/blok/linje. Skal der være
  en pris pr. dag?
- **(6) PDF** — hvor står totalen: pr. dag, samlet, eller begge?
- **(7) Delvis accept** — kunden vil have dag 1 og 3, ikke dag 2.

Kerneproblemet — ét bilag, N bons ved accept — er løst uden dem.
