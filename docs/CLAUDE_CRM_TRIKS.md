# CLAUDE_CRM_TRIKS.md
> Spec for nye "top of mind"-triks oven på den eksisterende CRM-suggestions-motor.
> Mål: flere lav-friktions-køer i samme stil som servicelisten — gennemskuelige lister,
> ét-klik-handling, samme servicekald-frame.
>
> Læs FØR du koder: `docs/BON_V2_PRINCIPPER.md`, `docs/CLAUDE_KONTAKTER.md`,
> `routes/crm.js` (`/suggestions`, `/service-calls`, `POST /activity`),
> `office/views/crm-dashboard.js` (`_crmRenderSuggestions`),
> `db/migrations/048_crm_kundeindsigt.sql` (`activity_purposes`, `crm_activities.purpose_id`).
> Oprettet: juni 2026
> Revideret: juni 2026 (se "Revision" nedenfor — den har forrang over build-rækkefølge
> og afhængigheder længere nede i filen).

---

## Revision (juni 2026) — justeringer før build

Specet er gennemgået mod kildekoden. Det meste holder 1:1; nedenstående justeringer
har **forrang** over de tilsvarende afsnit længere nede (særligt "Status" og
"Rækkefølge-anbefaling").

### Faktuelle rettelser (verificeret mod koden)

- **Migrationsnumre:** specet siger "≥ 086" flere steder. Højeste migration er reelt
  `107_reactivation_thresholds.sql` → nye filer skal være **108+**. Princippet (næste
  ledige nummer) holder; tallet var stalet.
- **`companies.founded_date` findes ikke** (bekræftet — ingen migration tilføjer den).
  Fase 4's prerequisite er altså reel, og Fase 4 er **data-gated**: byg ikke
  jubilæums-blokken før (a) CVR-JSON-stien til stiftelsesdato er bekræftet mod et rigtigt
  svar (§4.1b) **og** (b) backfill faktisk producerer brugbar dato for nok firmaer.

### Designjusteringer der skal med

1. **Feed-budget i stedet for 6-per-type.** Med 5 eksisterende blokke + review +
   anniversary (+ evt. cold_offer) à `LIMIT 6` kan suggestions-feeden vokse til 30-40 kort
   og miste sin "top of mind"-kvalitet. Indfør et **globalt loft** (fx max ~10 kort på
   tværs af typer): hver generator afleverer sine bedste, og et samlet rangeringstrin
   (`priority` + sekundær sortering, fx nyeste/højeste værdi) skærer feeden ned. Triks der
   er "arbejd-en-liste-igennem"-opgaver (sæson, rytme, re-aktivering) bliver i deres
   dedikerede views — feeden er kun digest.

2. **ÉN delt arbejdsliste-komponent — IKKE klon af `crm-reaktivering.js` tre gange.**
   Fase 2, Fase 3 og det eksisterende re-aktiverings-view er strukturelt identiske
   (kort + log-formular + `ListCampaignSelect` + "opret kampagne af listen"). Byg en
   `shared/crm_worklist.js` parametriseret med
   `{ endpoint, contextName, openerFn, purposeKey, campaignType, toolbarExtras? }`.
   Kun opener-tekst, endpoint og purpose varierer. Passer husstilen (delte komponenter:
   `mail_thread`, `flag_strip`, `list_campaign_select`). **Byg denne FØR Fase 2/3**, så
   listerne arver den. (Re-aktiverings-viewet kan refaktoreres oven på den bagefter, men
   det er ikke et krav for at komme videre.)

3. **Snooze, ikke kun dedupe.** I dag forsvinder et kort kun ved at logge handlingen
   eller når tidsvinduet udløber — der er ingen "ikke nu / ikke relevant" uden at *lyve*
   om at have handlet. Tilføj en let `crm_suggestion_dismissals(customer_id, type, until)`
   (+ et `NOT EXISTS`-led i hver blok). Generisk gevinst for ALLE triks. Byg sammen med
   komponenten i punkt 2.

4. **Mål om trikket virker.** "Spurgt om anbefaling" / "lykønsket" logges, men
   forretningsværdien er udfaldet (kom der en anmeldelse? konverterede henvisningen?).
   Tillad et resultat/sentiment på den loggede aktivitet (genbrug `result`/`sentiment` på
   `crm_activities`) så vi senere kan se om trikket er værd at beholde. Lav indsats.

5. **`GROUP BY a.company_id` → vælg en kunde MED telefon (gør det nu, ikke v2).**
   Et jubilæumskort uden telefonnummer er et dødt kort. Erstat den vilkårlige
   kunde-række (§4.2) med en korreleret subselect der foretrækker kunde med telefon og
   helst seneste-ordre-kontakten.

