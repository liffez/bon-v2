# CLAUDE_INDKOB_FASE_B.md — Indkøb: ting der ikke virker

> Fase A retter regnefejl. Fase C tegner modellen om. **Fase B fjerner de steder
> hvor systemet lyver.**
>
> Ingen af punkterne er arkitektur. Alle er små. Men de er grunden til at man
> holder op med at stole på modulet — og et modul man ikke stoler på, bliver
> omgået i stedet for brugt. Derfor kommer B før C, og gerne parallelt med A.
>
> Grundlag: `../CLAUDE_INDKOB_ASIS.md` §9, §10 og §12.6.
>
> **Note:** et tidligere "Fase B" i planlægningen betød "synkronisér leveringsdatoen
> til Hoka". Den opgave er absorberet i `CLAUDE_INDKOB_FASE_A.md` §4.2 (`_edd`-cookien).
> Der er intet gammelt B at lede efter.

---

## B1 — Funktioner der lover noget de ikke gør

Højeste prioritet. Hver af disse får brugeren til at tro at noget er sket.

### B1.1 — "✓ Merget" merger ikke

**Hvor:** Indstillinger → Tab 4 (Duplikater), `shared/indkob_settings.js`

Knappen sætter kun `status='merged'` i `duplicate_candidates`. Den udfører ikke selve
Grocy-merge. Den faktiske sammenlægning skal ske manuelt i Grocy.

**Rettelse:** omdøb til **"Markér som håndteret"**.

Alternativet — at implementere den rigtige merge — er større, og en ærlig knap slår en halv.
Skriv i tooltip: "Sammenlægningen udføres i Grocy. Dette markerer kun kandidaten som
færdigbehandlet."

### B1.2 — Office har to pills til samme skærm

**Hvor:** `office/index.html`

"Indkøbsliste" og "Bestillinger" mounter samme `initIndkob` med samme interne view
(`indkob-liste`). Navnet "Bestillinger" lover et overblik der ikke findes — det man har
bestilt ligger som en kollapset sektion i bunden af hver leverandørgruppe.

**Rettelse:** omdøb pill'en til **"Bestil"**.

Begrundelse: "Bestil" er en handling, ikke et overblik. Den lover ikke en liste over
afsendte bestillinger, og den bliver derfor ikke forkert når man klikker.

**Giv den samtidig et reelt formål** — sæt `_ibViewMode='order'` (gruppering efter leverandør)
ved mount fra denne pill, og `'combined'` (efter kategori) fra "Indkøbsliste". Så er de to
pills faktisk to indgange til samme liste med hver sit udgangspunkt, i stedet for det samme
to gange. Det kræver ingen ny komponent.

> ✅ **Blev lettere af #477 (18.08.2026).** Der fandtes ingen afmonterings-vej: efterslæbet
> (snapshots, favoritter, leverandørpost) skrev i `contentEl` — som deles af alle office-views —
> sekunder efter at man havde skiftet visning, og overskrev den. Klik på "Leverandører" viste
> derfor indkøbslisten. #477 tilføjede `cleanupIndkob()`, som slipper containeren, og
> `_ibRender()` afbryder nu når komponenten er afmonteret.
>
> Det betyder at der **findes en mount/unmount-livscyklus** at hænge per-pill-tilstanden på.
> Uden den ville `_ibViewMode` sat ved mount blive overskrevet af den forrige instans' efterslæb.
>
> Bemærk desuden at #477's bug hørte hjemme i **B1** efter kriteriet i overskriften: man klikkede
> ét sted og fik noget andet. Den er rettet — men den er et argument for at B ikke er kosmetik.

> Pill'en får sit rigtige indhold i Fase C, hvor "Bestillinger" bliver et ægte view over
> kladder og afsendte ordrer. Omdøbningen her er midlertidig og skal rulles tilbage da.

### B1.3 — Forecast-deeplinket virker ikke

**Hvor:** `office/views/forecast.js`

"✉ Skriv til leverandør" sætter `?supplier_mail=<id>`, men den parameter læses kun af
indkøbsliste-viewet, ikke af Leverandørpost. Knappen åbner bare fanen og beder via toast
brugeren om selv at finde leverandøren.

**Rettelse:** få Leverandørpost (`shared/supplier_inbox.js`) til at læse `supplier_mail`
og forvælge leverandøren.

