# CLAUDE_TAVLE.md
*Køkkentavlen — bon-v2 og Whiteboard side om side på én touchskærm*

> **Status: spec, ikke bygget.** Afventer at hardwaren er købt og står i køkkenet.
>
> **Forudsætning, endnu ikke i drift:** Whiteboard skal tillade at blive vist i en
> iframe (`FRAME_ANCESTORS` i `whiteboard/server/index.js`). Arbejdet ligger i
> `liffez/whiteboard#22` — det er ikke merged, og `FRAME_ANCESTORS` skal desuden
> sættes i whiteboards `.env` ved deploy. Indtil begge dele er på plads, svarer
> whiteboard `x-frame-options: SAMEORIGIN`, og tavlens højre rude er tom.
>
> Spec'en dækker to ting der kan bygges uafhængigt: **tavle-shell'en** (web) og
> **opsætningen af Raspberry Pi'en** (drift).

---

## Formål

Køkkenet får en fysisk tavle: en 27" touchskærm på væggen, drevet af en Raspberry Pi.
Den skal starte op af sig selv hver morgen og vise **køkken-dashboardet og Whiteboard
ved siden af hinanden** — der står information begge steder som personalet skal have for
øje. Man skal hurtigt kunne skifte til **kun produktion** når der er travlt, og til **kun
Whiteboard** når man fx går en temperaturrunde.

I dag er der ingen vej fra Whiteboard til køkkenet. Tavlen løser det strukturelt: man
navigerer ikke mellem apps, man ændrer hvor meget plads hver rude får.

---

## Designprincipper

Fire regler. De tre første er dyrekøbte — et første forsøg brød dem alle sammen.

**1. Der fjernes ikke noget fra de barer der findes.**
Hverken bon-v2's topbar eller Whiteboards header, sidebar, "På vagt"-bar eller filtre.
De er lavet bevidst. Tavlen viser apperne som de er.

**2. Der lægges ikke en ny bar oven på dem.**
En fælles mode-bar øverst ville give tre barer i højden og se rodet ud. Tavlen har derfor
**ingen egen bar**. Det eneste nye på skærmen er skillelinjen mellem ruderne — og den
skal være der alligevel.

**3. Ruderne genindlæses aldrig.**
Begge iframes er monteret hele tiden; en tilstandsændring flytter dem kun. Derfor sker
skiftet øjeblikkeligt, SSE-forbindelserne overlever, ingen bliver logget ud, og ingen
mister det de var i gang med.

**4. Skærmen skifter aldrig af sig selv i løbet af dagen.**
Står tavlen på produktion, er det fordi nogen har valgt det. Den eneste nulstilling er
den natlige genstart.

---

## Hvorfor Whiteboard ikke skal laves om

Whiteboard har **allerede** et layout til smalle skærme. Under 900 px bredde gør den selv
følgende (`@media (max-width: 900px)` i `whiteboard/public/index.html`):

- sidebaren bliver en udskydelig skuffe bag en hamburger-knap
- headeren ombryder, titlen skrumper, "Du er:"-etiketten skjules
- "På vagt"-baren komprimeres, Smartplan-linket skjules
- `.main` går fra 24 px til 12 px indvendig margen
- opgave-panelet fylder hele bredden

En tredjedel af en 2560 px skærm er 853 px. **Whiteboard rammer altså sit eget smalle
layout af sig selv.** Der skal ingen `?pane=1`-tilstand til, intet skal skjules, og der
er ingen ekstra tilstand at vedligeholde. Ruden skal bare være smallere end 900 px.

Det er også grunden til at princip 1 og 2 kan overholdes uden at gå på kompromis.

---

## Layout

```
┌──────────────────────────────────────────────────┬───────────────┐
│                                                  │▚              │
│   iframe: bon-v2 køkken                          │▚  iframe:     │
│   (med sin egen topbar, som den plejer)          │▚  Whiteboard  │
│                                                  │▚  (med sin    │
│                                                  │▚  egen header)│
│                                                  │▚              │
└──────────────────────────────────────────────────┴───────────────┘
                                                    ▲
                                          trækbar skillelinje
```

Ingen shell-chrome over eller under. Ruderne fylder hele viewporten.

### De tre tilstande

Tilstandene er ikke separate skærmbilleder — de er blot tre bredder af den samme
opdeling:

| Tilstand | Venstre rude | Højre rude | Hvornår |
|---|---|---|---|
| **Split** | 2/3 | 1/3 | Standard. Morgenens visning |
| **Produktion** | 100 % | 0 | Når der er travlt |
| **Whiteboard** | 0 | 100 % | Temperaturrunde, varemodtagelse, opgaver |