6. **Performance: materialisér rytme-/interval-statistik.** `rytme`/`overdue`-aggregeringen
   (`GROUP BY customer_id HAVING COUNT(*)>=5` over hele `bons`) er et fuldt scan ved hvert
   dashboard-load + SSE-refetch. Fint i dag (~2.900 bons), men hører hjemme i en nattlig
   cache ved siden af `rfm_scores` (`services/rfm.js`), ikke i request-pathen. Ikke en
   blocker for v1, men byg blokkene så de kan læse fra en cache-tabel senere uden omskrivning.

7. **Consent — BESLUTTET (juni 2026).** Review-ask (Fase 1) springer `marketing_consent`
   over og respekterer kun `do_not_contact` — forsvarligt, fordi det er service-opfølgning
   pr. telefon til en glad eksisterende kunde. **Jubilæum (Fase 4) SKAL respektere
   `marketing_consent`**: man må ikke skrive "tillykke med jubilæet" til et firma der har
   frabedt sig markedsføring — det er på kanten af markedsføringsloven. Fase 4-blokken
   (§4.2) skal derfor have et `marketing_consent = 1`-led (B2C) ud over `do_not_contact`,
   i modsætning til Fase 1.

8. **Queries: eksplicit inline SQL — men ingen magiske tal.** Byg IKKE en konfig-drevet
   query-motor (en `crm_trik_rules`-tabel der samler SQL dynamisk) — den splitter logikken
   mellem kode og data og bliver uigennemskuelig. Behold hver triks SQL skrevet ud inline
   (som blokkene i `crm.js`). MEN løft tærskler (21 dage, 180 dage, ×1.3, revenue-grænser)
   op som **navngivne konstanter øverst i blokken** (eller settings, som
   `107_reactivation_thresholds` allerede gør for re-aktivering) — aldrig begravet midt i
   `WHERE`-klausulen. Læsbar struktur + justerbare knapper.

### Revideret build-rækkefølge

1. **Fase 1** — uændret, commit-klar, billigst.
2. **Komponent + snooze + outcome** (designpunkt 2-4) — fundament Fase 2/3 arver.
3. **Fase 2 + 3** — nu trivielle oven på den delte komponent + den delte dispatch-udvidelse.
4. **Fase 5** (kold tilbudsopfølgning) — næsten gratis.
5. **Fase 4** — KUN hvis CVR-stien bekræftes, backfill giver data, og consent er afklaret.
   Ellers parkér.

---

## Udgangspunkt — hvad der ALLEREDE findes (læs dette først)

Inden vi bygger noget: store dele af "triks-idéen" er allerede implementeret i
`routes/crm.js` → `GET /suggestions`. Det er afgørende ikke at duplikere det.

| Trik | Status i dag | Hvor |
|------|--------------|------|
| Sæson-gentagelse | **Findes** som suggestion `season_reminder` + briefing-insight. Query'en henter ordrer 10–14 mdr. tilbage uden ordre de sidste 60 dage og uden aktivitet de sidste 30 dage. | `crm.js` §2 i `/suggestions` (linje ~271) + `/briefing` (linje ~181) |
| Faste-rytme / forsinket bestilling | **Findes** som suggestion `overdue_customer` + briefing-insight. Måler `days_since > avg_interval_days × 1.3` for kunder med ≥5 ordrer i stage active/vip. | `crm.js` §1 i `/suggestions` (linje ~213) + `/briefing` (linje ~129) |
| Sovende højværdi | **Findes** som `dormant_highvalue` (revenue > 30.000) + dedikeret Re-aktiverings-view med RFM. | `crm.js` §5 + `office/views/crm-reaktivering.js` |
| Udløbende tilbud | **Findes** som `expiring_offer`. | `crm.js` §4 |
| Nyt ukontaktet lead | **Findes** som `uncontacted_lead`. | `crm.js` §3 |
| **Anbefaling / anmeldelse efter glad kunde** | **Findes IKKE** — intet kigger på positiv stemning og beder om en anmeldelse/henvisning. | — (denne spec, Fase 1) |
| Firma-jubilæum (CVR-stiftelsesdato) | **Findes IKKE** — og stiftelsesdato gemmes ikke i dag (se Fase 4). | — |

**Konsekvens for scope:**
- **Fase 1 (anbefaling)** er det eneste ægte nye i suggestions-feeden. Fuldt specificeret nedenfor.
- **Fase 2–3 (sæson / faste-rytme)** handler om at *forfremme* eksisterende queries fra
  enkelt-kort til en dedikeret liste + kampagne — ikke at skrive ny detektionslogik.
- **Fase 4 (jubilæum)** kræver en prerequisite (gem stiftelsesdato) før der kan bygges noget.