Er det for stort: fjern knappen og behold kun "📋 Kopiér liste". En knap der ikke gør
noget er værre end ingen knap.

---

> ℹ️ **B1.4 findes ikke længere — den blev løst inden den blev skrevet.** Gruppen i
> indkøbslisten hed "Emballage" og ikke "Serviwet", fordi
> `supplier_grocy_locations.display_name` har eksisteret siden migration 030 men **kun kunne
> sættes med SQL**. #477 tilføjede `PATCH /api/purchasing/suppliers/grocy-locations/:id` og et
> felt i Indkøb → Leverandører. Samme sted holdt leverandørtabellen op med at skrive
> "Lok 2 / Lok 5 / Lok 9" og falder nu tilbage på Grocy-lokationens navn.
>
> Det lukker en af de fire driftsklager fra 6h (ASIS §2: "to Hørkram-blokke") — og det gør
> B2's tema skarpere: det er stadig **skjulte felter**, bare ét færre.

## B2 — Skjulte felter og manglende valg

| # | Hvad | Hvor | Rettelse |
|---|---|---|---|
| B2.1 | `integration_type='form'` er gyldig i backendens CHECK, men mangler i frontend-dropdownen | Indstillinger → Tab 1 | Tilføj værdien til dropdownen, eller fjern den fra CHECK. Vælg det sidste hvis den aldrig har været brugt |
| B2.2 | `api_config_json` findes i skemaet uden UI-felt. Kun 6 af leverandørens felter kan redigeres | Indstillinger → Tab 1 | Enten et tekstfelt (med JSON-validering), eller en kodekommentar: "sættes kun direkte i DB" |
| B2.3 | Health-felt-mismatch: session-tid vises aldrig | Hørkram-tab | Ret feltnavnet, eller fjern visningen |

Bemærk til B2.1: ændres CHECK, skal `suppliers` recreates (SQLite kan ikke ALTER en CHECK).
Se mønstret i `030_purchasing_v2.sql`. Er der ingen rækker med `'form'`, er det trivielt —
tjek først:

```sql
SELECT COUNT(*) FROM suppliers WHERE integration_type = 'form';
```

---

## B3 — Død overflade

Sletning, ikke rettelse. Formålet er at den næste der læser koden ikke bliver ført på vildspor.

| # | Hvad | Hvorfor det er farligt |
|---|---|---|
| B3.1 | `services/hokaAdapter.js` | Indeholder `submitOrder()` + dropsize-tjek der aldrig kaldes. Antyder at systemet selv afgiver ordrer. **Det gør det ikke** — den aktive integration er `routes/horkram.js` |
| B3.2 | `add-missing` / `add-expired` / `add-overdue` i `api.js` | Defineret, aldrig kaldt. Ser ud som den rigtige vej at lægge på listen; den granulære per-produkt-vej bruges i stedet |
| B3.3 | Bon-DB's lokale `shopping_list`-tabel | `orders.js` indsætter eksplicit `null`. Har FK og ser aktiv ud. Indkøbslisten bor 100 % i Grocy |

**B3.3 er ikke en tabel-drop.** `purchase_order_lines.shopping_list_id` peger på den, og A4
fjerner allerede FK'en. Nøjes med en kommentar i skemadokumentationen om at tabellen er død —
en DROP kan tages når Fase C er landet.

Ved sletning: skriv i commit-beskeden hvad der blev fjernet og hvorfor, så det ikke bliver
genopfundet.

---

## Rækkefølge

B1 først — det er dér utrygheden bor. B2 og B3 kan tages løbende.

Ingen af punkterne rører datamodellen, så B kan deployes uafhængigt af A og blokerer ikke
Fase C.

---

## Ikke i Fase B

| | Hvorfor |
|---|---|
| Persistering af udgået-status | Kræver gyldig leveringsdato (A1) først. Fase C |
| Kildefelt på `shopping_list` | Datamodel-ændring. Fase C, ASIS §14 spm. 2 + 8 |
| Leverandør-id i stedet for navn | Ligger som A7 i Fase A — additivt og haster mere |
| "Bestillinger" som ægte view | Fase C. B1.2 er kun en midlertidig omdøbning |

---

*Skrevet august 2026. Grounded i `../CLAUDE_INDKOB_ASIS.md` (udvidet version).*