At skifte til produktion kræver **ingen ny knap**: bon-v2's egen topbar har allerede
DASHBOARD / I DAG / SENERE. Tavlen bestemmer kun hvor bred ruden er — hvad der står
i den, styrer bon-v2 selv som hidtil.

---

## Skillelinjen

Al betjening ligger her. Den er ~10 px bred med et synligt greb i midten, og har en
usynlig ramme på ~22 px så den kan rammes med en finger.

| Handling | Resultat |
|---|---|
| Træk | Fri bredde. Følger fingeren |
| Slip nær en kant | Hakker fast i 100/0 eller 0/100 |
| Slip nær 2/3 | Hakker fast i split |
| Dobbelt-tryk | Tilbage til split — genvejen på en skærm uden tastatur |
| Tast `1` / `2` / `3` | Split / produktion / whiteboard |
| `Esc` | Tilbage til split |

Hakkene gør at man kan ramme fuldskærm og standardopdelingen præcist med en finger, men
stadig sætte bredden frit hvis 1/3 viser sig at være forkert i praksis. Det er hele
grunden til at det er en trækbar linje og ikke tre faste knapper: den rigtige bredde er
lettere at finde med fingeren på væggen end at gætte på forhånd.

Tastaturgenvejene er der primært til opsætning og fejlsøgning fra en bærbar — en tavle
har sjældent tastatur, men det er trivielt at understøtte og sparer tid når Pi'en skal
sættes op.

**Bredden huskes ikke på tværs af dage.** Se nulstilling nedenfor.

---

## Nulstilling

Valget gemmes i `localStorage` sammen med **datoen** det blev truffet:

```js
{ "split": 0.665, "date": "2026-08-06" }
```

Ved indlæsning: er datoen ikke dagens, åbnes der i split. Ellers genoptages den bredde
der sidst blev sat.

Kombineret med at Pi'en genstarter om natten (se nedenfor) giver det præcis den ønskede
adfærd: **tavlen åbner altid i split om morgenen**, og bliver ellers stående hvor
personalet satte den. Der er med vilje ingen timer der skifter visning i løbet af dagen.

Datoen skal læses med `todayISO()` fra `shared/utils.js` — ikke `new Date().toISOString()`.
Se dato-reglen i `CLAUDE.md`: UTC-datoen er gårsdagens mellem midnat og kl. 02 dansk tid,
og det er præcis i det vindue den natlige genstart kører.

---

## Filer

### Ny fil: `kitchen/tavle.html`

Eneste nye fil i bon-v2. Selvstændig side, ingen ændringer i eksisterende filer.

**Struktur**

```html
<body>
  <iframe id="paneBon" src="/kitchen/index.html"></iframe>
  <div id="tvSplit"></div>          <!-- skillelinjen -->
  <iframe id="paneWb"  src="<WHITEBOARD_BASE_URL>/"></iframe>
</body>
```

**Positionering — vigtigt**

Ruderne placeres absolut med `left` + `width`. En skjult rude parkeres på `left: 100%`
og **beholder sin bredde** — den får aldrig `width: 0`.

Grunden: en iframe på 0 px tvinger siden indeni til at ombryde hele sit layout, og
dashboardets canvas-graf skulle tegnes forfra hver gang. Ved at parkere ruden uden for
skærmkanten i stedet, beholder den et gyldigt layout og kan vises igen øjeblikkeligt.

**Whiteboard-URL**

Hentes fra det eksisterende `GET /api/sidekick/config` (`whiteboardBase`) — samme værdi
Sidekick allerede bruger. Ingen ny route, ingen ny indstilling. Mangler den, vises
bon-v2 alene med en diskret besked i højre rude.

**Auth**

Shell'en kalder `checkAuth()` **før** iframene får deres `src`. Ellers ville en udløbet
session vise to login-skærme inde i to iframes i stedet for at sende tavlen ét sted hen.

### Whiteboard: ingen UI-ændringer

Kun serverændringen der allerede er lavet:

```
FRAME_ANCESTORS=https://bon.ristetrug.dk
```

`helmet` sætter som standard `X-Frame-Options: SAMEORIGIN`, som er et groft ja/nej der
ikke kan pege på ét domæne. Den er slået fra, og indlejring styres i stedet af CSP
`frame-ancestors`, som browseren giver forrang. Samme mønster som `routes/embed.js`
bruger til bestillingsformularen.

Whiteboard har ingen login, så der er ingen cookie- eller SameSite-problemer ved at vise
den i en iframe fra et andet domæne. Det er derfor det her overhovedet er så enkelt.

---

## Delopgave: større tekst i bon-v2

Uafhængig af tavle-shell'en, men nødvendig før tavlen er god at se på.