---

## Den fælles mekanik (gælder alle faser)

Et "trik" er altid samme tre dele, så de genbruger den eksisterende infrastruktur:

1. **En detektions-query** der finder de rigtige kunder på det rigtige tidspunkt.
2. **En dedupe-betingelse** så vi ikke spørger/ringer to gange — bygget på
   `NOT EXISTS (... crm_activities ...)`, præcis som `/service-calls` udelukker bons
   der allerede har en `service_call`-aktivitet (`crm.js` linje ~474).
3. **En handling** der logges via `POST /activity` med en `purpose_id` der identificerer
   trikket — så dedupe i punkt 2 kan kigge efter netop den purpose.

`activity_purposes` (migration 048) er opslagstabellen der binder det sammen. Hvert nyt
trik der har sit eget "har vi gjort dette?"-spørgsmål får sin egen purpose-række.

---

## FASE 1 — Anbefaling / anmeldelse efter glad kunde

### Idé

Servicekaldet fanger allerede stemning (`crm_activities.sentiment` = positive/neutral/negative).
Når en kunde lige har sagt at alt var godt, er det det bedste øjeblik at bede om en
Google-anmeldelse eller en henvisning. Det udnytter vi ikke i dag. Triggeren rider 100%
på data der allerede fanges — der skal ingen ny indsamling til.

Frame: omsorg, ikke salg. "Dejligt at høre det smagte — må vi bede dig om en hurtig
anmeldelse?" Det er en naturlig forlængelse af servicekaldet.

### 1.1 Ny purpose (migration)

Næste ledige migrationsnummer (tjek `db/migrations/` — højeste er p.t. `107`, så **108+**):

```sql
-- 108_anbefaling_purpose.sql
INSERT INTO activity_purposes (key, label, emoji, description, is_system, sort_order) VALUES
    ('anbefaling', 'Anbefaling', '⭐', 'Bedt kunde om anmeldelse eller henvisning', 1, 70);
```

Ingen skemaændring — `crm_activities` har allerede `purpose_id` (048) og `sentiment`.

### 1.2 Ny suggestion-blok i `routes/crm.js` → `GET /suggestions`

Tilføj som blok §6, før `suggestions.sort(...)` (linje ~437). Følger nøjagtig samme
objekt-form som de øvrige blokke.

```javascript
// 6. GLAD KUNDE → BED OM ANBEFALING
//    Kunder med en positiv stemning registreret for nylig, som vi endnu ikke har
//    bedt om en anbefaling. Dedupe på purpose 'anbefaling'.
const reviewRows = db.prepare(`
    SELECT
        c.id AS customer_id,
        c.first_name || ' ' || COALESCE(c.last_name, '') AS name,
        c.phone,
        co.name AS company_name,
        a.sentiment,
        a.created_at AS sentiment_at,
        a.text AS last_note
    FROM crm_activities a
    JOIN customers c ON c.id = a.customer_id
    LEFT JOIN companies co ON c.company_id = co.id
    JOIN crm_customer_meta cm ON cm.customer_id = c.id
    WHERE a.sentiment = 'positive'
      AND a.created_at > date('now', '-21 days')
      AND cm.stage IN ('active', 'vip')
      AND co.is_internal = 0
      -- kun den seneste positive stemning pr. kunde
      AND a.id = (
          SELECT a2.id FROM crm_activities a2
          WHERE a2.customer_id = c.id AND a2.sentiment IS NOT NULL
          ORDER BY a2.created_at DESC LIMIT 1
      )
      -- dedupe: ikke allerede bedt om anbefaling de sidste 6 mdr.
      AND NOT EXISTS (
          SELECT 1 FROM crm_activities a3
          JOIN activity_purposes ap ON ap.id = a3.purpose_id
          WHERE a3.customer_id = c.id
            AND ap.key = 'anbefaling'
            AND a3.created_at > date('now', '-180 days')
      )
      -- respektér do_not_contact (men IKKE marketing_consent — dette er
      -- service-opfølgning, ikke markedsføring; jf. consent-doktrinen i campaigns.js)
      AND COALESCE(cm.do_not_contact, 0) != 1
    ORDER BY a.created_at DESC
    LIMIT 6
`).all();

for (const r of reviewRows) {
    suggestions.push({
        type: 'review_ask',
        priority: 2,
        icon: '⭐',
        title: r.name + ' var glad — bed om en anbefaling',
        detail: (r.company_name || '') + ' · positiv ' + (r.sentiment_at || '').substring(0, 10),
        reason: 'Sidste kontakt var positiv' +
            (r.last_note ? ' ("' + r.last_note.substring(0, 60) + '")' : '') +
            '. Godt øjeblik at bede om en Google-anmeldelse eller en henvisning.',
        customer_id: r.customer_id,
        customer_name: r.name,
        company_name: r.company_name,
        phone: r.phone,
        action: 'review',   // styrer knap-rendering i dashboardet
    });
}
```

