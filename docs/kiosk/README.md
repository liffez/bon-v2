# Opsætning af kiosk-Pi'en

Hører til `docs/CLAUDE_KIOSK.md` §7.3 (og §4.6). Alt her handler om **enheden**.
Driftsrytmen — checkpoints, klokkeslæt, idle-mål — hører hjemme i Bons settings
og bygges separat; se specen §3–§6.

> **Pi'en er dum og udskiftelig.** Den åbner én URL ved boot, slukker panelet om
> aftenen og tænder det om morgenen. Alt andet ligger i Bon. Bliver enheden væk
> eller går i stykker, er den erstattet på en time med denne mappe.

---

## Hvad der er bygget i Bon i dag

Kun `?kiosk`-parameteren på `kitchen/today.html`, som skjuler topbaren og går i
fullscreen. Policy-, checkpoint- og kvitteringsmaskineriet findes **ikke** endnu
— ingen `routes/kiosk.js`, ingen `kiosk_*`-tabeller, ingen delt `kiosk.js`.

Det gør ikke Pi-opsætningen mindre færdig. Enheden er den samme uanset hvad
siden kan; den henter bare en side der senere kan mere. URL'en er derfor sat til
`?kiosk=kokken-1` allerede nu, så den matcher det device-id §4.2 forventer.

---

## Trin 1 — Flash SD-kort eller USB-stik

Brug **Raspberry Pi Imager** på Mac'en — hentes på
[raspberrypi.com/software](https://www.raspberrypi.com/software/) eller med
`brew install --cask raspberry-pi-imager`.

SD-kortet skal være mindst **32 GB**, klasse 10 / A1. Har Mac'en ikke SD-slot,
skal du bruge en USB-kortlæser.

**Et USB-stik eller en USB-SSD virker lige så godt** — og en SSD holder langt
bedre til en skærm der kører hver dag. Pi 4 starter fra USB uden opsætning,
når der ikke sidder et SD-kort i. Brug en af Pi'ens **blå** USB-porte direkte,
ikke skærmens hub.

> **Kan Pi'en ikke læse kortet** (`SD: card detected` efterfulgt af
> `Failed to open device: 'sdcard'`), er bootloaderen typisk for gammel.
> Start fra USB i stedet, og kør `sudo rpi-eeprom-update -a` + genstart,
> når systemet er oppe. Det skete på den første kiosk-Pi (bootloader fra 2020).

> Alt på kortet slettes. Imager advarer — men den advarer også hvis du ved et
> uheld har peget på en ekstern harddisk. Læs hvad der står i Storage-feltet,
> ikke bare hvad kortet hedder.

### De to første valg

| Valg | Værdi |
|---|---|
| Raspberry Pi Device | Den Pi du har (4 eller 5) — den filtrerer OS-listen |
| Operating System | Øverste punkt: **Raspberry Pi OS (64-bit)** |
| Storage | SD-kortet |

Det øverste OS-punkt ER desktop-udgaven (*"…with the Raspberry Pi Desktop"*).
Gå **ikke** ind i "Raspberry Pi OS (other)" og vælg Lite: kiosken skal bruge en
compositor til at vise Chromium, og desktop-imaget har den allerede sat op til
at starte selv.

### Customisation

Imager v2 lægger indstillingerne som trin i venstre side. (Er du på v1, ligger
de samme felter bag **Next → Edit Settings** fordelt på fanerne General,
Services og Options.)

| Trin | Hvad du udfylder |
|---|---|
| **Hostname** | `kiosk-kokken` |
| **Localisation** | Vælg `Copenhagen` som capital city — tidszone og `dk`-tastatur udfyldes så af sig selv |
| **User** | Brugernavn + adgangskode du husker. Du skal SSH'e ind bagefter |
| **Wi-Fi** | Springes over hvis der kommer kabel. Ellers netværkets navn (SSID) + kode |
| **Remote access** | **Slå SSH til**, med adgangskode-login |
| **Raspberry Pi Connect** | **Spring over** — se nedenfor |

**Kabel frem for wifi.** Skærmen er egenkontroldokumentationens ansigt udadtil,
og wifi i et køkken fuldt af rustfrit stål er ikke et sted at spare et kabel.

**Raspberry Pi Connect** er Raspberry Pis egen fjernadgang over deres relay —
deres udgave af det Tailscale gør. Den er ikke forkert, men den kræver en
Raspberry Pi ID-konto, og skærmen skal ikke nås udefra: alt foregår på husets
eget netværk (se "Netværk" nedenfor). Kan slås til senere hvis behovet opstår.

`APP OPTIONS` nederst til venstre er Imagers egne indstillinger (bl.a. om kortet
skubbes ud til sidst) og behøver ikke røres.

