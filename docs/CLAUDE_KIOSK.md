# CLAUDE_KIOSK.md

**Status:** Specifikation — afventer implementering
**Omfang:** Bon v2 + Whiteboard
**Version:** 0.7

---

## 1. Formål

En fastmonteret touchskærm i køkkenet skal understøtte dagens arbejdsrytme uden
at nogen skal betjene den som en computer. Skærmen skal selv finde tilbage til
den rigtige visning, og den skal minde køkkenet om de to ting der ellers glider:
at få set Whiteboard-opgaverne når produktionen er kørt, og at få set morgendagens
prep inden de går hjem kl. 14.

Al logik ligger i Bon. Enheden er dum og udskiftelig.

### 1.1 Designprincipper

- **Ingen hårde skift.** Skærmen navigerer aldrig væk fra noget nogen står og
  bruger. Den ændrer kun visning når den har stået urørt.
- **Rytme er data, ikke kode.** Tidspunkter, grænser og mål ligger i tabeller og
  settings. En ny skærm er en ny række, ikke en ny kodesti.
- **Enheden er tynd.** Ingen cron-jobs med forretningslogik på Pi'en, ingen
  klokkeslæt hårdkodet lokalt. Pi'en åbner én URL ved boot og gør ikke andet.

---

## 2. Begreber

| Begreb | Betydning |
|---|---|
| **Device** | En fysisk skærm. Identificeres ved et device-id. |
| **Policy** | Det samlede regelsæt Bon leverer til en device for indeværende dag. |
| **Checkpoint** | Noget der skal ses i løbet af dagen. Har en trigger, et mål og en kvittering. |
| **Idle-mål** | Den visning skærmen falder tilbage til efter inaktivitet. Skifter hen over dagen. |
| **Kvittering** | En registrering af at et checkpoint er set. Betyder "set", ikke "færdig". |

---

## 3. Kernemekanik

Et checkpoint er **ikke** en navigation. Et checkpoint er en midlertidig
overskrivning af idle-målet, plus et banner.

```
Normal tilstand:     idle-mål = policy.resume
Checkpoint pending:  idle-mål = checkpoint.target  + banner vises
Checkpoint kvitteret: idle-mål = checkpoint.resume + banner fjernes
```

Det betyder at et checkpoint aldrig afbryder nogen. Står skærmen urørt, glider
den over på målet af sig selv. Står nogen og arbejder i den, sker der ingenting
ud over at banneret er der.

---

## 4. Arkitektur

### 4.1 Ingen iframe

Kiosk-logikken lægges som en delt `kiosk.js` der inkluderes i **både** Bon og
Whiteboard. Alternativet — en shell-side med iframe — er valgt fra, fordi en
forælder ikke kan se berøringer inde i et cross-origin barn, og idle-detektion
derfor ville kræve postMessage-krykker i begge apps alligevel.

`kiosk.js` er inaktiv når der ikke er noget device-id. Den koster ingenting på
almindelige browsere.

### 4.2 Enheds-identifikation

Device-id ligger i en **cookie på `.ristetrug.dk`**, ikke i localStorage.
localStorage er per origin, og skærmen ville miste sin identitet i samme øjeblik
den gik fra Bon til Whiteboard-subdomænet.

- Cookie: `kiosk_device`, domain `.ristetrug.dk`, `SameSite=Lax`, lang levetid
- Sættes én gang ved at åbne `?kiosk=<device-id>`
- Pi'ens boot-URL indeholder parameteren, så en factory reset af enheden
  er selvhelbredende

### 4.3 Policy-levering

`kiosk.js` henter policy fra Bon og abonnerer på ændringer via den eksisterende
SSE-infrastruktur.

```
GET  /api/kiosk/policy            → dagens policy for cookie-devicen
GET  /api/kiosk/stream            → SSE: checkpoint_pending, checkpoint_ack, policy_changed
POST /api/kiosk/ack               → { checkpoint_id }
```

