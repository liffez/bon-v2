# Testplan — drift-test af åbne PR'er

> Ligger i roden med vilje: `docs/` er sparse-checkout'et væk på Hetzner, så en fil
> dér kan ikke læses hvor der er brug for den.
>
> **Arbejdsgang:** én PR ad gangen. Test → god? → sig til → merge → næste. Så er der
> aldrig mere end én ny ting i drift, og opfører noget sig underligt, ved vi hvad det var.

Alle kommandoer køres på Hetzner som `leif`, fra `~/bon-v2`.

---

## Trin 0 — inden du starter (ca. 5 min i Grocy)

PR **#366** gør varemodtagelsen streng: mangler en enheds-konvertering, **fejler linjen
synligt** i stedet for at skrive et tal vi ved er forkert.

Fire varer mangler den i dag. Opret dem i Grocy → Produkter → vælg vare →
**Enheds-konverteringer**:

- [ ] `cookie - færdige` — Kasse → Kilo
- [ ] `Vand med Brus` — Antal → Kilo
- [ ] `Brownie` — Kasse → Kilo
- [ ] `Glutenfri Bolle` — Pose → Kilo

Springes det over, møder køkkenet en fejl på netop de fire ved næste modtagelse.

---

## 1 · #368 — Grocy live-audit

Ren tilføjelse. Rører ingen eksisterende kode, ingen migration.

```bash
cd ~/bon-v2
git fetch origin
git checkout claude/grocy-live-audit
node --env-file=.env scripts/audit-grocy-live.js
```

- [ ] Rapport med 7 afsnit vises
- [ ] Punkt 1 viser **0** (hvis trin 0 er lavet)

Ingen genstart nødvendig — scriptet rører ikke serveren.

---

## 2 · #367 — Lagertræk-flaget

Flaget `inventory_deducted` blev sat selv når hvert Grocy-kald fejlede. Vagthunden fra
#305 var blind for netop den tilstand, fordi den leder efter bons **uden** flaget.

```bash
git checkout claude/inventory-deduct-truth
sudo systemctl restart bon-v2
node --experimental-sqlite scripts/check-inventory-deduct.js
```

- [ ] Vagthunden svarer enten "OK — alle leverede bons har trukket lager" **eller** en
      liste med `ikke trukket` / `DELVIST trukket` pr. bon
- [ ] Sæt en bon til LEVERET → lageret trækkes som hidtil

> **Ikke et alarmsignal i sig selv:** finder vagthunden pludselig flere bons end før, er
> det ikke nødvendigvis en ny fejl — den kan nu se tilstande den tidligere var blind for.
> Send listen videre frem for at konkludere.

---

## 3 · #366 — Varemodtagelse: enheder ⚠️ vigtigst

Modtaget mængde står i den enhed varen blev **bestilt** i (kasser, poser). Grocy
regner i lager-enhed (kilo). Uden konvertering blev 994 kasser til 994 kilo.

Det er sket to gange i drift: Spidskål 3. juni (dobbelt), Rødkål 18. maj (for lidt).

```bash
git checkout claude/varemodtagelse-enhed
sudo systemctl restart bon-v2
```

Hård refresh i browseren bagefter: **Cmd+Shift+R**.

- [ ] Modtag en vare bestilt i **kasse/pose** (fx Brød Rug, Frikadeller) → kvittering ok
- [ ] Slå varen op i Grocy → lageret er steget med det **konverterede** tal, ikke antal kasser
- [ ] Modtag en vare i **kilo** (fx Mayonaise) → tallet er præcis som før
- [ ] Modtag én af de fire fra trin 0 **uden** konvertering → linjen fejler med
      *"Mangler enheds-konvertering"*, modtagelsen bliver `partially_approved`

> **Den vigtigste kontrol i hele omgangen.** Tag én rigtig levering, noter lagertallet
> før og efter, og regn efter i hånden.

---

## 4 · #369 — Mail

`sent_at` blev sat 45 linjer *før* afsendelsen blev forsøgt. En fejlet mail var ikke til
at skelne fra en sendt — heller ikke for et menneske der læste tråden.

```bash
git checkout claude/mail-sent-truth
sudo systemctl restart bon-v2
```

- [ ] Send en mail fra en bon → lander normalt, står i tråden med tidspunkt
- [ ] Send til en **ugyldig** adresse (fx `xx@xx.invalid`) → beskeden får **rød ramme**
      og "⚠ Ikke sendt" med årsagen
- [ ] Åbn en **gammel** mail-tråd → uændret, gamle beskeder markeres ikke

> Sidste punkt er vigtigt. Markeres gamle mails pludselig som fejlede, er noget galt —
> stop og sig til.

---

## 5 · #370 — Webhook + booking

To hardkodede påstande: `webhook_sent: true` var en literal, og "✓ Booket" på en rute
betød i virkeligheden "et menneske trykkede".

```bash
git checkout claude/tavse-bivirkninger
sudo systemctl restart bon-v2
```

- [ ] Book et bud fra logistik-siden → badge siger **"Sendt til bud"** i gult,
      ikke "✓ Booket" i grønt
- [ ] Hold musen over badgen → tooltip: *"Leverandøren har ikke bekræftet…"*
- [ ] Gennemfør en varemodtagelse → uændret flow

---

## 6 · #371 — Yield-modellen (underopskrifters vægt)

En produktionsopskrift vejer ikke summen af sine input — syltelage hældes fra, kød svinder.
Modellen bruger nu det yield der er erklæret i Grocy (`recipeunit` + `recipeunitnumber`),
og falder tilbage på summen når intet er erklæret.

```bash
git checkout claude/gram-kaedning
sudo systemctl restart bon-v2
```

Hård refresh (**Cmd+Shift+R**).

- [ ] Åbn Opskrifter → en ret med underopskrifter (fx "Alm slider Boks")
- [ ] Slider-underopskrifter vises nu som **antal** (fx "1 antal") med vægten under
      ("137 g/stk · i alt 136,86 g") — antal til bonen, vægt til køkkenet
- [ ] Dressinger viser deres **yield** (Balsamico + løg: 300 g, ikke 470 g)
- [ ] Åbn en bons Råvarer-modal → underopskrifternes mængder følger samme model
- [ ] `Æggesalat` og `Løvstikke Mayo` viser stadig summen (de mangler `recipeunitnumber`
      i Grocy — udfyldes via #372, ikke en fejl her)

> **Vigtigt at bekræfte:** Sæt en bon til LEVERET og tjek at lageret trækkes som hidtil.
> Yieldet ændrer kun hvad der VISES — råvarerne skal forbruges uændret.

---

## Til sidst

```bash
git checkout main
git pull
sudo systemctl restart bon-v2
```

- [ ] Alt kører på main igen

---

## Hvis noget ser forkert ud

1. **Stop** — gå ikke videre til næste PR.
2. Notér hvad du gjorde, hvad du forventede, og hvad der skete.
3. Serverloggen omkring tidspunktet er ofte nok: `journalctl -u bon-v2 -n 100`
4. Skal du hurtigt tilbage til en kendt tilstand: `git checkout main && sudo systemctl restart bon-v2`

Ingen af PR'erne sletter data. Migrations (132–135) tilføjer kun kolonner, så et skift
tilbage til main er ufarligt — kolonnerne bliver blot stående ubrugte.
