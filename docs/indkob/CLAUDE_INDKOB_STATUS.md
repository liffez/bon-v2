# CLAUDE_INDKOB_STATUS.md — sådan står indkøb i dag

> **Status:** beskrivelse af nuværende tilstand, 23. september 2026. Ikke en plan.
> **Målt** mod grocy-hq og en frisk kopi af driftsdatabasen 22.–23. september.
> **Skrevet fordi** viden om modulet ligger spredt: mekanikken i `CLAUDE_INDKOB_ASIS.md`
> (juli), fejlene i `CLAUDE_INDKOB_FASE_A.md` og `_B.md` (august), retningen i
> `CLAUDE_VARER_OG_PRISER.md` (september) — og tallene i issues. Ingen af dem svarer
> på "hvordan står det lige nu, og hvor knækker kæden".

| Spørgsmål | Dokument |
|---|---|
| Hvordan virker modulet mekanisk? | `CLAUDE_INDKOB_ASIS.md` |
| Hvilke regnefejl er der? | `CLAUDE_INDKOB_FASE_A.md` (#471) |
| Hvor lyver skærmen? | `CLAUDE_INDKOB_FASE_B.md` (#476) |
| Hvor skal vi hen? | `CLAUDE_VARER_OG_PRISER.md` (#705, udvidet i #706) |
| Hvad mangler i stamdata? | #702 |
| **Hvordan står det nu?** | **dette dokument** |

---

## 1. Kort sagt

- **Modtagelsen bruges. Bestillingen er gået i stå.** 29 varemodtagelser i august og
  september mod ni bestillinger i hele modulets levetid, senest 17. august.
- **Ingen bestilling er nogensinde sendt på mail fra Bon.** Nul af ni.
- **Ingen kobling er komplet.** Af 148 leverandør-koblinger har nul af dem både
  pakkeindhold, leverandørens enhed og en pris.
- **Systemet siger sjældent fra.** Fire steder melder skærmen at noget lykkedes,
  mens bivirkningen fejlede eller aldrig fyrede (#696–#699).
- **Retningen er besluttet**, og de tre beslutninger der ændrede datamodellen er
  taget 22. september. Det der mangler er stamdata og rækkefølge, ikke koncept.

---

## 2. Hvad driften faktisk bruger

Målt i driftskopien 22. september.

| | Tal |
|---|---|
| Bestillinger oprettet i alt | **9** — maj, juli, august |
| Heraf sendt på mail | **0** |
| Seneste bestilling | 17. august |
| Bestillingslinjer i alt | 20 |
| Bestillinger der stadig står som "sendt" | 9 af 9 |
| Varemodtagelser, august + september | **29** |
| Varemodtagelser med registreret afvigelse | 0 af 33 |

To ting kan læses direkte ud af det: køkkenet **modtager** i Bon, men **bestiller**
uden om. Og en bestilling skifter aldrig tilstand efter afsendelse, så skærmen
"Bestillinger" kan ikke vise hvad der faktisk skete.

---

## 3. Arbejdsgangen — og hvor den knækker

Brud er markeret ⚠ med issue-nummer. Mekanikken bag hvert trin står i ASIS.

### Trin 0 · Behovet opstår

Otte veje ind på Grocys `shopping_list`: manuelt i indkøbslisten, "Manglende" og
"Udløbende", 🛒 fra råvare-modalen på en bon, forecast, lageroptælling,
varemodtagelsens rest, og direkte i Grocy.

⚠ **Linjen bærer ingen kilde.** Man kan ikke se *hvorfor* varen står på listen,
og derfor heller ikke om behovet stadig gælder. (ASIS §12.6)

### Trin 1 · Listen

Indkøb viser listen i to grupperinger: efter kategori eller efter leverandør.
Samme underliggende liste, samme handlinger.

⚠ **Mængden regnes med pakkestørrelse 1**, når varen ikke har et pakkeindhold.
"Behov 12 kg" bliver til "12 kolli" uden at noget markerer at tallet er et default.
Det gælder **117 af 148 koblinger**. (#698, #702)

### Trin 2 · Valg af varenummer og enhed

Varen kan have flere numre — hos samme leverandør og hos andre.

⚠ **Salgsenheden vælges aldrig af brugeren.** Skærmen viser den første enhed,
kurven bruger leverandørens standard. 80 af 127 Hørkram-varer har mere end én
salgsenhed, og forskellen mellem karton og pose er typisk faktor 5. (#471 §1.1)

⚠ **96 koblinger har ingen leverandørenhed gemt**, så klienten gætter. (#702)

### Trin 3 · Bestillingen sendes

| Leverandørtype | Hvad Bon gør | Hvem afgiver ordren |
|---|---|---|
| **Katalog** (Hørkram, `api`) | lægger varerne i leverandørens kurv | mennesket, på hoka.dk |
| **Faktura** (`email`) | åbner mailen som kladde, man retter og sender (#701) | Bon sender mailen |
| **Manuel / webshop** | kopierer listen, åbner leverandørens side | mennesket |
| **Intern** (RR Produktion) | opretter en produktionsbon | køkkenet |

**Bon afgiver aldrig selv en ordre hos et katalog.** Det er bevidst.

⚠ **Kurven kan blive tømt.** Hørkrams kald erstatter hele kurven, så et fejlet
opslag af det eksisterende indhold sender kun de nye varer — mens svaret siger ok.
(#697)

⚠ **"Send og bestil" melder OK uden at have sendt**, hvis leverandøren mangler en
mailadresse, eller afsendelsen fejler. (#696)

### Trin 4 · Efter afsendelse

Bestillingen gemmes i Bons egen database, og hver linje på indkøbslisten stemples
i Grocy med leverandør, varenummer, antal og tidspunkt.

⚠ **Stemplingen kan fejle linje for linje uden at nogen får det at vide.** Slår den
fejl, kan varen hverken ses som bestilt eller modtages — og bestilles heller ikke
igen. (#699)

⚠ **Bestillingen opdateres aldrig.** Alle ni står som "sendt". (ASIS §12.6)

### Trin 5 · Varemodtagelsen

To dele i samme skærm: fødevarekontrollen (lovpligtig, uafhængig af Grocy) og
lagerdelen. Varelisten bygges af de stempler trin 4 satte.

Modtagelsen sender i dag også prisen med til Grocy (#657) og kan bruges uden en
bestilling (#658).

⚠ **Fejler oprydningen af indkøbslisten, godkendes modtagelsen alligevel** — linjen
bliver hængende som bestilt. Lagerdelen ved siden af gør det rigtige og markerer
sig som delvist godkendt. Forskellen er ujævn, ikke principiel.

### Trin 6 · Prisen og kostprisen

Grocy er eneste sandhed om priser. Bon gemmer ingen.

⚠ **En pris skrevet på et varenummer når aldrig kostprisen.** Kostprisen regnes ud
fra købsposteringer og varens egne felter. Skriver man fakturaprisen på en vare,
kan indkøbsskærmen kalde den "klar", mens kostprisen stadig ikke kender en pris,
før varen er modtaget. (#706 §11 — besluttet rettet, se §5)

⚠ **Der findes ingen automatisk prisopdatering fra Hørkram.** Kun en knap. En
katalogpris kan derfor være lige så forældet som en fakturapris, uden at nogen
ved det. (#706 §9.1)

---

## 4. Tallene

### Varer og koblinger — grocy-hq, 23. september

| | Antal |
|---|---|
| Aktive varer | 189 |
| … med mindst ét varenummer | 105 |
| … uden varenummer | 84 |
| Koblinger i alt | 148 |
| … hos Hørkram | 127 |
| Varer med mere end ét varenummer | 31 |

### Hvad koblingerne mangler

| Felt | Udfyldt | Mangler |
|---|---|---|
| Pakkeindhold (`amount` + `qu_id`) | 31 | **117** |
| Leverandørens enhed | 52 | **96** |
| Pris | 116 | 32 |
| Foretrukken markeret | 6 | — |
| **Alle tre dele** | **0** | **148** |

Nul komplette koblinger er ikke en detalje. Det er grunden til at hverken mængde,
pris eller enhed kan regnes rigtigt hele vejen igennem.

### Priser

Samme population som ovenfor — de 148 koblinger på aktive varer.

| | Antal |
|---|---|
| Med pris over 0 | 116 |
| Uden pris | 32 |
| Med prisen 0 | **0** |

Det sidste tal betyder, at 0 trygt kan komme til at betyde "bevidst gratis":
der er intet at rydde op først.

### Leverandører og indkøbssteder

Seks leverandører, fem aktive: Hørkram (katalog), Inco (webshop), Serviwet og
Trykkeriet (faktura), RR Produktion (intern). Metro er slået fra.

| Indkøbssted | Varer | Leverandør |
|---|---|---|
| Hørkram | 107 | Hørkram |
| Emballage | 32 | Serviwet |
| RR Produktion | 28 | RR Produktion |
| Drikkevarer | 7 | Hørkram — **omstridt**, se §5 |
| Convifood | 6 | Hørkram — rigtigt, numrene er Hørkram-numre |
| ForEmma · Madsynergi · Dagligvare butik | 8 | **ingen** |

---

## 5. Hvad der er besluttet 22. september

1. **Drikkevarer deles.** Sodavand og vand købes gennem Hørkram. Øl, vin, cava og
   kaffe flyttes til en faktura-leverandør. Dataarbejde, ikke kode.
2. **Grocys eget felt på stregkoden er eneste sandhed** for hvad en pakke
   indeholder. Userfieldet udledes af det og skrives ikke længere.
3. **Kostprisen skal bruge leverandørprisen**, før den falder tilbage på et
   overslag. Princippet: vi gætter ikke på priser, medmindre det er bevidst.

> **Beslutning 2 løser mere end sit eget spørgsmål.** Den er samtidig svaret på
> akse 3 — springet mellem leverandørens basisenhed og vores indkøbsenhed — som har
> blokeret Fase A's Deploy 2 siden 17. august. Den blokering er væk.

## 6. Hvad der mangler at blive besluttet

| | Spørgsmål | Forslag i #706 |
|---|---|---|
| 14.4 | Hvem må sætte priser og skifte leverandør? | office + admin; køkkenet ser og foreslår |
| 14.5 | Hvor bor Varer-skærmen? | fuld side i office; køkkenet linker dertil |
| 14.6 | Viser "Købes hos" indkøbssted eller leverandør? | vis stedet, sammenlign leverandøren |
| 14.7 | Rækkefølgen | som §15 i #706 |

---

## 7. Hvad der er i gang

| Nr. | Hvad | Tilstand |
|---|---|---|
| #704 | Prisfelt i rækken, fremmed varenummer, arbejdslisten "N uden pris" | **åben** — skal rettes før merge: indkøbssted uden leverandør må ikke give overslag, og "Klar" må først vises når kostprisen kender prisen |
| #706 | Den samlede spec med 14 bekymringer og beslutningerne | **åben** |
| #471 | Fase A — salgsenhed, pris, leveringsdato | ikke bygget; akse 3 nu afklaret |
| #476 | Fase B — steder hvor systemet lyver | ikke bygget |
| #696–#699 | De fire tavse fejl | åbne; #701 rørte samme skærm, så #696 bør efterprøves |
| #702 | Stamdata: enheder og pakkeindhold | åben — det er dette dokuments §4 |
| #703 | Optællingsværktøjet | merget; læser stadig det gamle felt og skal rettes |

Fase C — den manglende kladde-bestilling — må først specificeres når Fase A har
kørt i drift et par uger. Varemodtagelsen skal migreres i samme deploy som den,
fordi den bygger sin vareliste på trin 4's stempler.

---

## 8. Rækkefølgen, og hvad man ikke skal gøre nu

1. **Stamdataene først** (#702). Uden pakkeindhold og enheder regner alt andet på
   gætværk, og en ny skærm vil vise gætværket med større selvtillid.
2. **De fire tavse fejl** (#696–#699). Små, uafhængige, og det er dem der koster
   tilliden.
3. **Ret og merge #704.**
4. **Fase A**, nu hvor akse 3 er afgjort.
5. **Varer-skærmen** fra #706, fase 1 og 2.
6. **Fase B** løbende. **Fase C** tidligst to uger efter Fase A er i drift.

**Ikke nu:** byg ikke Varer-skærmen før stamdataene er rettet, og lov ikke at
katalogpriser holder sig selv ajour, før det natlige job findes. Begge dele ville
gøre skærmen mere troværdig end dataene bag den.

---

## 9. Hvordan tallene er målt

Alt i §2 og §4 kan gentages:

```
npm run audit:indkob-enheder -- --hoka        # koblinger, enheder, pakkeindhold
```

Bestillinger og modtagelser er talt direkte i driftskopien; varer, koblinger og
priser er hentet fra grocy-hq's API. Vægte oplyst af Hørkram er udledt af pris pr.
enhed divideret med pris pr. kg — en indikator, ikke en måling, og de er ikke
skrevet nogen steder.