Kaldene sker cross-subdomain fra Whiteboard. Kræver CORS med
`Access-Control-Allow-Credentials` og eksplicit origin — wildcard virker ikke
sammen med credentials.

### 4.4 Idle-fallback

- Aktivitet = `pointerdown`, `keydown`, `scroll`, `wheel`
- Timeout: settings-styret, forslag 180 sek.
- Navigation via `location.replace()` — ellers vokser history uendeligt over en dag
- Skift undertrykkes hvis den aktuelle URL allerede *er* idle-målet

### 4.5 Rengøringstilstand

PCAP-touch reagerer på ledende materiale. Vand, fedt og en fugtig klud giver
falske tryk. Uden en modforanstaltning navigerer rengøringen rundt i Bon hver
gang skærmen tørres af, og idle-timeren nulstilles af ingenting.

- Knap i kioskens statuslinje: **"Rengør skærm"**
- Deaktiverer al touch-håndtering i 30 sek. (settings-styret)
- Viser en fuldskærmsoverlay med nedtælling, så det er tydeligt at skærmen
  ikke er død
- **Idle-timeren pauses** i perioden — rengøring må hverken tælle som aktivitet
  eller som inaktivitet
- Afbrydes kun af nedtællingen, ikke af berøring

Overlayet er samtidig et godt sted at vise rengøringsinstruktionen fra SOP.

### 4.6 Nødvisning

Kiosken viser Bon, som kører på Hetzner. Ryger internetforbindelsen, viser
skærmen ingenting — og det er præcis det tidspunkt hvor nogen har brug for at se
temperaturerne.

**Kritisk detalje: nødvisningen må ikke hentes fra det der er nede.** `kiosk.js`
serveres fra Bon, så den kan ikke selv redde situationen. Fallbacken skal ligge
lokalt på Pi'en.

- En lille statisk side serveres lokalt på kiosk-Pi'en (`localhost`)
- En watchdog på Pi'en poller Bon med korte intervaller; ved vedvarende fejl
  navigerer den Chromium til den lokale side
- Watchdogen kører uafhængigt af browseren, som en systemd-service
- Ved genetableret forbindelse navigeres tilbage, men **kun efter idle** — samme
  regel som §4.4. Ingen hårde skift.

Nødvisningens indhold hentes over LAN, ikke over internettet:

- SLZB'ens eget dashboard viser Zigbee-enhedernes aktuelle værdier i realtid via
  SSE og fungerer uden nogen ekstern server
- Kører model B (§7.4), kan den lokale Pi 4 servere en langt bedre nødvisning
  med **historik**, ikke bare øjebliksværdier — det er forskellen på "fryseren er
  på -14°" og "fryseren har været stigende i tre timer"

Dette er et selvstændigt argument for model B. Nødvisningen bliver reelt en
lokal mini-Whiteboard.

---

## 5. Datamodel

```sql
kiosk_devices (
  id            TEXT PRIMARY KEY,   -- fx 'kokken-1'
  navn          TEXT,
  idle_timeout  INTEGER,            -- sekunder
  aktiv_dage    TEXT,               -- fx 'MO,TU,WE,TH,FR'
  aktiv         INTEGER
)

kiosk_checkpoints (
  id            INTEGER PRIMARY KEY,
  device_id     TEXT,
  raekkefolge   INTEGER,
  navn          TEXT,
  trigger_type  TEXT,               -- 'dagsstart' | 'alle_leveret' | 'fast_tid'
  tidligst      TEXT,               -- HH:MM  (nedre grænse, settings)
  fallback      TEXT,               -- HH:MM  (dage uden ordrer)
  deadline      TEXT,               -- HH:MM  (øvre grænse / manglende kvittering)
  target        TEXT,               -- URL/view der skal ses
  resume        TEXT,               -- idle-mål efter kvittering
  banner_tekst  TEXT,
  insisterende  INTEGER             -- 0 = kan udsættes, 1 = kræver kvittering
)

kiosk_ack (
  device_id     TEXT,
  checkpoint_id INTEGER,
  dato          TEXT,
  kvitteret_kl  TEXT,
  PRIMARY KEY (device_id, checkpoint_id, dato)
)
```

