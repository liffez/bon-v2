# PATCH_H_fakturering_moms_labels.md

> Lille frontend-patch til Bon v2 — ret 2 forkerte moms-labels i
> `office/views/fakturering.js`. Plus tilføj 3-rækkers moms-visning i
> bon-detail (subtotal ex / moms 25% / total incl).
>
> Lukker **#036** (forvirrende UI-label på fakturerings-totaler).

---

## Baggrund

T_FAKTURERING kørsel afslørede at `bon.line_total` returneres fra backend
som INCL. moms (jf. §6b), men `office/views/fakturering.js` labeller det
som "Sum ekskl. moms" og "ekskl. moms" — så brugeren ser et tal der er
25% højere end labelet siger.

**Risikoanalyse:** Det er et frontend label-issue, ikke et pengetab —
backend regner korrekt, og når faktura-genereringen bygges, vil den bruge
de korrekte INCL-tal. Men brugeren bliver forvirret, og hvis nogen kopierer
tallet fra UI til en mail eller separat regneark og angiver det som
"eksklusiv moms", går der fejl i den senere kommunikation.

Patch dækker 6 visningssteder i `fakturering.js`:

| Linje | Hvad | Nuværende | Konsekvens |
|------:|------|-----------|------------|
| 68 | Summary "Ufaktureret beløb" værdi | INCL-tal vises | OK |
| 69 | Sub-label | "ekskl. moms" | ❌ FORKERT |
| 78 | Summary "Faktureret månedlig" værdi | INCL-tal | OK |
| 79 | Sub-label | "X bonner" | OK (ikke moms-relateret) |
| 181 | Pending-liste row | bon.line_total | INCL — label kommer fra context |
| 208 | Done-liste row | bon.line_total | Samme |
| 383 | Detail-tabel linje-total | l.line_total | INCL — label fra context |
| 388 | Detail sum-row label | "Sum ekskl. moms" | ❌ FORKERT |
| 389 | Detail sum-row værdi | bon.line_total | INCL — label er kernen |

To labels skal rettes (linje 69 + 388). Plus ideel udvidelse: detail
sum-row til 3 rækker (ex / moms / incl) — det er hvad e-conomic-faktura
vil vise senere.

---

## Sammenfattende

| # | Linje | Ændring |
|---|------:|---------|
| 1 | 69 | "ekskl. moms" → "inkl. moms" |
| 2 | 387-390 | Udvidet til 3-rækker (subtotal ex / moms 25% / total incl) ved hjælp af `window.Moms.computeMomsFields(bon.line_total)` |

---

## Forudsætning

`window.Moms` skal være tilgængelig globalt. Tjek at `shared/moms.js` er
inkluderet før `office/views/fakturering.js` i HTML'en:

```bash
grep -rn "shared/moms" office/ | head -5
# Skal returnere mindst én linje hvor moms.js er inkluderet før view-script
```

Hvis det ikke er, tilføj `<script src="/shared/moms.js"></script>` i den
relevante HTML før view-scripts loades.

---

## Ændring 1 af 2 — Label-rettelse i summary-card (linje 69)

**Find** i `office/views/fakturering.js`:

```javascript
                <div class="fakt-sum-card">
                    <div class="fakt-sum-label">Ufaktureret beløb</div>
                    <div class="fakt-sum-val">${_faktFmt(summary.pending_amount)} kr</div>
                    <div class="fakt-sum-sub">ekskl. moms</div>
                </div>
```

### Erstat med:

```javascript
                <div class="fakt-sum-card">
                    <div class="fakt-sum-label">Ufaktureret beløb</div>
                    <div class="fakt-sum-val">${_faktFmt(summary.pending_amount)} kr</div>
                    <div class="fakt-sum-sub">inkl. moms</div>
                </div>
```

**Note:** `summary.pending_amount` er sum af `bon.line_total` på serveren,
og hver bon.line_total er INCL. moms (jf. §6b). Labelet skal afspejle det.

---

## Ændring 2 af 2 — 3-rækkers detail sum (linje 387-390)

**Find** i `office/views/fakturering.js`:

```javascript
                    <div class="fakt-sum-row">
                        <span>Sum ekskl. moms</span>
                        <span>${_faktFmt(bon.line_total)} kr</span>
                    </div>
```

### Erstat med:

```javascript
                    ${(() => {
                        // Beregn ex/moms/incl konsistent med §6b
                        const m = window.Moms.computeMomsFields(bon.line_total || 0);
                        return `
                            <div class="fakt-sum-row">
                                <span>Subtotal (ekskl. moms)</span>
                                <span>${_faktFmt(m.total_excl_moms)} kr</span>
                            </div>
                            <div class="fakt-sum-row">
                                <span>Moms (25%)</span>
                                <span>${_faktFmt(m.moms_amount)} kr</span>
                            </div>
                            <div class="fakt-sum-row fakt-sum-row-total">
                                <span><strong>Total (inkl. moms)</strong></span>
                                <span><strong>${_faktFmt(m.total_incl_moms)} kr</strong></span>
                            </div>
                        `;
                    })()}
```