> **Consent (afklaret):** En anmeldelses-forespørgsel er service-opfølgning, ikke
> markedsføring, så B2C-samtykke-blokeringen (`marketing_consent`) skal IKKE gælde her —
> kun `do_not_contact`. Konventionen er bekræftet mod `routes/campaigns.js`' consent-doktrin,
> hvor netop `crm_customer_meta.do_not_contact` blokerer altid, mens `marketing_consent`
> kun kræves for ren B2C-markedsføring. Derfor filteret `cm.do_not_contact != 1` ovenfor,
> og bevidst INTET `marketing_consent`-krav.

### 1.3 Dashboard — håndtér `action: 'review'`

I `office/views/crm-dashboard.js` → `_crmRenderSuggestions` (linje ~563) rendres i dag
altid en "Ring"- og "Profil"-knap. For `review_ask` vil vi i stedet have en knap der
logger at vi har spurgt (så kortet forsvinder via dedupe).

Tilføj en gren i knap-rendringen:

```javascript
// inde i map'en over suggestions, hvor knapperne bygges:
const actionBtns = s.action === 'review'
    ? (s.phone ? '<a class="crm-sug-btn primary" href="tel:' + s.phone.replace(/\s/g, '') + '">📞 Ring</a>' : '') +
      '<button class="crm-sug-btn" onclick="_crmAskedForReview(' + s.customer_id + ')">⭐ Spurgt</button>'
    : (s.phone ? '<a class="crm-sug-btn primary" href="tel:' + s.phone.replace(/\s/g, '') + '">📞 Ring</a>' : '') +
      '<button class="crm-sug-btn" onclick="_crmOpenKunde(' + s.customer_id + ')">👤 Profil</button>';
```

Ny handler (loggger aktivitet med den nye purpose → kortet forsvinder ved næste
`crm_activity_created`-SSE, som allerede trigger `_crmLoadData`):

```javascript
async function _crmAskedForReview(customerId) {
    try {
        const purposes = await fetchActivityPurposes();
        const p = (purposes || []).find(x => x.key === 'anbefaling');
        await postCrmActivity({
            customer_id: customerId,
            type: 'note',
            text: 'Bedt om anbefaling/anmeldelse',
            purpose_id: p?.id || null,
        });
        // SSE crm_activity_created → _crmDashHandleSSE → _crmLoadData (allerede wired)
    } catch (err) {
        alert('Kunne ikke logge: ' + err.message);
    }
}
```

Ingen nye API-klientfunktioner nødvendige — `fetchActivityPurposes` og `postCrmActivity`
findes allerede (brugt af `crm-reaktivering.js`).

### 1.4 Test (T_CRM_REVIEW)

- `T_CRM_REVIEW_01` — kunde med seneste sentiment=positive < 21 dage, stage active,
  ingen anbefaling-aktivitet → optræder i `/suggestions` som `review_ask`.
- `T_CRM_REVIEW_02` — samme kunde efter `POST /activity` med purpose `anbefaling`
  → forsvinder fra `/suggestions`.
- `T_CRM_REVIEW_03` — kunde hvis seneste sentiment er `neutral` (men havde en ældre
  positiv) → optræder IKKE (vi kigger kun på seneste sentiment).
- `T_CRM_REVIEW_04` — anbefaling-aktivitet for 200 dage siden → kunden optræder igen
  (6-mdr.-vindue udløbet).
- `T_CRM_REVIEW_05` — intern firma (`co.is_internal = 1`) → ekskluderet.

### 1.5 Afgrænsning

- Vi sender ikke selv anmeldelses-links automatisk i Fase 1 — handlingen er manuel
  (ring/mail), og knappen logger blot at det er gjort. Auto-mail kan bygges senere
  oven på mass-mail-infraen (`CLAUDE_OUTREACH_MAIL.md`) hvis det viser sig værd at have.
- Ingen ny visning. Kortene lever i den eksisterende suggestions-panel.

---

## Fælles ændring — udvid `POST /api/campaigns/from-suggestion`

Fase 2 og 3's "opret kampagne af hele listen"-flow genbruger dispatchen i
`routes/campaigns.js`. Den håndterer i dag kun `type: 'dormant'` (linje ~756) og afviser
resten med `unsupported_type`. Vi tilføjer to typer — og **hele consent/DNC/dedup-loopen
(linje ~839–887) genbruges uændret**, fordi den kun kræver at hver kandidat-række har
`customer_id`, `company_id`, `marketing_consent`, `do_not_contact`.