---

## 6. Køkkenskærmens tre checkpoints

### 6.1 Mødetid — dagens opgaver

| Felt | Værdi |
|---|---|
| trigger | `moedetid` — **første berøring af dagen**, ikke skærmens opvågning |
| tidligst | 06:00 |
| deadline | 09:00 |
| target | Dagens opgaver |
| resume | **"I dag"** |
| insisterende | 0 |
| kvittering | implicit — checkpointet *er* at visningen blev mødt |

Køkkenet møder ind kl. 8, nogle gange kl. 7. Skærmen er tændt længe før nogen
kommer, og derfor må triggeren **ikke** være opvågning eller et fast klokkeslæt.
Gjorde man det, ville dagens første checkpoint blive brugt op af en tom skærm
kl. 05:45, og de ville møde ind til hvad der nu tilfældigvis stod der.

Triggeren er den første pointer-hændelse efter midnat. Det er også det eneste
tidspunkt hvor et hårdt skift er acceptabelt: der er per definition ingen der
står midt i noget.

Vigtigt: `resume` er "I dag", ikke dagens opgaver. Under produktion er "I dag"
arbejdsvisningen, og idle-fallback må ikke trække køkkenet tilbage mens de er i
gang. Personalet skifter typisk selv til "I dag" få minutter inde i produktionen
— det er den forventede adfærd, ikke et problem der skal løses.

### 6.2 Produktion kørt — Whiteboard

| Felt | Værdi |
|---|---|
| trigger | `alle_leveret` — alle dagens ordrer har status **leveret** |
| tidligst | settings, forslag 11:00 |
| fallback | 11:45 (dage uden ordrer) |
| deadline | 13:00 |
| target | Whiteboard |
| resume | **"I dag"** |
| insisterende | 0 |

**Trigger er en tilstandsændring, ikke et klokkeslæt.** Bon pusher checkpointet
via SSE i det øjeblik den sidste leveringskvittering lander. Ingen klokkelogik på
enheden, ingen polling, og skærmen reagerer på det virkelige forløb frem for på
en plan.

Grænserne:

- **`tidligst`** — udløses alt kl. 09:30 på en stille dag, bliver checkpointet
  *pending* og fyrer ved `tidligst`. Det springes aldrig over. Stille dage er
  netop de dage hvor der er tid til Whiteboard-opgaverne.
- **`deadline`** — dækker to tilfælde: en levering der skrider, og en kvittering
  der aldrig kommer (glemt af chauffør, tabt By-expressen-callback). Køkkenet må
  ikke sidde og vente på et checkpoint der aldrig udløses.
- Loftet på 13:00 beskytter samtidig vinduet for §6.3.

`resume` er "I dag" — ikke Whiteboard. Er der leveringer efter dette punkt, ser
de Whiteboard, kvitterer, og skærmen falder tilbage til "I dag" for restordrerne.
Whiteboard springes aldrig over; det indskydes.

### 6.3 Inden fyraften — morgendagens prep

| Felt | Værdi |
|---|---|
| trigger | `fast_tid` |
| target | Dashboard (i morgen) |
| resume | Dashboard |
| insisterende | 1 |

Køkkenet går hjem kl. 14 og skal inden da have set hvad der skal preppes til
dagen efter. Dette er det checkpoint der ikke må glide. Banneret kan ikke
afvises uden kvittering, og kvitteringen logges, så det kan følges op bagefter.

Her skifter `resume` til Dashboard — det er selve overgangen fra produktionsdag
til dagen-efter-blik.

### 6.4 Kollisionsregel

Udløses §6.2 på sin deadline kl. 13:00 og bliver ikke kvitteret, kan §6.3's
banner lande ovenpå. **To bannere på én skærm er værre end ingen.**