Tæthedssystemet (`shared/density.js` + `density.css`, se `CLAUDE_DENSITY_TOGGLE.md`) går
i dag kun **nedad**: Komfort → Kompakt → Tæt. En tavle på væggen læses på 2–3 meters
afstand og har brug for det modsatte.

Forslag: en fjerde tilstand **Tavle**, større end Komfort, valgt under Settings →
Denne enhed som de øvrige. Den gemmes per device i `localStorage`, så den kun rammer
Pi'en og ikke nogens bærbare.

Hvor meget større kan først afgøres når skærmen hænger på væggen og man står i køkkenet
og kigger på den. Sæt ikke tal på før da.

---

## Raspberry Pi — opsætning

### Indkøbsnoter

Skærmen er ikke købt endnu, så her er det der er værd at tjekke inden:

- **1440p på 27" med touch er sjældnere og dyrere end 1080p.** Begge virker (Whiteboard
  rammer sit smalle layout ved begge), men 1440p er markant nemmere at læse på afstand
  og giver Whiteboard 853 px i stedet for 640 px.
- **Touch går over USB** — der skal både et videokabel og et USB-kabel til Pi'en.
  Pi 5 bruger **micro-HDMI**, så husk et micro-HDMI→HDMI-kabel.
- **Kapacitiv multitouch**, ikke resistiv. Matteret overflade frem for blank —
  et køkken har spotlys, og en blank skærm bliver et spejl.
- **Kan den tørres af?** Skærmen kommer til at blive rørt med fedtede fingre hver dag.
- **VESA-beslag** til vægmontering.
- **Pi 5 skal have aktiv køling** (den throttler ellers) og en rigtig 27 W USB-C-strømforsyning.

### Software

Grundopsætningen er velkendt terræn:

| | |
|---|---|
| OS | Raspberry Pi OS (64-bit), skrivebordsudgave |
| Autologin | `raspi-config` → Desktop Autologin |
| Browser | Chromium i kiosk, startet automatisk ved login |
| Skærmslukning | Slået fra |
| Musemarkør | Skjult |
| Genstart | Automatisk kl. 04 |

Chromium startes mod `https://bon.ristetrug.dk/kitchen/tavle.html` i kiosk-tilstand med
en **fast profilmappe**. Profilmappen er det vigtige: uden den ryger session-cookien ved
hver genstart, og tavlen møder en login-skærm om morgenen. Af samme grund må der **ikke**
bruges inkognito.

Hvordan skærmslukning og markør slås fra afhænger af om Pi OS-udgaven kører X11 eller
Wayland — det afgøres når maskinen står der, ikke nu.

### Login

Tavlen skal aldrig møde en login-skærm. Det kræver:

- en **dedikeret bruger** til tavlen (ikke en persons konto)
- **lang sessionsvarighed** for den rolle — styres allerede via `session_days_*` i settings
- den faste browserprofil ovenfor, så cookien overlever genstart

Bemærk at Whiteboard ikke har login, så det gælder kun bon-v2-ruden.

### Fjernadgang

Skærmen kommer til at hænge på en væg. Der skal være SSH-adgang til Pi'en, så den kan
genstartes og opdateres uden at nogen skal op på en stol.

---

## Åbne punkter

Kan først lukkes når hardwaren står i køkkenet:

1. **Er 1/3 den rigtige bredde til Whiteboard?** Derfor er linjen trækbar — find det i praksis.
2. **Hvor meget større skal Tavle-tætheden være?** Afgøres ved at stå i køkkenet og kigge.
3. **Virker Whiteboards træk-og-slip på touch?** Det er en kernefunktion, og musebaseret
   træk-og-slip virker ikke altid på touch. Skal afprøves tidligt — det er det eneste
   fund der kan tvinge en ændring i Whiteboard.
4. **X11 eller Wayland** på den installerede Pi OS-udgave.

---

## Bevidst uden for scope

- **Sidekick skjules ikke.** Den flydende Whiteboard-genvej i bon-v2 er ikke nødvendig når
  Whiteboard står i ruden ved siden af, men den bliver stående. Kan tages op senere som et
  selvstændigt valg — ikke som en bivirkning af tavlen.
- **De to barer flugter ikke.** bon-v2's topbar og Whiteboards header er ikke lige høje,
  så der er en lille kant hvor ruderne mødes. Accepteret indtil videre.
- **Ingen genvej fra Whiteboard til bon-v2 i selve appen.** Tavlen gør den overflødig.
  Et rigtigt link er stadig værd at have for dem der åbner Whiteboard på telefonen,
  men det er en anden opgave.
- **Rækkefølgen af ruderne er fast** (bon-v2 til venstre). Ingen grund til at gøre den
  ombyttelig før nogen efterspørger det.