**(a) Udvid type-guarden** (linje ~756):

```javascript
const SUPPORTED_TYPES = ['dormant', 'seasonal', 'rytme'];
if (!SUPPORTED_TYPES.includes(type)) {
    return res.status(400).json({ error: 'unsupported_type',
        message: `kun ${SUPPORTED_TYPES.join(', ')} understøttes` });
}
```

**(b) Gør kandidat-query'en til en `switch` på `type`** (erstatter det faste dormant-SELECT
i trin 2, linje ~784). Hver gren returnerer samme kolonner. Resten af funktionen
(navn-tjek, transaktion, consent-loop, broadcast) er uændret.

```javascript
let candidates;
let defaultDesc;

if (type === 'dormant') {
    const minDays = parseInt(filter?.days_since_last) || 180;
    const minRevenue = parseFloat(filter?.min_total_revenue) || 0;
    candidates = db.prepare(` ...eksisterende dormant-SELECT... `).all(minDays, minRevenue);
    defaultDesc = `Auto-genereret reaktivering · ${minDays}+ dage · min ${Math.round(minRevenue)} kr`;

} else if (type === 'seasonal') {
    // Bestilte på denne tid sidste år, intet de sidste 60 dage. Samme detektion
    // som /suggestions §2 (season_reminder), men returnerer consent-kolonnerne.
    candidates = db.prepare(`
        SELECT c.id AS customer_id, c.company_id,
               cm.marketing_consent, cm.do_not_contact
          FROM customers c
          JOIN bons b1 ON b1.customer_id = c.id
                      AND b1.is_internal = 0 AND (b1.is_offer = 0 OR b1.is_offer IS NULL)
     LEFT JOIN crm_customer_meta cm ON cm.customer_id = c.id
         WHERE c.is_active = 1
           AND b1.delivery_date BETWEEN date('now','-14 months') AND date('now','-10 months')
           AND NOT EXISTS (
               SELECT 1 FROM bons b2
                WHERE b2.customer_id = c.id AND b2.is_internal = 0
                  AND b2.delivery_date > date('now','-60 days')
           )
      GROUP BY c.id
    `).all();
    defaultDesc = 'Sæson-gentagelse · bestilte på denne tid sidste år';

} else { // rytme
    // Fast rytme (≥5 ordrer), forsinket ift. eget snit — men ikke så længe væk at
    // de er reelt sovende (det dækker dormant-typen).
    const mult = parseFloat(filter?.interval_multiplier) || 1.3;
    candidates = db.prepare(`
        SELECT c.id AS customer_id, c.company_id,
               cm.marketing_consent, cm.do_not_contact
          FROM customers c
     LEFT JOIN crm_customer_meta cm ON cm.customer_id = c.id
          JOIN (
              SELECT b1.customer_id,
                     CAST(julianday('now') - julianday(MAX(b1.delivery_date)) AS INTEGER) AS days_since,
                     ROUND(CAST(julianday(MAX(b1.delivery_date)) - julianday(MIN(b1.delivery_date)) AS REAL)
                           / NULLIF(COUNT(*)-1, 0), 0) AS avg_interval
                FROM bons b1
               WHERE b1.is_internal = 0 AND (b1.is_offer = 0 OR b1.is_offer IS NULL)
            GROUP BY b1.customer_id
              HAVING COUNT(*) >= 5
          ) o ON o.customer_id = c.id
         WHERE c.is_active = 1
           AND o.avg_interval > 0
           AND o.days_since > o.avg_interval * ?
           AND o.days_since < o.avg_interval * 3   -- øvre grænse → ellers er det dormant
    `).all(mult);
    defaultDesc = `Faste-rytme-nudge · forsinket >${mult}× eget bestillingssnit`;
}
```

…og brug `defaultDesc` i `INSERT INTO outreach_campaigns` i stedet for den hårdkodede
dormant-tekst (linje ~816).

> **Overlap dormant ↔ rytme:** den øvre grænse `days_since < avg_interval × 3` holder
> reelt sovende kunder ude af rytme-typen, så de to generatorer ikke kæmper om de samme
> kunder. Juster tallet hvis I oplever overlap.

Det er hele backend-arbejdet for kampagne-flowet i Fase 2 og 3.
`tests/campaigns_from_suggestion.test.js` har allerede dormant-dækning — tilføj
`seasonal`- og `rytme`-cases med samme mønster (kandidater ind → consent/DNC/dedup ud).

---

## FASE 2 — Sæson-liste (forfremmelse af `season_reminder`)

**Findes allerede:** detektions-query'en i `/suggestions` §2 + `/briefing`. Kampagne-flowet
er nu dækket af dispatch-udvidelsen ovenfor (`type: 'seasonal'`).

