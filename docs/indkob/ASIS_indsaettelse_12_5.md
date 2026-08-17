# Indsættelse til `CLAUDE_INDKOB_ASIS.md`

Tre ændringer. Indsæt i rækkefølge.

---

## 1. Nyt afsnit efter §12.4

```markdown
### 12.5 Varemodtagelsen matcher på leverandørens navn — ikke på et id

**Rod:** `_vmBuildItemsFromShoppingList()` bygger varelisten ved at matche Grocys
`shopping_list` på userfields `ordered_supplier` + `ordered_varenr` (§4, §7).
`ordered_supplier` er leverandørens **navn** som fritekst. Det samme gælder
`goods_receipts.supplier_name`, der også er en streng uden FK til `suppliers`.

Leverandørnavnet er frit redigerbart i Indstillinger → Tab 1 (§9).

**Konsekvens ved omdøbning med udestående bestillinger:**
- Varemodtagelsens leverandør-dropdown viser "0 varer klar" for den leverandør
- De bestilte varer lægges aldrig på lager
- `ordered_*` nulstilles aldrig, så linjerne bliver hængende som "bestilt" på
  indkøbslisten og bestilles ikke igen — men de kommer heller aldrig ind
- Der udløses ingen fejl noget sted. Tabet er tavst

Samme problem opstår ved stavevariation mellem leverandørnavnet i `suppliers` og
det navn der blev skrevet i `ordered_supplier` på bestillingstidspunktet — de to
kan divergere uden at nogen opdager det.

**Bemærk rækkefølgen:** dette er også en binding på Fase C. Beslutningen om at
`purchase_order_lines` bliver eneste sandhed om "bestilt", og at `ordered_*`
degraderes til en projektion vi skriver men aldrig læser, kan ikke gennemføres
alene. Varemodtagelsen *læser* `ordered_*` — ikke kun til oprydning, men til at
bygge selve varelisten. De to moduler skal migreres i samme deploy.

> Rettes i `CLAUDE_INDKOB_FASE_A.md` §10 (A7).
```

---

## 2. Omnummerér og udvid det eksisterende afsnit

Ret `### 12.5 Yderligere strukturelle observationer` til `### 12.6`, og tilføj til dets liste:

```markdown
- **Leverandør refereres ved navn tre steder** (`ordered_supplier`,
  `goods_receipts.supplier_name`, matchningen imellem dem) uden FK til `suppliers`.
  Se 12.5.
- **Salgsenheden vælges aldrig af brugeren.** Frontenden sender altid
  `salesUnits[0]`, som ikke er Hokas default. For varer hvor kartonen listes først,
  bestilles der i kartoner uden at nogen har valgt det — og enheden persisteres
  i Grocys `supplier_unit_*`-userfields. Se `CLAUDE_INDKOB_FASE_A.md` §1.1.
- **`ordered_qty` bærer ingen enhed.** Varemodtagelsen sammenligner modtaget mod
  `ordered_qty` uden at vide om tallet tæller kartoner eller poser (§7).
```

---

## 3. Tilføj som spørgsmål 11 i §14

```markdown
11. **Skal leverandør refereres ved id i stedet for navn** i `ordered_supplier` og
    `goods_receipts.supplier_name`, så en omdøbning ikke taber udestående
    bestillinger?
```

Overvej samtidig at slå **spørgsmål 2 og 8 sammen til ét**: uden et kildefelt på
`shopping_list`-linjen kan forecast aldrig skrive til listen forsvarligt, fordi to kørsler
ikke kan skelnes fra hinanden og der intet er at afstemme mod. Med `source` + `source_ref`
bliver et forecast-push idempotent.