**Note:** Bruger `window.Moms.computeMomsFields()` der allerede eksisterer
i `shared/moms.js`. Returnerer `{total_incl_moms, total_excl_moms, moms_amount}`
— samme felter som backend's `formatBon` decoration. Konsistent kontrakt.

`bon.line_total || 0` håndterer null-tilfælde (bons uden lines).

---

## Optional CSS-tweak

Hvis `fakt-sum-row-total`-klassen ikke allerede er styled, tilføj i
`office/views/fakturering.css` (eller hvor styling lever):

```css
.fakt-sum-row-total {
    border-top: 1px solid var(--color-border);
    padding-top: 6px;
    margin-top: 4px;
}
```

Hvis CSS allerede har en pen total-styling, brug eksisterende klassenavn
i stedet.

---

## Test-cases der skal opdateres

Ingen — T_FAKTURERING tester backend-kontrakten, ikke UI-rendering.
Manuel browser-test er tilstrækkeligt.

---

## Verificering efter patch

### 1. Regression

```bash
npm run test:reset
npm run test:server &

# Alt skal forblive grønt — vi rører kun frontend
npm run test:run-fakturering    # 60/0/0 (uændret)
# Alle øvrige tracks uændrede
```

### 2. Manuel verifikation

1. Åbn `/office/index.html?view=fakturering`
2. **Summary**: "Ufaktureret beløb" sub-label viser "inkl. moms" (ikke ekskl.)
3. **Detail**: Klik en pending bon. Sum-sektion viser nu 3 rækker:
   - Subtotal (ekskl. moms): X kr
   - Moms (25%): Y kr
   - Total (inkl. moms): Z kr
4. **Verificér matematik**: Z = X × 1.25, Y = Z - X
5. **Eksempel**: Hvis bon har 1 line med qty=2, unit_price=100 (incl moms):
   - line_total = 200 (incl moms)
   - Subtotal = 160.00 kr
   - Moms (25%) = 40.00 kr
   - Total = 200.00 kr

---

## Konsekvens for andre views

Hvis samme label-issue findes i:
- `office/views/dashboard.js` (hvis det viser beløb)
- `office/views/tilbud.js` (PDF-generering bruger jsPDF — separat moms-handling)
- `kitchen/today.js`, `kitchen/later.js` (beløb sjældent vist, men tjek)

…bør de også opdateres. Anbefaling: **kør grep efter "ekskl. moms" i hele
office/ + shared/ + kitchen/** og verificér at hver forekomst matcher
faktisk værdi:

```bash
grep -rn "ekskl\.\? moms\|incl\.\? moms\|inkl\.\? moms" office/ shared/ kitchen/
```

Tjek hver linje manuelt — det er kun en label-bug hvor faktisk værdi er INCL.

---

## Markering i TEST_OBSERVATIONS

```markdown
### #036 — Fakturering UI-label "ekskl. moms" viste INCL-beløb (lukket)

| | |
|--|--|
| **Kilde** | T_FAKTURERING runner sideopdagelse (maj 2026) |
| **Beskrivelse** | `office/views/fakturering.js:69` og `:388` labellede `summary.pending_amount` og `bon.line_total` som "ekskl. moms" — men begge værdier kommer fra backend som INCL. moms per §6b. Brugeren så et tal der var 25% højere end labelet sagde. |
| **Vurdering** | Frontend label-bug, ikke pengetab — backend regner korrekt. Fixed maj 2026 via `PATCH_H_fakturering_moms_labels.md`: linje 69-label rettet + detail sum-row udvidet til 3-rækkers visning (ex / moms 25% / incl) konsistent med §6c og e-conomic-konvention. |
| **Status** | `lukket` (maj 2026) |
```

---

## Rollback

Ren UI-ændring uden DB- eller endpoint-impact. Bagudkompatibel (ingen
breaking changes for andre views). `git revert <commit-sha>` ved problemer.

---

## Hvad denne patch IKKE løser

Når **faktura-generering** (PDF + e-conomic-export) bygges senere, skal
samme 3-rækkers visning bruges på selve faktura-output. Patch H er KUN
preview-UI'en i office. Faktura-PDF skal også bruge `Moms.computeMomsFields`
når den endeligt bygges — det er dokumenteret i `routes/invoices.js`'s
header-kommentar.

---

*Oprettet: maj 2026 — efter T_FAKTURERING-runneren afdækkede label-bug på
to steder. Lille patch der lukker #036 og præparerer 3-rækkers visning til
fremtidig faktura-generering.*