**Det der mangler** er en gennemskuelig liste man kan arbejde sig igennem (som
Re-aktivering), i stedet for max 8 kort blandet ind i suggestions-feeden.

### 2.1 Nyt list-endpoint `GET /api/crm/season`

Genbrug §2-query'en uden `LIMIT 8`, og tag `pax`/`total_price` fra sidste års ordre med så
viewet kan bygge en opener. Dedupe på "ingen aktivitet de sidste 30 dage" (§2 gør det
allerede via et `NOT EXISTS crm_activities`-led) — så når man har ringet, falder kunden af
listen i en måned. Ingen ny purpose nødvendig; `saesonoutreach` findes i 048 og bruges når
kaldet logges.

### 2.2 Nyt view `office/views/crm-saeson.js`

Klon af `crm-reaktivering.js`:
- Samme kort + log-formular (resultat + stemning + note).
- Auto-opener fra sidste års ordre (samme idé som `_reakBuildOpener`):
  *"Sidste år bestilte I {pax} pax d. {dato} — skal vi holde datoen igen i år?"*
- Ring-og-log via `postCrmActivity` med `purpose_id` for `saesonoutreach`.
- `ListCampaignSelect.attach({ contextName: 'Sæson', rowSelector: '.saeson-card',
  getEntityFromRow, suggestedCampaignName: () => 'Sæson ' + <måned> + ' ' + <år> })`
  → cherry-pick gratis (se `shared/list_campaign_select.js`).
- "Opret kampagne af hele listen"-knap →
  `createCampaignFromSuggestion({ type: 'seasonal', campaign_name })`.

> **Sidenote:** `services/rfm.js` → `computeIcpProfile` returnerer allerede `peak_months`.
> Ikke nødvendigt for Fase 2, men kan på sigt vise "din sæson topper i nov/dec".

### 2.3 Test (T_CRM_SEASON)
- Endpoint returnerer kunder i 10–14 mdr.-vinduet uden ordre de sidste 60 dage.
- Kunde med aktivitet < 30 dage siden ekskluderes.
- `from-suggestion`-cases dækkes af den fælles test.

---

## FASE 3 — Faste-rytme-liste (forfremmelse af `overdue_customer`)

**Findes allerede:** `/suggestions` §1 + `/briefing` (`days_since > avg_interval × 1.3`).
Kampagne-flowet er dækket af dispatch-udvidelsen (`type: 'rytme'`).

**Det der mangler:** dedikeret liste som Fase 2. Udspillet er et andet end sæson/dormant:
*"skal vi sætte den faste levering op, så I ikke skal huske at bestille?"* → peg mod en
stående aftale.

### 3.1 Nyt list-endpoint `GET /api/crm/rytme`

Samme query som §1 (overdue) uden `LIMIT`, med en justerbar `?multiplier=`-param
(1.3 / 1.5 / 2.0) + den øvre grænse `× 3` så reelt sovende falder til dormant-flowet.

### 3.2 Nyt view `office/views/crm-rytme.js`

Klon af `crm-reaktivering.js`. Opener: *"I plejer at bestille ca. hver {avg_interval}
dage — det er nu {days_since} dage siden. Skal vi sætte en fast levering op?"*. Log med
purpose `opfoelgning` (eller en ny `fast_rytme`-purpose hvis I vil have ren rapportering —
lille beslutning). Multiplier-knap (1.3× / 1.5× / 2.0×) i toolbar'en. `ListCampaignSelect`
med `contextName: 'Rytme'` og
`createCampaignFromSuggestion({ type: 'rytme', filter: { interval_multiplier } })`.

### 3.3 Test (T_CRM_RYTME)
- Kunde med ≥5 ordrer og `days_since` mellem `avg×mult` og `avg×3` → med på listen.
- Kunde `days_since > avg×3` → IKKE med (hører til dormant).
- `from-suggestion`-cases dækkes af den fælles test.

---

## FASE 4 — Firma-jubilæum (CVR-stiftelsesdato)

### Idé

CVR-registret har firmaets stiftelsesdato. "Tillykke med de 10 år — skal vi bage en
kage?" er en charmerende anledning som stort set ingen konkurrent bruger. Lav frekvens,
men næsten unikt. Lavest prioritet af de fem, men nu fuldt grundet.

### 4.1 Gem stiftelsesdato (prerequisite)

`companies` har ingen stiftelsesdato-kolonne (048 tilføjede `branch`, `employee_count`,
`company_type` m.fl., men ikke denne). Tre små ændringer åbner det:

**(a) Migration** (næste ledige nummer — højeste er p.t. `107`, så **108+**):