Skriv kortet — 5–10 minutter inkl. verificering — sæt det i Pi'en, og tilslut
HDMI + USB (touch) + strøm.

> Skærmen leverer selv HDMI- og USB-kabel (§7.1). Kun strøm til Pi'en mangler.
> Pi'ens USB-strøm kommer ikke fra skærmens hub — den skal have sin egen forsyning.

---

## Netværk — kun lokalt

Pi'en er en **klient**, ikke en server. Der skal ingenting åbnes i routeren.

- **Ud af huset:** den skal kunne nå internettet, for Bon kører på Hetzner.
  Almindelig udgående trafik, præcis som en telefon på wifi.
- **Ind i huset:** intet. Ingen port forwarding, ingen offentlig IP.
- **SSH virker kun fra samme netværk.** `kiosk-kokken.local` er mDNS (Bonjour)
  og rækker ikke ud over dit LAN.
- Det eneste andet den taler med lokalt er SLZB-koordinatoren, når nødvisningen
  (§4.6) skal vise temperaturer uden internet — også LAN.

Giv den gerne en **DHCP-reservation** i routeren (bind MAC → fast IP).
`.local`-navnet er nok til daglig, men et fast tal er rart den dag mDNS driller.

> **Skal skærmen nås hjemmefra senere**, er svaret Tailscale, WireGuard eller
> Raspberry Pi Connect — ikke en åben port. En Pi med SSH eksponeret mod
> internettet bliver scannet inden for timer.

---

## Trin 2 — Første boot

Lad den komme helt op på skrivebordet. Så fra Mac'en:

```bash
ssh kiosk-kokken.local
```

Opdatér, og få den til at logge automatisk ind på skrivebordet:

```bash
sudo apt update && sudo apt full-upgrade -y
```

```bash
sudo raspi-config
```

To ting i menuen — begge nødvendige:

1. **System Options → Boot / Auto Login → Desktop Autologin**
   Uden dette står Pi'en på en loginskærm efter hvert strømafbrud.
2. **Display Options → Screen Blanking → No**
   OS'et slukker ellers panelet efter ti minutters inaktivitet, hvilket
   modarbejder timerne i trin 4 og gør skærmen sort midt i produktionen.

Genstart: `sudo reboot`

---

## Trin 3 — Kopiér filerne over og installér

Fra **Mac'en**, i denne mappe:

```bash
scp -r docs/kiosk kiosk-kokken.local:~/kiosk-setup
```

Log så ind på **Pi'en** og kør installeren derinde:

```bash
ssh kiosk-kokken.local
bash ~/kiosk-setup/install-kiosk.sh
```

Kør den **ikke** som én linje (`ssh host 'install-kiosk.sh'`). Installeren bruger
`sudo`, og `sudo` kan kun spørge om adgangskoden i et rigtigt terminalvindue.
Skrivebordet skal være oppe når du kører den, så den kan se hvilken compositor
der kører.

Scriptet er idempotent — kør det gerne igen efter en rettelse. Kopierer du
filerne over igen, så slet den gamle mappe først (`rm -rf ~/kiosk-setup`);
ellers lægger `scp -r` den nye mappe *inde i* den gamle.

Det installerer `wlr-randr` og `curl`, lægger filerne i `~/kiosk/`, skriver
autostart for den compositor der faktisk kører, og opretter systemd-timere til
panelet. Til sidst printer det en tjekliste.

### Ret konfigurationen ét sted

`~/kiosk/kiosk.env` er enhedens eneste konfigurationsfil. URL, device-id og
timeouts står dér — ikke i scripts.

```bash
nano ~/kiosk/kiosk.env
~/kiosk-setup/install-kiosk.sh     # kør igen så nødsiden får de nye værdier
```

---

## Trin 4 — Efterprøv panelet FØR første aften

Der findes ikke ét kald der slukker panelet på tværs af Pi-modeller og
compositors. `kiosk-display.sh` prøver fire veje i rækkefølge og husker den der
virkede. Det skal ses virke én gang, ikke antages:

```bash
~/kiosk/bin/kiosk-display.sh status
```

```bash
~/kiosk/bin/kiosk-display.sh off && sleep 5 && ~/kiosk/bin/kiosk-display.sh on
```

Panelet skal blive sort og komme igen. Skriver den `INGEN metode virkede`, så
send outputtet fra `status` — så finder vi den rigtige vej for netop din model.

Tjek at timerne står i kalenderen:

```bash
systemctl --user list-timers 'kiosk-*'
```

### Efter lukketid: sort skærm, tryk for at tænde