Regel: er et checkpoint med lavere `raekkefolge` stadig pending når det næste
udløses, kvitteres det lave implicit og forsvinder. Kun ét banner ad gangen.

---

## 7. Hardware

### 7.1 Skærm

**iiyama ProLite T2752MSC-B1AG** — 27", Full HD, IPS, optisk bondet PCAP
10-punkts touch, anti-glare + anti-fingerprint nanobelægning, 7H,
400 cd/m² (360 med touchpanel), HDMI + DisplayPort + USB 3.2 hub, tilt, VESA.

Oprindeligt var T2754MSC-B1AG påtænkt. **2752 er valgt i stedet** — nyere
generation, og på danske forhandlere ca. 1.700 kr. billigere ekskl. moms.

Det afgørende er den optiske bonding. Den fjerner luftspalten mellem touchlag og
panel, hvilket ikke bare giver lavere refleksion og mere præcis touch, men også
beskytter mod fugt og kondensdannelse. I et køkken med damp er en luftspalte et
problem man ikke kan gøre noget ved bagefter. Anti-fingerprint-belægningen er
heller ikke kosmetik når hænderne er fedtede og luften er fuld af melstøv.

2754'erens eneste fordel — højdejusterbart stativ — er irrelevant ved
vægmontering.

**Ingen beskyttelsesfilm.** Panelet har allerede AG-belægning; en blank film
ovenpå forværrer refleksionerne. Og en 27" film kan ikke sættes op boblefrit i
hånden — kanterne løfter sig og samler fedt og melstøv i en sprække der ikke kan
tørres af. Det er et hygiejneproblem, ikke en beskyttelse. Glasset tåler at
blive vasket.

**Bekræftede tal** (Proshop varenr. 3352950, EAN 4948570125203):

| | |
|---|---|
| VESA | 100 × 100 mm |
| Vægt | 6,7 kg |
| Mål (B×D×H) | 61,4 × 23,95 × 40,3 cm |
| Lysstyrke | 400 cd/m², 344 cd/m² gennem touchpanelet |
| Belægning | 7H hard coating, anti-fingeraftryk, kant-til-kant-glas |
| Indgange | HDMI, DisplayPort, 2 × USB 3.2 Gen 1, audio line-out |
| Strøm | 21 W typisk / 1,5 W standby / 0,3 W slukket |
| Medfølger | HDMI-kabel, USB-kabel |
| Øvrigt | Flicker Free, Eco Mode, Kensington-lås |

**Praktiske konsekvenser:**

- HDMI- og USB-kabel følger med — kun strøm mangler.
- Skærmens USB-hub kan bære tastaturet, så der kun skal føres ét USB-kabel til
  Pi'en.
- **Højttalerne er 1 W stereo.** Det er ikke nok i et køkken med emhætte og
  røremaskine. Temperaturalarmer (§7.4) må derfor ikke være afhængige af lyd fra
  skærmen — de skal være visuelle og iøjnefaldende, eller gå til telefon.
- Kensington-lås findes, hvis skærmen skal sikres.

### 7.2 Beslag og placering

- **Fast eller let vippbart VESA-beslag — ikke gasarm.** Touch betyder at folk
  skubber på skærmen; en leddelt arm fjedrer og svinger ved hvert tryk.
- Vægmontering fjerner stativets 29,8 cm højdejustering, så **højden skal være
  rigtig første gang.** Skærmens midte i øjenhøjde for den stående bruger.
- **Væk fra opvask- og vaskezonen.** Se §4.5 — våde hænder og PCAP er en dårlig
  kombination, og afstand er den billigste løsning.
- Kabler: HDMI, USB-B (touch) og strøm skal føres skjult til beslagets placering.

### 7.3 Raspberry Pi

Enheden gør tre ting og ikke mere:

1. Chromium i kiosk-mode mod Bon ved boot, med `?kiosk=kokken-1` første gang
2. Panel slukkes via DPMS kl. 14:15
3. Panel tændes 06:30

