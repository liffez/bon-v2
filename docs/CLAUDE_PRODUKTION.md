# CLAUDE_PRODUKTION.md — Produktionsbatch med afvigelse

> Læs CLAUDE.md, bon_v2_datamodel_v2.md og BON_V2_PRINCIPPER.md FØR start.
> Status: **beslutning truffet — afventer mockup-godkendelse før implementerings-spec.**

---

## Problem

RR Produktion-opskrifter (sylt, stegt kylling, falafelmasse o.l.) producerer ~1 kg
mellemprodukt der spænder over flere bonner/dage. På produktionsdagen afviger man tit:
en råvare var sluppet op, man kom for meget i, eller man byttede en vare. Man vil
**ikke** ændre originalopskriften — men lagertrækket bliver forkert hvis det sker efter master.

Afvigelsen hører hjemme på **batchen**, ikke på en bon. (Bekræftet domæneviden.)

---

## Hvad findes allerede

| Findes | Note |
|--------|------|
| Mellemprodukt-lag | RR Produktion + RR produktion Hurtig som Grocy-opskrifter |
| Self-production | Opskrift har "Produces product" → `consume` lægger produktet på lager |
| Forbrugskæde | Menu-opskrift (fx Falaflen) forbruger **produktet**, ikke råvaren → ingen dobbelttælling |
| "Træk fra lager" | Kalder `POST /api/recipes/{id}/consume` |
| Nesting | Delprodukter (fx "ærter udblødt") virker |

---

## Grocy-mekanik (verificeret) — kritisk for ikke at lave kludder

`POST /recipes/{id}/consume` gør **atomisk**: (1) trækker master-råvarer, (2) lægger
"Produces product" på lager som **self-production**, med pris auto-beregnet fra master-kost.

To begrænsninger gør at afvigelser **ikke** kan udtrykkes via dette endpoint:

1. Ingen parameter til at overstyre enkelt-ingrediensers mængde.
2. Alt-eller-intet: blokeres hvis en master-ingrediens ikke er på lager — præcis afvigelses-scenariet.

Self-production-prisen kan **ikke** overstyres på recipe-consume. Den kan kun sættes via
`POST /stock/products/{id}/add` (`price`-parameter).

---

## Beslutning: én vej, diff = 0 er det trivielle tilfælde

Brugeren registrerer **diffen** mod opskriften (+/− mængder, udeladte, byttede, nye varer).
Eksekvering materialiserer den endelige liste og kører den **manuelt** — aldrig recipe-consume
ved afvigelse, og aldrig begge veje på samme batch.

```
endelig_liste = master ± diff          // diff = 0  →  endelig_liste = master

for hver linje (actual > 0):
    POST /stock/products/{id}/consume   { amount: actual, transaction_type: "consume" }

producér:
    POST /stock/products/{producedId}/add
        { amount: faktisk_yield, transaction_type: "self-production",
          price: faktisk_batch_kost / faktisk_yield }
```

`faktisk_batch_kost = Σ (actual_qty × ingrediensens enhedskost fra Grocy)`, inkl. substitutter.
**Ekskl. moms** (jf. moms-doktrinen). → Grocy's produkt-post bærer den **rigtige** kostpris;
ingen split-brain mellem Bon og Grocy.

> Forkastet: "fudge lager → recipe-consume → korrigér". Ikke-atomisk dans, forbruger den vare
> man netop ikke brugte, og efterlader produkt-prisen forkert i Grocy. Strider mod
> "redesign struktur, lap ikke".

---

## Datamodel (Bon v2 master, immutabel)

```
production_batches
  id PK
  location_id FK
  grocy_recipe_id            -- RR Produktion-opskriften
  grocy_output_product_id    -- mellemproduktet
  portions
  planned_output_qty         -- recipe-yield × portions
  actual_output_qty          -- faktisk yield
  output_unit
  produced_at / produced_by_user_id / notes / created_at

production_batch_consumption
  id PK
  production_batch_id FK
  grocy_product_id
  product_name               -- snapshot
  planned_qty                -- master × portions  (0 = vare ikke i opskrift)
  actual_qty                 -- reelt brugt        (0 = udeladt)
  unit
  deviation_reason           -- null|justeret|udeladt|byttet|tilfoejet|spild
  substitute_for_product_id  -- parrer byt-linjer
  grocy_transaction_id       -- → eksakt tilbageførsel
  unit_cost                  -- ekskl. moms, snapshot fra Grocy
```

Variance = `planned_qty − actual_qty` → gratis til spild/food-cost senere.

---

## Adapter

Ét nyt punkt i `grocyAdapter.js`, så ruten aldrig selv jonglerer transaction_types:

```
produceBatch({ consume: [{productId, amount}], produce: {productId, amount, price} })
  → returnerer { transactions: [{productId, transactionId}], ... }
reverseBatch(batchId) → tilbagefører pr. transaction_id
```

---

## UI — integreret i RR Produktion-opskriftsvisningen

Det er **opskriftsvisningen selv** der får evnen, ikke en separat skærm. En til/fra-knap
**"Juster mængder"** (default fra → ren opskrift). Slået fra: mængder som ren tekst,
ingen diff/handlinger, "Træk fra lager" = normal master-consume. Slået til: redigér-tilstand.

Redigér-operationer: **justér** (stepper), **fjern** (→0, udeladt),
**byt** (sætter original til 0 + opretter parret ny linje), **tilføj vare** (søg Grocy).
Knappen skifter til "Producér batch (N ændringer)" når diff ≠ 0.

**Portioner:**
- 1 portion = **1 kg færdig vare**. Ændring skalerer alt proportionalt: master, redigerede actuals, tilføjede varer og udbytte. Afvigelses-forholdet bevares (udeladt = 0 forbliver 0).
- **Decimal-portioner** skal understøttes (fx 1,3 portion = 1,3 kg).

**Tre vægt-/mængde-begreber holdes adskilt:**
| Felt | Betydning |
|------|-----------|
| Vægt (ingredienser) | Σ ingrediensmængder (input) — skalerer med portioner |
| Færdig vare (planlagt) | producet-mængde = 1000 g × portioner |
| Faktisk udbytte | reelt produceret → bruges som `amount` på self-production add |

**Fremgangsmåde:** opskriftens metode-tekst vises under linjerne (uændret, read-only).

---

## Åbne punkter

| Punkt | Status |
|-------|--------|
| Bekræft `transaction_type: "self-production"` på `/stock/products/{id}/add` i jeres Grocy-version | ⏳ test på grocytest |
| Mockup-godkendelse → implementerings-spec | ⏳ |
| Tilbageførsel-UX (fortryd batch) | ⏳ defineres i spec |
| Enheds-/QU-konvertering ved manuel consume (g vs kg) | ⏳ verificér mod adapter |

---

## Test

Eget testspor: **T_PRODUKTION.md** — fokus på stille datafejl (dobbelttælling, kostpris,
atomicitet, QU-konvertering). R1/R3/R5/R6-findings er blokerende for go-live.