```sql
-- 1XX_founded_date_og_jubilaeum.sql
ALTER TABLE companies ADD COLUMN founded_date TEXT;  -- ISO YYYY-MM-DD

INSERT INTO activity_purposes (key, label, emoji, description, is_system, sort_order) VALUES
    ('jubilaeum', 'Jubilæum', '🎂', 'Lykønskning ved firma-jubilæum', 1, 80);
```

**(b) `services/cvrEnrichment.js` → `parseVirkHit`** — tilføj udtræk af stiftelsesdato.
`v` er hele `Vrvirksomhed`, så datoen er tilgængelig. Tilføj før `return`:

```javascript
// Stiftelsesdato: prøv metadata først, fald tilbage til tidligste livsforløb-periode.
const founded_date = meta.stiftelsesDato
    || (Array.isArray(v.livsforloeb) && v.livsforloeb.length
        ? v.livsforloeb.map(l => l?.periode?.gyldigFra).filter(Boolean).sort()[0]
        : null)
    || null;
```

…og tilføj `founded_date,` til det returnerede objekt (ved siden af `status`).

> ⚠️ **Bekræft JSON-stien mod et rigtigt svar.** Jeg er ikke 100% sikker på om det
> hedder `virksomhedMetadata.stiftelsesDato` eller om den kun findes via `livsforloeb`.
> Begge dækkes af koden ovenfor, men kør ét opslag gennem `bontools/cvr-opslag.html`
> (din eksisterende test-harness) og se hvilken der faktisk bærer datoen, før commit.

**(c) `services/companyDiff.js` → `FIELD_MAP`** — én linje, så den flyder gennem
berig-diff'en og `POST /:id/enrich` automatisk (ingen ændring i `companies.js`):

```javascript
{ key: 'founded_date', label: 'Stiftet', src: 'founded_date', writable: true },
```

Bagudfyldning af eksisterende firmaer sker via den eksisterende admin-batch-berigelse
("Berig alle firmaer mod CVR") — stiftelsesdato kommer med næste gang den kører.

### 4.2 Ny suggestion-blok `company_anniversary` i `GET /suggestions`

Et firma-jubilæum skal bruge en kontakt at ringe til, så vi joiner til en repræsentativ
kunde under firmaet. Tilføj som blok §7:

```javascript
// 7. FIRMA-JUBILÆUM (CVR-stiftelsesdato)
const anniversaryRows = db.prepare(`
    WITH anniv AS (
        SELECT co.id AS company_id, co.name AS company_name, co.founded_date,
               CAST(strftime('%Y','now') AS INTEGER)
                 - CAST(strftime('%Y', co.founded_date) AS INTEGER) AS years
        FROM companies co
        WHERE co.is_internal = 0
          AND co.founded_date IS NOT NULL
          -- inden for ±7 dage af årets jubilæumsdato
          AND ABS(
                julianday(strftime('%Y','now') || strftime('-%m-%d', co.founded_date))
                - julianday('now')
              ) <= 7
    )
    SELECT a.company_id, a.company_name, a.founded_date, a.years,
           c.id AS customer_id,
           c.first_name || ' ' || COALESCE(c.last_name,'') AS name,
           c.phone
    FROM anniv a
    JOIN customers c ON c.company_id = a.company_id AND c.is_active = 1
    WHERE a.years >= 1
      AND NOT EXISTS (
          SELECT 1 FROM crm_activities act
          JOIN activity_purposes ap ON ap.id = act.purpose_id
          JOIN customers c2 ON c2.id = act.customer_id
          WHERE c2.company_id = a.company_id
            AND ap.key = 'jubilaeum'
            AND act.created_at > date('now','-330 days')
      )
    GROUP BY a.company_id
    ORDER BY (a.years % 5 = 0) DESC, a.years DESC
    LIMIT 6
`).all();

for (const r of anniversaryRows) {
    const round = r.years % 5 === 0;
    suggestions.push({
        type: 'company_anniversary',
        priority: round ? 1 : 2,
        icon: '🎂',
        title: r.company_name + ' fylder ' + r.years + ' år',
        detail: 'Stiftet ' + r.founded_date + (round ? ' · rundt jubilæum' : ''),
        reason: 'Stiftet ' + r.founded_date + '. ' +
            (round ? 'Rundt ' + r.years + '-års jubilæum' : r.years + '-års jubilæum') +
            ' — god anledning til at ringe og lykønske (og tilbyde en kage).',
        customer_id: r.customer_id,
        customer_name: r.name,
        company_name: r.company_name,
        phone: r.phone,
        action: 'anniversary',
    });
}
```

