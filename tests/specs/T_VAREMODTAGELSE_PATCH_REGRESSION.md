# T_VAREMODTAGELSE_PATCH_REGRESSION — Regression-spec for Patch A

> Dokumenterer den runner der verificerer at de 5 fixes fra
> [`PATCH_goods_receipts_critical_fixes.md`](PATCH_goods_receipts_critical_fixes.md)
> forbliver løste over tid.
>
> Suiten kørte 26/26 PASS ved første grønne kørsel (12. maj 2026) og
> bevares som regression-baseline. Den **udvides ikke** — nye cases hører
> hjemme i [`T_VAREMODTAGELSE_FULL.md`](T_VAREMODTAGELSE_FULL.md).
>
> Den oprindelige patch-spec (`PATCH_goods_receipts_critical_fixes.md`)
> indeholder den fulde tekniske dokumentation af hver fix (F26, F30, F31,
> F32, F35) inkl. find/replace-diffs og risikomatrix. Denne spec er
> kort-formen der gør runneren findable.

---

## 1. Formål og afgrænsning

| | |
|--|--|
| **Hvad testes** | At de 5 fixes fra Patch A (F26, F30, F31, F32, F35) forbliver i `routes/goods-receipts.js`. Hver fix har 1-3 dedikerede cases. Suiten er bevidst snæver — den dækker IKKE happy-path, validation-grene udover patch-områderne, temperature/check/deviation-felter, eller partial Grocy-failure. Det er `T_VAREMODTAGELSE_FULL.md`'s ansvar |
| **Hvad testes IKKE** | Alt der ligger uden for patch-områderne. Se _FULL for full coverage |
| **Forhold til _FULL** | Begge runners kan køre uafhængigt. _PATCH_REGRESSION er hurtig sanity-check at patch'en stadig holder. _FULL er bredere validering før release. Cases bruger forskellige supplier_name-præfikser (`T_VAREMOD test` vs `T_VAREMOD_F test`) så cleanup-grænser ikke krydsforurener |
| **Runner** | `tests/scripts/run_T_VAREMODTAGELSE_PATCH_REGRESSION.js` |
| **npm-script** | `npm run test:run-varemod-patch` |

---

## 2. Forudsætninger

| | |
|--|--|
| **Test-DB** | `data/test.db` med kitchen-user PIN 1234 (seedet via migration 011) |
| **Test-server** | `npm run test:server` på port 4322 |
| **Grocy-mutation** | Ingen — tests bruger bogus `grocy_product_id=999999` så `addStock` fejler kontrolleret. Ingen ægte Grocy-state ændres |
| **Hermetisk** | Test-rækker markeres `supplier_name='T_VAREMOD test'` og slettes ved cleanup. Counter snapshot'es ved start og restores |

---

## 3. Test-cases — 26 i alt

### SETUP (4)

| ID | Verifikation |
|----|--------------|
| **T_VAREMOD_SETUP_01** | Settings har `goods_receipt_number_prefix` + `_next` |
| **T_VAREMOD_SETUP_02** | Mindst én aktiv user findes (til F32-test) |
| **T_VAREMOD_SETUP_03** | PIN-login virker, session-cookie modtaget |
| **T_VAREMOD_SETUP_04** | `GET /api/goods-receipts/users` returnerer 200 + array |

### HAPPY (4)

| ID | Verifikation |
|----|--------------|
| **T_VAREMOD_HAPPY_01** | POST returnerer 200 + `id` + `receipt_number` |
| **T_VAREMOD_HAPPY_02** | DB-row har `status='approved'` + samme `receipt_number` |
| **T_VAREMOD_HAPPY_03** | Response indeholder BÅDE `webhook_sent` OG `webhook_dispatched=true` (**F31**) |
| **T_VAREMOD_HAPPY_04** | Items indsat i `goods_receipt_items` med korrekt `product_name` |

### VAL (4)

| ID | Verifikation |
|----|--------------|
| **T_VAREMOD_VAL_01** | Manglende `supplier_name` → 400 |
| **T_VAREMOD_VAL_02** | Manglende både `received_by_name` og `received_by_user_id` → 400 |
| **T_VAREMOD_VAL_03** | Tom `items[]` → 400 |
| **T_VAREMOD_VAL_04** | `items` er ikke et array → 400 |

### NUM (3) — F26

| ID | Verifikation |
|----|--------------|
| **T_VAREMOD_NUM_01** | Counter advancer præcis 1 ved successful POST |
| **T_VAREMOD_NUM_02** | Counter UÆNDRET ved validation-fejl (validation kommer før transaction) |
| **T_VAREMOD_NUM_03** | Counter UÆNDRET hvis items-INSERT fejler (CHECK constraint på `status`-feltet) — **F26's kerne: transaction-wrap ruller counter tilbage** |

