# PATCH_grocy_qu_broedrug_v1_cleanup.md

> Patch til Grocy (grocytest + grocycafe) — fjern gammel v1-data på produkt
> "Brød Rug" (pid=1). Konkret: QU-konverteringen `1 Kasse = 10.8 Kilo` er
> forkert og skal slettes.

---

## Baggrund

Brød Rug (pid=1) har følgende QU-konverteringer i Grocy:

| Måleenhed fra | Måleenhed til | Faktor | Korrekt? |
|---|---|---:|---|
| Antal | Kilo | 0,12 | ✓ (120 g pr. stk) |
| Antal | Kasse | 0,0156 | ✓ (1/64) |
| Kasse | Kilo | **10,8** | ✗ **Forkert** |
| Kasse | Antal | 64 | ✓ |
| Kilo | Antal | 8,3333 | ✓ (1/0.12) |
| Kilo | Kasse | 0,0926 | ✓ (1/10.8) |

Den rigtige værdi er **7,68 kg pr. kasse** (= 64 stk × 0,12 kg). Hørkram-katalog
bekræfter: varenr 60097769 "Rugbrødsstykke, 64 x 120 g" → 64 × 120 g = 7,68 kg.

Værdien 10,8 stammer fra Bon v1-æraen (Leif bekræftet, maj 2026) og er aldrig
blevet ryddet op ved migrering.

**Note:** Også omvendt-konverteringen `Kilo → Kasse = 0,0926` er forkert (= 1/10,8).
Den korrekte værdi er 1/7,68 = 0,1302. Begge skal opdateres.

---

## Hvad patch'en gør

To QU-konverterings-rækker for pid=1 skal opdateres:

| ID | Fra | Til | Gammel faktor | Ny faktor |
|---|---|---|---:|---:|
| `<id_1>` | Kasse | Kilo | 10,8 | **7,68** |
| `<id_2>` | Kilo | Kasse | 0,0926 | **0,1302** |

Alternativt kan rækkerne slettes helt — Grocy beregner manglende konverteringer
via transitivitet (Kasse → Antal → Kilo virker også). Sletning er enklere men
gør Grocy lidt langsommere ved kalkulering. **Anbefaling: opdatér frem for at slette.**

---

## To måder at anvende patch'en

### Måde A — Manuel via Grocy-UI (anbefalet for én vare)

1. Log ind på grocytest med admin-konto
2. Gå til `https://grocytest.ristetrug.dk/product/1`
3. Find "Produktspecifikke QU-konverteringer"-tabel
4. Klik blyant-ikonet på rækken `Kasse → Kilo, 10,8`
   → Ret faktor til `7.68`
   → Gem
5. Klik blyant-ikonet på rækken `Kilo → Kasse, 0,0926`
   → Ret faktor til `0.1302`
   → Gem
6. Gentag samme på grocycafe (prod) når patch'en er verificeret

**Estimeret tid:** 2 minutter pr. instans.

### Måde B — Programmatisk via Grocy API

For automatisering (hvis flere produkter skal ryddes op senere):

```bash
# 1. Find begge konverterings-id'er for pid=1
curl -H "GROCY-API-KEY: $GROCY_API_KEY" \
  "https://grocytest.ristetrug.dk/api/objects/quantity_unit_conversions" \
  | jq '.[] | select(.product_id == 1)'

# Output: find row hvor (from_qu_id=Kasse-id, to_qu_id=Kilo-id, factor=10.8) → noter id
#         find row hvor (from_qu_id=Kilo-id, to_qu_id=Kasse-id, factor=0.0926) → noter id

# 2. Opdater Kasse → Kilo (id_1)
curl -X PUT \
  -H "GROCY-API-KEY: $GROCY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"factor": 7.68}' \
  "https://grocytest.ristetrug.dk/api/objects/quantity_unit_conversions/<id_1>"

# 3. Opdater Kilo → Kasse (id_2)
curl -X PUT \
  -H "GROCY-API-KEY: $GROCY_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"factor": 0.1302}' \
  "https://grocytest.ristetrug.dk/api/objects/quantity_unit_conversions/<id_2>"
```

---

## Verificering efter patch

```bash
# 1. Tjek at konverteringerne nu er korrekte
curl -H "GROCY-API-KEY: $GROCY_API_KEY" \
  "https://grocytest.ristetrug.dk/api/objects/quantity_unit_conversions" \
  | jq '.[] | select(.product_id == 1)'

# Forventet output:
# [
#   { "from_qu_id": <Antal>, "to_qu_id": <Kilo>,  "factor": 0.12 },
#   { "from_qu_id": <Antal>, "to_qu_id": <Kasse>, "factor": 0.0156 },
#   { "from_qu_id": <Kasse>, "to_qu_id": <Kilo>,  "factor": 7.68 },   ← rettet
#   { "from_qu_id": <Kasse>, "to_qu_id": <Antal>, "factor": 64 },
#   { "from_qu_id": <Kilo>,  "to_qu_id": <Antal>, "factor": 8.3333 },
#   { "from_qu_id": <Kilo>,  "to_qu_id": <Kasse>, "factor": 0.1302 }  ← rettet
# ]

# 2. Tjek at Bon v2 stadig kan lave consume mod pid=1
# (T_INVENTORY's regression-suite — alle skal fortsat PASSE)
npm run test:reset
npm run test:server &
npm run test:inv
```

---

## Konsekvenser for andre tests

| Test | Forventet effekt |
|------|------------------|
| `T_INV_*` | PASS (consume er pid-baseret, ikke QU-konvertering-baseret. Bør være uændret) |
| `T_STOCK_*` | PASS (samme — rører ikke QU-konvertering) |
| `T_INDKOB_LISTE_*` | PASS (ikke afhængig af QU på pid=1) |
| `T_INDKOB_SETUP_*` | PASS (ikke afhængig) |
| `T_INDKOB_ADMIN_IMP_02b` | **Forudsætter at patch er anvendt** — testen forventer at `supplier_price_per_kg` ≈ 94.80 fra Hørkrams direkte pr.-kg-pris. Hvis adapter fallback'er via QU-konvertering, vil 10,8 give en forkert mellemberegning |

---

## Hvorfor ikke bare slette rækkerne?

Sletning ville også virke fordi Grocy kan udlede konverteringer via transitivitet
(Kasse → Antal × Antal → Kilo = 64 × 0,12 = 7,68). Men:

- Eksplicit konvertering er hurtigere (Grocy cache'r dem)
- Slette-flowet rammer flere kant-cases (cascade, fk-constraints i `recipes_pos`)
- Opdatering bevarer historik hvis en bruger tjekker "hvornår blev det rettet"

Hold derfor til **opdater frem for slet** medmindre du har specifik grund til det modsatte.

---

## Bredere problem: flere v1-rester forventet i Grocy

Brød Rug er sandsynligvis ikke det eneste produkt med v1-rester. F13 i
`T_INDKOB_ADMIN.md` foreslår at batch-prisopdatering også fixer QU-konverteringer
løbende — så vi rydder op gradvist når priser opdateres alligevel.

Indtil F13 er bygget, kan denne patch-fil bruges som skabelon: en kvik manuel
oprydning hvert gang vi støder på et forkert produkt.

---

*Oprettet: maj 2026 — som forberedelse til T_INDKOB_ADMIN. Bekræftet med Leif: 10.8 er gamle v1-data.*
