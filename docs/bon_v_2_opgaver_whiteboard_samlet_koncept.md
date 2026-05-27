# Bon v2 â€“ Opgaver & Whiteboard

Dette dokument samler **alle beslutninger, antagelser og konkrete tekniske valg**, som vi har truffet indtil nu omkring opgaveliste / whiteboard-systemet.

FormÃ¥let er at have **Ã©t sandheds-dokument**, der kan bruges til:
- videre udvikling
- onboarding (jer selv / andre)
- senere integration i Bon v2

---

## 1. FormÃ¥l og scope

Systemet skal:
- erstatte fysiske sedler
- sikre overdragelse mellem vagter/dage
- hÃ¥ndtere gentagne opgaver
- give en "bagklog-liste" til stille perioder
- dokumentere opgaver (isÃ¦r rengÃ¸ring/hygiejne)
- kunne fremvise historik over for FÃ¸devarestyrelsen

Systemet er i **v1 et selvstÃ¦ndigt modul** og **integreres fÃ¸rst rigtigt i Bon v2**.

---

## 2. Designprincipper

- Whiteboard-fÃ¸lelse fÃ¸r projektstyring
- RÃ¦kkefÃ¸lge > kanban
- FÃ¥ klik (1â€“3) til daglig brug
- Ingen stÃ¸jende chat
- Alt vigtigt logges automatisk
- Samme datamodel bruges overalt

Bevidste fravalg i v1:
- Ingen kanban
- Ingen fuld chat
- Ingen custom field system
- Ingen hard deletes

---

## 3. Overordnet struktur (hierarki)

Alt er `items` i et trÃ¦:

- Lister (fx Drift, Mangler, Backlog)
  - Opgaver
- Projekter (senere)
  - Lister
    - Opgaver

Hierarki styres via `parent_id`.

---

## 4. Datumløse opgaver — Ideer & Backlog

### To faste tidsløse lister

| Liste | Formål | Forventning |
|-------|--------|-------------|
| **Ideer** | Ting der måske bliver til opgaver en dag | Ingen — det er ideer |
| **Backlog** | Opgaver der skal gøres, bare ikke nu | Implicit — tages i stille perioder |

Begge lister er **tidsløse**: opgaver i dem har ingen `due_date` og vises aldrig i dagsvisningen automatisk.

### Filtreringsregel (dagsvisning)

Dagsvisningen viser kun:
```sql
WHERE (due_date = :date OR (due_date < :date AND status != 'done'))
AND list_slug NOT IN ('backlog', 'ideas')
```

Backlog og Ideer vises **altid i deres egen liste**, men **aldrig i dagsvisningen**.

### Flow: Idé → Backlog → Opgave

En opgave bevæger sig fremad ved én aktiv handling fra en medarbejder:

1. **Idé → Backlog**: drag til Backlog-listen, eller "Flyt til Backlog"-knap i detalje-panel. Stadig datumløs, men nu "besluttet".
2. **Backlog → Aktiv opgave**: giv den en dato → den forsvinder fra Backlog og dukker op i dagsvisningen på den valgte dag.

Ingen automatik — det er altid et bevidst valg.

### Oprettelse uden dato

Ved oprettelse af ny opgave er `due_date` **valgfri**. Hvis ingen dato vælges:
- Defaultliste er **Backlog** (ikke Drift eller Hygiejne)
- Ingen advarsel eller prompt om manglende dato
- Opgaven er gyldig og komplet som den er

### "Noget at lave nu?" (Sidekick — fremtidig feature)

I stille perioder kan Sidekick foreslå én datumløs Backlog-opgave:
```
GET /api/lists/backlog/items?no_due_date=true&limit=1
```
Vises som et diskret forslag i panel-visningen — ikke som alarm.

### Datamodel

Ingen ekstra felter nødvendige. Datumløse opgaver er identiske med andre opgaver — forskellen er udelukkende `due_date = NULL` og `parent_id` (hvilken liste de tilhører).

---

## 5. UI-overblik (v1)

### 5.1 Tavlen (primær skærm)

- Venstre: Lister
- Midten: Opgaver i valgt liste
  - Checkbox (done)
  - Titel
  - Ikoner:
    - gentagelse
    - SOP-link
    - forfald
  - Drag & drop for rÃ¦kkefÃ¸lge
- Ã˜verst: dato-navigation + "+ Opgave"

### 5.2 Opgavepanel (slide-in fra højre)

- Titel + status
- Beskrivelse
- Forfald / varighed / gentagelse
- SOP-link (Ã¥bnes i nyt vindue)
- Log / kommentarer (tidslinje)

### 5.3 Tavle-beskeder (intern kommunikation)

- LetvÃ¦gts beskeder (post-its)
- Ikke knyttet til opgave
- Maks fÃ¥ aktive
- Ingen trÃ¥de / svar
- Sammenklappelig UI-stribe

---

## 6. Opgaver med registreringer

Nogle opgaver krÃ¦ver **struktureret registrering**, fx:
- kÃ¸leskabstemperatur
- OK / ikke OK
- handling hvis afvigelse

### UX-princip
- Kun opgaver med krav fÃ¥r ekstra prompt
- Prompt vises ved "Done"
- Input tager < 10 sekunder

### Eksempel
```json
{
  "temperature": -4,
  "temperature_ok": true,
  "issue": false
}
```

Data gemmes i log â€“ ikke som felter pÃ¥ opgaven.

---

## 7. Datamodel (SQLite)

### 7.1 items
- lister, projekter, opgaver
- hierarki, status, rÃ¦kkefÃ¸lge

Vigtige felter:
- type (list / project / task)
- parent_id
- sort_order
- status
- due_date
- repeat_rule
- sop_url

### 7.2 item_log

Systemets rygrad:
- historik
- kommentarer
- tavle-beskeder
- registreringer

Felter:
- item_id (NULL = tavle-besked)
- ts
- user
- action
- note
- data (JSON)

---

## 8. REST API â€“ hovedendpoints

### Lister & opgaver
- GET /api/lists
- GET /api/lists/:listId/items
- POST /api/items
- PATCH /api/items/:id

### RÃ¦kkefÃ¸lge
- PATCH /api/lists/:listId/order

### Completion
- POST /api/items/:id/complete

### Kommentarer
- POST /api/items/:id/comment

### Tavle-beskeder
- GET /api/board/messages
- POST /api/board/messages

### Rapport (FÃ¸devarestyrelsen)
- GET /api/reports/hygiene

---

## 9. FÃ¸devarestyrelsen-tilgang

Systemet kan dokumentere:
- hvad der er gjort
- hvornÃ¥r
- af hvem
- mÃ¥linger (fx temperatur)
- handling ved afvigelser

Rapport er:
- read-only
- filtrerbar pÃ¥ periode
- klar til print / eksport senere

---

## 10. Status og nÃ¦ste skridt

DÃ¦kningsgrad:
- ca. 70 % af reelle behov dÃ¦kket

NÃ¦ste oplagte udviklingstrin:
1. Express.js backend (router + controllers)
2. Gentagelses-motor (cron)
3. Mini frontend-prototype
4. Bon v2-integration

---

**Dette dokument er grundlaget.**
Alt nyt bÃ¸r enten:
- passe ind her
- eller opdatere dette dokument fÃ¸rst.