### USER (3) — F32

| ID | Verifikation |
|----|--------------|
| **T_VAREMOD_USER_01** | Kun `received_by_user_id` sendt → DB-row har `received_by_name` slået op fra `users.name` (**F32**) |
| **T_VAREMOD_USER_02** | Eksplicit `received_by_name` bruges (lookup overrules ikke) |
| **T_VAREMOD_USER_03** | Ugyldig `received_by_user_id` (FK violation) → 500 + counter UÆNDRET (sammenfletter F26 + F32) |

### DUP (2) — F35

| ID | Verifikation |
|----|--------------|
| **T_VAREMOD_DUP_01** | To items med samme `grocy_product_id` får hver sit unikke `id` i `goods_receipt_items` |
| **T_VAREMOD_DUP_02** | Item A (status=ok, addStock fejler) får `grocy_error` sat. Item B (status=missing, samme pid) forbliver `grocy_error=NULL`. **F35's kerne: før patch ville B have ARVET A's error** |

### PHOTO (3) — F30

| ID | Verifikation |
|----|--------------|
| **T_VAREMOD_PHOTO_01** | `photo_path` peger på ikke-eksisterende temp-fil → DB har NULL (**F30**) |
| **T_VAREMOD_PHOTO_02** | `photo_path` uden `vr-tmp`-prefix bevares som-er |
| **T_VAREMOD_PHOTO_03** | Ingen `photo_path` → DB har NULL |

### LIST/DETAIL (3)

| ID | Verifikation |
|----|--------------|
| **T_VAREMOD_LIST_01** | `GET /?supplier=T_VAREMOD` finder test-receipts |
| **T_VAREMOD_DETAIL_01** | `GET /:id` returnerer receipt + items-array |
| **T_VAREMOD_DETAIL_02** | `GET /:id` for ukendt id → 404 |

---

## 4. Patch-dækningsmatrix

Runneren skriver denne matrix til rapporten ved hver kørsel:

| Finding | Test-cases | Status ved sidste kørsel |
|---------|-----------|--------------------------|
| **F26** (transaction rollback) | NUM_01-03, USER_03 | ✓ (12. maj 2026) |
| **F30** (null photo_path) | PHOTO_01-03 | ✓ |
| **F31** (webhook_dispatched) | HAPPY_03 | ✓ |
| **F32** (users-lookup) | USER_01-03 | ✓ |
| **F35** (UPDATE på item.id) | DUP_01-02 | ✓ |

---

## 5. Fejlsignaler

Hvis suiten begynder at fejle på en patch-fix, er det højst sandsynligt
en regression. Konkrete fortolkninger:

| Fejlende case | Sandsynlig årsag |
|---------------|------------------|
| HAPPY_03 | `webhook_dispatched`-feltet fjernet fra response |
| NUM_03 + USER_03 begge | Transaction-wrap fjernet — `nextReceiptNumber()` kommet tilbage som standalone funktion |
| USER_01 | Users-table-lookup fjernet før INSERT |
| DUP_02 | UPDATE-statement bruger igen `WHERE receipt_id=? AND grocy_product_id=?` i stedet for `WHERE id=?` |
| PHOTO_01 | `renameSucceeded`-fallback fjernet fra rename-blokken |

---

## 6. Filer

| Fil | Indhold |
|-----|---------|
| [`PATCH_goods_receipts_critical_fixes.md`](PATCH_goods_receipts_critical_fixes.md) | Patch A's tekniske dokumentation (find/replace, risikomatrix, rollback-strategi) |
| `tests/scripts/run_T_VAREMODTAGELSE_PATCH_REGRESSION.js` | Selve runneren |
| `tests/reports/T_VAREMODTAGELSE_YYYY-MM-DD.md` | Rapport (genereres ved hver kørsel) |

---

## 7. Vedligeholdelse

- **Bliver patch'en udvidet** (fx ny fix tilføjet til Patch B): tilføj cases hér med samme præfiks som de eksisterende. Hver fix bør have 1-3 dedikerede cases der dokumenterer både den GAMLE bug og den NYE adfærd.
- **Bliver en fix rullet tilbage** (sjældent): markér de relevante cases som SKIP og dokumentér i `TEST_OBSERVATIONS.md`. Slet dem ikke — vi vil kunne se hvilke fixes der historisk er blevet rullet tilbage.

---

*Oprettet: 12. maj 2026 — som dokumentation for den eksisterende runner.
Runneren er kørt 26/26 PASS før denne spec blev skrevet.*