> **Repræsentativ kontakt:** `GROUP BY a.company_id` returnerer en vilkårlig kunde-række
> fra firmaet. For at ramme en der kan ringes til, bør udvælgelsen foretrække en kunde
> *med* telefon og helst seneste-ordre-kontakten. Det kan løses med en korreleret
> subselect i v2 hvis den vilkårlige kunde viser sig at være et problem; til v1 er det
> tilstrækkeligt.
>
> **Feb 29-kant:** firmaer stiftet d. 29/2 i et ikke-skudår giver en ugyldig dato →
> `julianday(...)` returnerer NULL → ekskluderet det år. Acceptabelt; nævnes så det er kendt.

### 4.3 Dashboard — håndtér `action: 'anniversary'`

Spejl Fase 1's `review`-mønster i `_crmRenderSuggestions`: Ring-knap + en
"🎂 Markér hilst"-knap der logger en `jubilaeum`-aktivitet (så kortet forsvinder ved
næste `crm_activity_created`-SSE).

```javascript
async function _crmMarkAnniversary(customerId) {
    try {
        const purposes = await fetchActivityPurposes();
        const p = (purposes || []).find(x => x.key === 'jubilaeum');
        await postCrmActivity({
            customer_id: customerId,
            type: 'note',
            text: 'Lykønsket ved firma-jubilæum',
            purpose_id: p?.id || null,
        });
    } catch (err) {
        alert('Kunne ikke logge: ' + err.message);
    }
}
```

### 4.4 Test (T_CRM_ANNIV)

- `T_CRM_ANNIV_01` — firma stiftet på dags dato for 10 år siden, med aktiv kunde →
  optræder som `company_anniversary`, priority 1 (rundt).
- `T_CRM_ANNIV_02` — firma stiftet for 7 år siden, dato 10 dage væk → optræder IKKE
  (uden for ±7-dages-vindue).
- `T_CRM_ANNIV_03` — efter `POST /activity` med purpose `jubilaeum` → forsvinder.
- `T_CRM_ANNIV_04` — `founded_date IS NULL` → ekskluderet.
- `T_CRM_ANNIV_05` — intern firma → ekskluderet.

### 4.5 Afgrænsning

- Kun firmaer der allerede er kunder (har en aktiv kunde at ringe til). Jubilæum som
  *prospekt-outreach* (firmaer uden ordrehistorik) er en senere udvidelse.
- Ingen ny visning — kortene lever i suggestions-panelet.

---

## FASE 5 — "Kold" tilbudsopfølgning (udvidelse af `expiring_offer`)

**Findes delvist:** `expiring_offer` fanger tilbud der er ved at udløbe (fremadrettet).
**Mangler:** tilbud der ER udløbet / gået i stå uden svar (bagudrettet "fulgte vi op?").

Plan (let): tilføj et briefing-punkt + evt. suggestion-blok `cold_offer`:
tilbud med `offer_status = 'sent'` og `offer_valid_until < date('now')` uden efterfølgende
aktivitet. Dedupe på en `tilbud_opfoelgning`-purpose. Ingen ny visning nødvendig.

---

## Status — afhængigheder inden commit

Consent-doktrinen (`crm_customer_meta.do_not_contact` blokerer altid; `marketing_consent`
kræves kun for ren B2C-markedsføring) er bekræftet mod kildekoden og anvendt konsistent i
Fase 1–3.

Resterende forbehold (se Revision-sektionen øverst for det fulde billede):
- **Fundament:** den delte `crm_worklist.js`-komponent + snooze-tabel + outcome-felt
  (Revision punkt 2-4) bygges før Fase 2/3.
- **Fase 4:** bekræft CVR-JSON-stien til stiftelsesdato (§4.1b), at backfill giver brugbar
  data, og hent eksplicit consent-go fra Leif (Revision punkt 7) — alle tre før commit.
- **Fase 3:** beslut om `rytme`-listen skal have sin egen purpose (`fast_rytme`) eller
  genbruge `opfoelgning` (§3.2) — rent kosmetisk for rapportering.

---

## Rækkefølge-anbefaling

> Se "Revideret build-rækkefølge" i Revision-sektionen øverst — den har forrang.
> Kort gengivet:

1. **Fase 1** — fuldt klar, billigst, rent additiv. Kan committes nu.
2. **Fundament** — delt `crm_worklist.js` + snooze + outcome-felt (Revision punkt 2-4).
3. **Fase 2 + 3** — trivielle oven på komponenten + den delte dispatch-udvidelse.
   Bygges som parametriserede instanser af `crm_worklist.js`, **ikke** som kloner af
   `crm-reaktivering.js`.
4. **Fase 5** — næsten gratis (kun briefing/suggestion), ingen ny visning.
5. **Fase 4** — KUN hvis CVR-sti + data + consent er på plads. Ellers parkér.