```
15 14 * * 1-5   <dpms off>
30 6  * * 1-5   <dpms on>
```

Ni timers indbrændt dashboard hver aften er den eneste grund til punkt 2 og 3.
Alt andet hører hjemme i Bon.

Opvågningstidspunktet er sat før den tidligste mødetid kl. 7, med lidt luft.
Det udløser **ikke** §6.1 — se dér: checkpointet venter på en berøring, ikke på
at panelet tændes.

### 7.4 Sensorindsamling — skal adskilles fra kiosken

Sensordata (temperatur og energiforbrug på køl, frys og ovne; senere vægt) hører
under Whiteboard. Men indsamlingen må **ikke** køre på kiosk-Pi'en.

Kiosken er præcis den enhed der bliver slukket, genstartet, revet ud af stikket
eller ryddet omkring. Temperaturdata fra køl og frys er egenkontroldokumentation.
Trækker nogen stikket på skærmen en fredag, mangler der temperaturlog for hele
weekenden — og ingen opdager det. En separat, diskret placeret enhed koster
ingenting i forhold til den risiko.

**Arkitektur uanset hvilken boks der vælges:**

```
sensorer → lokal broker (persistence) → bridge → broker på Hetzner → Whiteboard
```

- Lokal broker med persistence, ikke sensorer der publicerer direkte til Hetzner.
  Så bliver et internetudfald til *forsinkede* data i stedet for tabte.
- Bridge med `cleansession false`, så køen overlever genstart.
- Ingen broker eksponeret mod internettet.
- Alarmregler for kritiske temperaturgrænser bør kunne udløses lokalt, så et
  netværksudfald ikke også slår alarmeringen fra.

**Zigbee-opsætning** (SLZB-koordinator fra SMLIGHT):

I **Zigbee Hub mode** kører SLZB-OS Zigbee-stakken direkte på enheden — ingen
PC eller NAS skal hoste Zigbee2MQTT — og Hub mode kan tilkoble sig både lokale
og fjerne MQTT-brokere over TCP, med TLS på 8883 og brugernavn/adgangskode.
Enheden har desuden indbygget WireGuard, så forbindelsen kan lægges i tunnel
uden at åbne porte.

Det gør **to arkitekturer mulige:**

```
A)  sensorer → SLZB (Hub mode) → TLS/WireGuard → broker på Hetzner → Whiteboard
B)  sensorer → SLZB → lokal broker på Pi 4 (persistence) → bridge → Hetzner
```

**A er markant enklere** — ingen lokal server overhovedet, én PoE-enhed i
køkkenet. **B koster ingenting ekstra**, fordi Pi 4'eren allerede er der, og
giver til gengæld lokal bufring.

**Valget afhænger af ét spørgsmål der skal verificeres:** bufrer SLZB'en MQTT-
beskeder når forbindelsen til brokeren er nede? Enheden er ESP32-baseret med
begrænset lager, så det er tvivlsomt. Gør den ikke, betyder et internetudfald
tabt temperaturlog — og det er egenkontroldokumentation, ikke bare pæne grafer.

**Indstilling indtil andet er verificeret: model B.** Hardwaren er allerede
betalt, og prisen for at tage fejl er asymmetrisk.

Øvrige forhold:

- **Vælg en CC2652P-variant (TI), ikke EFR32.** CC2652 er fuldt understøttet i
  Zigbee2MQTT; EFR32 har eksperimentel status, og der er rapporteret besvær med
  Ember-driveren på -06M.
- **PoE er den reelle gevinst.** Koordinatoren kan placeres optimalt midt i
  køkkenet med ét kabel. Radioen skal ikke sidde samme sted som computeren.
- SLZB-OS har et scriptsprog med MQTT publish/subscribe. Kritiske
  temperaturalarmer kan derfor køre lokalt på enheden og overleve et
  netværksudfald.