Skal der laves mad kl. 18 eller 21, trykker man på den sorte skærm, og så er
Bon og Whiteboard der igen. Når ingen har rørt skærmen i
`KIOSK_WAKE_IDLE_MINUTES` (10), bliver den sort igen. Det gælder også i
weekenden. Inden for åbningstiden bliver den aldrig sort af sig selv.

**Hvorfor sort og ikke slukket:** iiyama-skærmen slukker sin berøring, når
panelet går i standby (målt på Pi'en: ingen `TOUCH_DOWN` mens panelet er
slukket). Et slukket panel kan derfor ikke vækkes med et tryk. Kl. 17:30 lægges
i stedet et helt sort vindue over (`bin/kiosk-blank.py`). Berøringen virker hele
tiden, og et sort billede brænder ikke ind. Baggrundslyset er tændt om natten.

Det sorte vindue lukker, når fingeren slippes, så trykket ikke rammer siden
nedenunder. `swayidle` (`bin/kiosk-idle.sh`, startet fra labwc's autostart)
lægger det over igen efter idle.

Efterprøv det:

```bash
~/kiosk/bin/kiosk-display.sh off
```

Skærmen skal blive sort. Tryk på den — så skal Bon være der igen.

Sættes `KIOSK_WAKE_IDLE_MINUTES="0"`, slukkes panelet rigtigt kl. 17:30, og et
tryk vækker det ikke. Vil du slukke panelet rigtigt i hånden:
`~/kiosk/bin/kiosk-display.sh sleep`.

---

## Trin 5 — Genstart og log ind

```bash
sudo reboot
```

Skærmen deles i to vinduer uden titellinjer:

| Venstre 2/3 | Højre 1/3 |
|---|---|
| Bon — køkkenets dashboard med topbar | Whiteboard (mobiloptimeret) |

De to vinduer har hver sin login. Log ind **én gang** i hver:

- **Bon:** tast køkkenets PIN på PIN-padden, der dukker op på skærmen.
  `kitchen`-rollen har 365 dages session (`session_days_kitchen`), så det er én
  gang om året — ikke hver morgen.
- **Whiteboard:** brug tastaturet. Logitech K400 Plus er ikke Bluetooth; den har
  en lille USB-modtager (ofte gemt i batterirummet), der sættes i Pi'en.

Kiosk-tilstand uden topbar gælder kun "I dag"-visningen. På dashboardet skal
topbaren bruges til at navigere.

### Layoutet styres fra kiosk.env

| Indstilling | Standard | |
|---|---|---|
| `KIOSK_LAYOUT` | `split` | `single` = ét vindue i fuld skærm |
| `KIOSK_URL` | køkkenets dashboard | venstre vindue |
| `KIOSK_SIDE_URL` | Whiteboard | højre vindue |
| `KIOSK_MAIN_FRACTION` | `2/3` | den store dels andel af bredden |
| `KIOSK_MAIN_SCALE` / `SIDE_SCALE` | `1` / `1` | zoom på den store / lille del |
| `KIOSK_OFF_TIME` / `ON_TIME` | `17:30` / `06:30` | panelet sluk/tænd, man-fre |
| `KIOSK_WAKE_IDLE_MINUTES` | `10` | efter lukketid: sort skærm igen efter så mange minutter uden berøring (0 = sluk panelet rigtigt, tryk vækker ikke) |
| `KIOSK_HIDE_PANEL` | `1` | skjul Pi OS' panel i toppen |

Kør installeren igen efter en ændring, og genstart. Vinduesplaceringen ligger
som regler i `~/.config/labwc/rc.xml` mellem to `bon-v2 kiosk`-markører; en
tidligere udgave af filen gemmes som `rc.xml.bak-kiosk`.

**Panelet** kan ikke auto-skjule sig under labwc, så installeren kommenterer
dets linje ud i `/etc/xdg/labwc/autostart` (backup: `autostart.bak-kiosk`).
Gendan med `sudo cp /etc/xdg/labwc/autostart.bak-kiosk /etc/xdg/labwc/autostart`.

### Byt-knappen ⇄

"⇄ Whiteboard stor" / "⇄ Bon stor" i Bons køkken-topbar og i Tavlens header
bytter om på hvem der har den store del. Pi'en skriver vinduesreglerne om og
genstarter begge vinduer — det tager omkring 5 sekunder. Valget huskes over
en genstart (`~/.config/bon-kiosk/primary`), og zoomen følger pladsen.

Knappen findes **kun på Pi'en**: den vises først når
`kiosk-layout.service` svarer på `127.0.0.1:8765`, og appsene spørger kun
når de er åbnet fra kiosken (`?kiosk=…`, husket i browseren). Serveren tager
kun imod kald fra Bons og Tavlens egne adresser.

Chromium spørger normalt om lov før en hjemmeside må kalde `127.0.0.1`. Den
tilladelse gives på forhånd i `/etc/chromium/policies/managed/bon-kiosk.json`,
som også slår "Oversæt denne side?" fra.

```bash
journalctl --user -u kiosk-layout -f
```

### PIN-padden

Login-siden viser en taltast-pad når den åbnes fra kiosken. Browseren husker
at den er en kiosk, så padden også kommer, hvis sessionen udløber på en side
uden `?kiosk` i adressen. Efter login lander man på den side man stod på.

Har nogen testet kiosk-URL'en på en almindelig pc og fået padden hængende:
åbn `/login.html?kiosk=off`.

---

## Nødvisning (§4.6)

`kiosk-watchdog.service` poller Bon hvert 20. sekund. Efter tre fejl i træk
skifter den til `~/kiosk/offline.html`, som ligger **lokalt på Pi'en** — netop
fordi den ikke må hentes fra det der er nede.

Vejen tilbage ligger i selve nødsiden, ikke i watchdogen: siden poller Bon og
navigerer først tilbage når den har stået **urørt** i 2 minutter. En watchdog
kan ikke se berøringer; en side kan. Det er §4.4's regel om ingen hårde skift.

Prøv den af ved at trække netværkskablet ud og vente et minut.

```bash
journalctl --user -u kiosk-watchdog -f
```

Har I sat SLZB-koordinatoren op (§7.4), så læg dens dashboard-URL i
`KIOSK_SLZB_URL` og kør installeren igen. Så får nødsiden en knap til
temperaturerne — hvilket er hele pointen med at have en nødvisning.

Watchdogen kan slås fra:

```bash
KIOSK_WITH_WATCHDOG=0 ~/kiosk-setup/install-kiosk.sh
systemctl --user disable --now kiosk-watchdog.service
```

---

## Filer

| Fil | Rolle |
|---|---|
| `install-kiosk.sh` | Installerer alt. Køres på Pi'en, idempotent. |
| `kiosk.env.example` | Skabelon → `~/kiosk/kiosk.env`. Enhedens eneste config. |
| `bin/kiosk-chromium.sh` | Starter Chromium ved boot, genstarter den hvis den dør. |
| `bin/kiosk-display.sh` | `on`/`off`/`sleep`/`status` + `idle-off`/`wake`. Fire fallbacks, husker hvad der virkede. |
| `bin/kiosk-idle.sh` | swayidle: sort skærm igen efter idle uden for åbningstid. |
| `bin/kiosk-blank.py` | Det sorte vindue efter lukketid. Lukker ved berøring. |
| `bin/kiosk-watchdog.sh` | Skifter til nødvisning når Bon ikke kan nås. |
| `offline.html` | Lokal nødside. Poller Bon, vender tilbage efter idle. |
| `bin/kiosk_layout.py` | Vinduesreglerne — én kilde for installeren og byt-knappen. |
| `bin/kiosk-layout-server.py` | Byt-knappens modtager, kun på 127.0.0.1. |

---

## Fejlsøgning

**Chromium kommer ikke op efter genstart**

Autostart-filen afhænger af compositoren. Se hvad installeren valgte, og hvad
der faktisk kører:

```bash
echo "$XDG_SESSION_TYPE"; pgrep -l 'labwc|wayfire|Xorg'
```

Start den i hånden for at se fejlen:

```bash
~/kiosk/bin/kiosk-chromium.sh
```

Ramte den forkert, kan du tvinge valget:

```bash
KIOSK_COMPOSITOR=labwc ~/kiosk-setup/install-kiosk.sh
```

**"Gendan sider?" står oven på kiosken efter et strømafbrud**

Skulle være dækket — starteren nulstiller Chromiums `exit_type` før hver start.
Sker det alligevel, så sig til; så skal `Preferences`-stien justeres.

**Timerne fyrer ikke**

Uden linger stopper brugerens systemd når ingen er logget ind:

```bash
loginctl show-user "$USER" | grep Linger
```

**En musemarkør står og flyder midt på skærmen**

Sker kun hvis der er sat en mus til. Berøring flytter ikke markøren, så det er
ikke et problem med kun tastatur. Bliver det generende, er den rene løsning en
linje i Bons egen kiosk-CSS (`kitchen/today.html`, blokken `body.kiosk`):

```css
body.kiosk { cursor: none; }
```

Det er en kodeændring i Bon og skal derfor gennem det almindelige deploy-flow —
ikke noget der rettes på Pi'en.

**Skærmen navigerer rundt af sig selv når den tørres af**

Det er §4.5, og rengøringstilstanden er ikke bygget endnu — den hører til i
Bons `kiosk.js`, ikke på Pi'en. Indtil da: tør af med skærmen slukket
(`kiosk-display.sh off`).
