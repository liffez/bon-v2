# T_RECIPES — Test-spec for Grocy recipe write-CRUD

> Test-spec for recipe-CRUD-flowet: opret, opdater, slet opskrifter,
> ingrediens-positioner (`recipes_pos`) og underopskrift-relationer (`recipes_nestings`).
> Plus userfields-PUT på opskrifter.
>
> Kontrakt-baseret design — verificerer at vores adapter + routes lever op til Grocy's
> faktiske API-adfærd. Hvis Grocy udskiftes, opdateres kun adapter-laget.

---

## 1. Formål og afgrænsning

| | |
|--|--|
| **Hvad testes** | Recipe-CRUD via vores proxy: `POST/PUT /recipes`, `POST/PUT/DELETE /recipes-pos`, `POST/PUT/DELETE /recipes-nestings`, `PUT /recipes/:id/userfields` |
| **Hvad testes IKKE** | Recipe-designer UI-flow (Playwright, parkeret) — recipe-deletion via vores API (eksisterer ikke; cleanup sker via direkte Grocy-kald) |
| **Forhold til T_STOCK** | T_STOCK rører stock + userfields på products. T_RECIPES rører recipes + recipe-relationer. Helt disjoint produktrum |
| **Kontrakt-baseret** | Test kalder vores proxy-endpoints (`/api/grocy/recipes/*`), aldrig Grocy direkte for hovedaktion — kun for cleanup hvor vi ikke har et endpoint (recipe-delete) |

---

## 2. Forudsætninger

### 2.1 Grocy test-instans

- `grocytest.ristetrug.dk` aktiv
- `default_grocy_location_id = 3` i settings
- Safety-check afviser kørsel hvis aktiv lokation ikke har "test" i URL'en

### 2.2 Test-opskrifter

T_RECIPES opretter sine egne transient test-opskrifter undervejs — ingen fast fixture nødvendig.
**Alle test-opskrifter får navne med præfiks `T_RECIPES_` og rives ned igen i cleanup.**