**To alarmveje, ikke én.** De dækker modsatte fejltilstande og erstatter ikke
hinanden:

| | Lokal alarm (SLZB-script) | Dødmandsknap (Hetzner) |
|---|---|---|
| Udløses af | Grænseværdi overskredet, broker utilgængelig | Ingen data modtaget i N minutter |
| Virker når | Internettet er nede | Strøm, LAN eller enheden er død |
| Ses af | Den der er i huset | Den der ikke er i huset |

Den lokale alarm siger "der er noget galt her". Dødmandsknappen siger "jeg er
holdt op med at høre fra køkkenet". Det er den sidste der skal kunne vække nogen
lørdag kl. 02, og den kan kun leve på Hetzner — en enhed kan ikke selv melde at
den er død.
- Batterisensorer i frost kræver **lithium**, ikke alkaline. Alkaline dør ved
  minusgrader.
- Netdrevne Zigbee-enheder fungerer som routere. Rustfrit stål og fryserum
  dæmper signalet kraftigt, så mesh-dækning skal planlægges, ikke håbes.
- Energimåling på ovne er sandsynligvis 3-faset 400 V. Det er elektrikerarbejde,
  ikke et smart-plug.

---

## 8. Settings

Følgende felter eksponeres i Bons settings, ikke i kode:

- Idle-timeout (sek.)
- Varighed af rengøringstilstand (sek.)
- Pr. checkpoint: `tidligst`, `fallback`, `deadline`, `target`, `resume`,
  banner-tekst, insisterende ja/nej
- Aktive ugedage pr. device

Der er ingen god grund til at 13:00 står i kode mens 11:00 står i en formular.
Alle fire tidsfelter er driftsrytme og hører samme sted hen.

---

## 9. Afgrænsning

Ikke med i denne version:

- Flere devices. Modellen understøtter det (ny række), men kun køkkenskærmen
  konfigureres nu.
- Fjernstyring af enheden ud over det policy'en dækker.
- Rapportering på kvitteringer ud over rådata i `kiosk_ack`.
- **Indtastning på skærmen.** Kiosken viser og kvitterer — den er ikke et sted
  man taster. Det USB-tastatur §7.1 allerede regner med, dækker den lejlighedsvise
  undtagelse.

  Vær opmærksom på at et virtuelt tastatur **ikke kommer af sig selv**:
  `inputmode="decimal"` er et hint til et systemtastatur, og Raspberry Pi OS med
  Chromium har ikke noget. Trykker man i et talfelt, får det fokus, markøren
  blinker, og der sker ikke mere. Det gælder bl.a. lageroptællingens antalsfelt,
  produktionsbatchens mængder og opskrifternes portionstal — de felter hører ikke
  til på kiosken. Analyse og fuld feltliste i #552, lukket som ikke-planlagt.

---

## 10. Åbne spørgsmål

1. **Auto-kvittering.** Skal §6.2 kunne kvittere sig selv, når målet har været
   vist og berørt i fx 30 sek.? Ville spare et tryk, men gør kvitteringen
   mindre pålidelig som dokumentation.
2. **§6.3's tidspunkt.** Fast klokkeslæt (fx 13:30), eller et fast interval efter
   at §6.2 er kvitteret? Det sidste undgår kollisionen i §6.4 helt, men gør
   tidspunktet uforudsigeligt for personalet.
3. **`tidligst` for §6.2** — hvilken værdi skal den starte på? Skrives som
   settings, så den kan justeres efter et par ugers drift.
4. **Weekender og lukkedage.** `aktiv_dage` dækker det simple tilfælde. Skal
   helligdage trækkes fra samme kilde som resten af Bon?
5. **Er "dagens opgaver" en selvstændig visning?** §6.1 peger på den som noget
   andet end både Dashboard og "I dag". Hvis den i praksis *er* "I dag"-viewet,
   falder checkpointet sammen til blot at sætte idle-målet ved dagens start —
   simplere, men så mister man Dashboardets overblik ved mødetid.