Til ingrediens-tests genbruger vi et test-produkt fra T_STOCK (pid=87 Affaldsposer — disjoint fra
T_INVENTORY's sandwich-recipe-ingredienser).

### 2.3 Direkte Grocy DELETE (kun til cleanup af recipes)

Vores adapter har ikke `deleteRecipe` — kun `deleteRecipePos` og `deleteRecipeNesting`.
For at rydde op efter `T_RECIPES_CREATE_*`-cases bruger runneren et direkte HTTP DELETE
mod `${GROCY_API_URL}/objects/recipes/${id}` med `GROCY-API-KEY`-header.

Dette er **kun cleanup-infrastruktur** — testens hovedaktion bruger altid vores proxy.
Safety-check har allerede bekræftet at URL'en peger på grocytest.

---

## 3. Strategi: snapshot + mutate + restore/delete

### 3.1 For UPDATE-cases (fixture-recipe der eksisterer)

```
1. snapshot = GET /api/grocy/recipes/raw → find by id
2. ACTION: PUT /api/grocy/recipes/:id { ...muteret }
3. GET → verify mutation
4. RESTORE: PUT /api/grocy/recipes/:id { ...snapshot }
5. GET → verify restored
```

### 3.2 For CREATE → DELETE-cases (orphan-fri)

```
1. POST /api/grocy/recipes { name: 'T_RECIPES_*', ... } → id
2. ASSERT: GET /api/grocy/recipes/raw finder id med korrekte felter
3. CLEANUP: direkte Grocy DELETE /objects/recipes/:id
4. VERIFY CLEANUP: GET /api/grocy/recipes/raw → id er væk
```

### 3.3 For POSITIONS/NESTINGS (CRUD inden i testen — klean)

```
1. POST /api/grocy/recipes-pos → id
2. PUT /api/grocy/recipes-pos/:id { amount: ... }
3. DELETE /api/grocy/recipes-pos/:id  (via vores proxy)
4. VERIFY: GET /api/grocy/recipes-pos/all → id ikke længere til stede
```

Disse cases har ikke brug for direkte Grocy-kald — vi har DELETE-endpoints.

---

## 4. Test-cases

### 4.1 SETUP-cases

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_RECIPES_SETUP_01** | GET endpoints svarer | `/recipes/raw`, `/recipes-pos/all`, `/recipes-nestings` alle returnerer 200 + array |
| **T_RECIPES_SETUP_02** | Direkte Grocy DELETE virker | Opret kanarie-opskrift via vores POST, slet via direkte Grocy DELETE, verificer den er væk. Hvis DELETE returnerer 4xx, runner aborter |
| **T_RECIPES_SETUP_03** | Test-produkt eksisterer | pid=87 Affaldsposer er aktiv |

### 4.2 CREATE recipe

| ID | Action | Forventet |
|----|--------|-----------|
| **T_RECIPES_CREATE_01** | `POST /recipes { name: 'T_RECIPES_CREATE_01_<ts>', base_servings: 1, type: 'normal' }` | Status 200, response har `created_object_id` (Grocy konvention). GET viser opskriften med matching navn |
| **T_RECIPES_CREATE_02** | `POST` med userfields i samme payload | Userfields gemmes hvis Grocy understøtter det — eller verificer at en separat `PUT /recipes/:id/userfields` skal til |

Begge cleanup'es via direkte Grocy DELETE.

### 4.3 UPDATE recipe

Opretter først en frisk test-opskrift, opdaterer den, verificerer, sletter den.

| ID | Action | Forventet |
|----|--------|-----------|
| **T_RECIPES_UPDATE_01** | Opret recipe → PUT med ny `name` + `description` → GET | Felterne er opdateret. Andre felter uændret |
| **T_RECIPES_UPDATE_02** | Opret recipe → PUT med ny `base_servings` | base_servings er ændret |
| **T_RECIPES_USERFIELDS_01** | Opret recipe → PUT `/recipes/:id/userfields { sellable: '1', grupper: '99 T_RECIPES_TEST' }` → GET | Userfields matcher |

Alle cleanup'es via direkte Grocy DELETE.

### 4.4 RECIPE POSITIONS (ingredienser) CRUD

Opretter test-recipe + bruger pid=87 som ingrediens.

| ID | Action | Forventet |
|----|--------|-----------|
| **T_RECIPES_POS_01** | `POST /recipes-pos { recipe_id, product_id: 87, amount: 5, qu_id: 8 }` | Status 200, response har id. GET `/recipes-pos/all` indeholder den |
| **T_RECIPES_POS_02** | `PUT /recipes-pos/:id { amount: 10 }` | GET viser amount=10 |
| **T_RECIPES_POS_03** | `DELETE /recipes-pos/:id` | GET viser den er væk |
| **T_RECIPES_POS_04** | `DELETE /recipes-pos/999999999` (ikke-eksisterende) | Returnerer 4xx eller silent 200 — dokumentér Grocys adfærd (negativ test) |

**Observation fra første kørsel (11. maj 2026):** `DELETE /recipes-pos/999999999` returnerer **status 500** (ikke 404). Vores adapter `grocyDelete()` propagerer Grocys interne 500-svar — den ikke-eksisterende id behandles som en generisk Grocy-fejl. Det er accepteret nuværende adfærd; hvis det skal forbedres, bør adapteren mappe 500'er der indeholder "not found" til 404. Ikke kritisk for v1-cutover. Logged som #002 i `docs/TEST_OBSERVATIONS.md`.

### 4.4b RECIPE POSITIONS — flere felter

`recipes_pos`-bordet har felter ud over `amount` som vores UI bruger:
`ingredient_group`, `note`, `variable_amount`, `qu_id`. Disse felter testes også.

| ID | Action | Forventet |
|----|--------|-----------|
| **T_RECIPES_POS_05** | `PUT /recipes-pos/:id { ingredient_group: 'Hovedingrediens', note: 'Test note', variable_amount: '0.5*portions' }` | Alle tre felter persisterer og kan læses tilbage |
| **T_RECIPES_POS_06** | `PUT /recipes-pos/:id { qu_id: <anden qu> }` | qu_id er ændret |

Test-recipe slettes til sidst via direkte Grocy DELETE.

### 4.5 RECIPE NESTINGS (underopskrifter) CRUD

Opretter to test-recipes (A og B) → link B som nesting i A.

| ID | Action | Forventet |
|----|--------|-----------|
| **T_RECIPES_NEST_01** | `POST /recipes-nestings { recipe_id: A, includes_recipe_id: B, servings: 0.5 }` | Status 200, response har id |
| **T_RECIPES_NEST_02** | `PUT /recipes-nestings/:id { servings: 1.0 }` | GET viser servings=1.0 |
| **T_RECIPES_NEST_03** | `DELETE /recipes-nestings/:id` | GET viser den er væk |

Begge test-recipes slettes til sidst via direkte Grocy DELETE.

### 4.6 CASCADE — recipe-delete med relaterede positioner/nestings

Verificerer hvad der sker med `recipes_pos` og `recipes_nestings` når selve
opskriften slettes via direkte Grocy DELETE (det er sådan brugeren ville gøre det
manuelt via Grocy UI'en, og det driver vores cleanup).

| ID | Action | Forventet |
|----|--------|-----------|
| **T_RECIPES_CASCADE_01** | Opret recipe + tilføj position → DELETE recipe (direkte Grocy) → GET `/recipes-pos/all` | Position'en er væk (cascade), ELLER hænger som orphan — dokumentér Grocys adfærd |
| **T_RECIPES_CASCADE_02** | Opret parent + child → opret nesting (child → parent) → DELETE parent → GET `/recipes-nestings` | Nesting'en er væk (cascade), ELLER hænger som orphan — dokumentér Grocys adfærd |

Disse er **observations-tests** — de fejler ikke uanset hvad Grocy gør. Formålet er
at få Grocys adfærd dokumenteret for fremtidige beslutninger (hvis Grocy ikke cascade'r,
bør UI'en advare brugere før de sletter en opskrift med relaterede data).

### 4.7 CLEANUP

| ID | Formål | Forventet |
|----|--------|-----------|
| **T_RECIPES_CLEANUP_01** | Alle T_RECIPES_-opskrifter slettet | GET `/recipes/raw` viser nul opskrifter med navn-præfiks `T_RECIPES_` |

---

## 5. Fejlsignaler og fortolkning

| Faktisk symptom | Sandsynlig årsag |
|-----------------|------------------|
| POST /recipes returnerer 200 men `created_object_id` mangler | Grocy API har ændret response-format. Adapter skal opdateres |
| PUT /recipes/:id returnerer 200 men GET viser uændret data | Cache-invalidering fejler i `services/grocyAdapter.js:222`. Tjek `_cache.delete('recipes')` |
| Direkte Grocy DELETE returnerer 401 | `GROCY_API_KEY` i `.env.test` er forkert eller mangler GROCY-API-KEY-headeren |
| Direkte Grocy DELETE returnerer 404 | Opskriften eksisterer ikke længere (måske allerede slettet) — accept som benign |
| `POST /recipes-pos` returnerer fejl om manglende felt | Tjek påkrævede felter mod Grocy-dokumentation: `recipe_id`, `product_id`, `amount`, `qu_id` |
| Cleanup viser T_RECIPES_-orphans | Tidligere kørsel fejlede før cleanup nåede frem. Kør runneren igen — den genoprydder |

---

## 6. Filer

| Fil | Indhold | Status |
|-----|---------|--------|
| `tests/specs/T_RECIPES.md` | Denne fil | ✅ |
| `tests/scripts/run_T_RECIPES.js` | Test-runner | 🔲 |
| `tests/reports/T_RECIPES_YYYY-MM-DD.md` | Rapport (genereres) | 🔲 |

`run_T_RECIPES.js` tilføjes som npm-script:
```json
"test:run-recipes": "node --env-file=.env.test --experimental-sqlite tests/scripts/run_T_RECIPES.js"
```

---

## 7. Hvis testen passerer — hvad ved vi?

| Tjekket | Konsekvens |
|---------|------------|
| `POST /recipes` opretter opskrift med returneret id | Recipe-designer UI's "Gem som ny"-flow er pålideligt |
| `PUT /recipes/:id` opdaterer felter og GET viser dem | "Gem"-flow er pålideligt |
| Userfields-PUT virker isoleret | Salgsprispriser/categories kan opdateres uden at røre core-recipe-data |
| `recipes_pos` CRUD virker | Ingredienser kan tilføjes/fjernes/justeres i recipe-designer |
| `recipes_nestings` CRUD virker | Underopskrifter (fx "Falaflen" → "Hummus") kan kobles og afkobles |
| `_cache.delete` invalidering virker | Næste GET viser ny data uden manuelt cache-bust |

---

## 8. Næste skridt efter T_RECIPES

| Track | Indhold |
|-------|---------|
| **T_INV_FLAG_01-refaktor** | Lukker den ene SKIP fra T_INVENTORY (kræver fresh bon mellem cases) |
| **T_PURCHASING** | Indkøb-flow (Hørkram-kurv, manuel bestilling, varemodtagelse v3) |

---

## 9. Status — efter udvidet kørsel maj 2026

```
20 PASS · 0 FAIL · 0 SKIP

SETUP    3/3    ✓
CREATE   2/2    ✓  (POST recipes med/uden description, base_servings)
UPDATE   3/3    ✓  (PUT name+description, base_servings, userfields)
POS      6/6    ✓  (POST + PUT amount + DELETE + ghost-id 500 + multi-field + qu_id)
NEST     3/3    ✓  (POST + PUT + DELETE)
CASCADE  2/2    ✓  (observations: orphans efter recipe-delete)
CLEANUP  1/1    ✓  (ingen T_RECIPES_-orphans tilbage)
```

T_RECIPES-tracken er **fuldt grøn**. Alle CRUD-operationer på recipes, recipes_pos
og recipes_nestings via vores proxy fungerer som forventet og er verificeret
end-to-end mod live grocytest.

**Nye observations fra CASCADE-cases** (logged i `docs/TEST_OBSERVATIONS.md`):
- **#003**: Grocy cascade'r IKKE `recipes_pos` ved recipe-delete (orphans)
- **#004**: Grocy cascade'r IKKE `recipes_nestings` ved recipe-delete (orphans)

Begge er medium-prioritet — vigtige at tackle hvis vi nogensinde bygger
recipe-delete-UI eller hvis ingredient-resolver støder på en orphan.

---

*Sidst opdateret: 11. maj 2026 — udvidet kørsel grøn (20/20).*
