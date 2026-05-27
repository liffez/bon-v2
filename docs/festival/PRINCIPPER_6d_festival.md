## 6d. FLERE GROCY-INSTANSER — KLON-DOKTRIN (FESTIVAL / TRAILER)

Bon v2 kører mod flere fysiske lokationer (HQ, Trailer, Test). Hver lokation har sin
**egen Grocy-instans** med egen `grocy_api_url` + `grocy_api_key` i `locations`-tabellen.

**Hvorfor flere instanser — og ikke Grocy-lokationer:**
Grocy-lokationer er lager*pladser* (hylde, køl, frys) inden for ét fysisk sted. Grocy har
intet site/warehouse-lag. To fysisk adskilte salgssteder med hvert sit publikum og hvert
sit lagertræk kan derfor ikke modelleres som lokationer i én instans — det ville skævvride
beholdning og min-lager-logik. Én instans pr. site er den korrekte model, ikke en lappeløsning.

### Stamdata vs. lager

| Skal være | Hvad |
|-----------|------|
| **Identisk** på tværs af instanser | stamdata: varer, opskrifter, leverandører, enheder, varegrupper, handelssteder, barcodes, userfields |
| **Forskelligt** (selve pointen) | lager og forbrug — hvert site køber ind og trækker fra eget lager |

### Doktrinen

```
STAMDATA HAR ÉN MASTER og redigeres kun dér. Lokationer DELER masterens stamdata.
   → Festival implementerer det med ENGANGSKLON (master kopieres, kopien er disponibel).
   → Kæde (fremtid) implementerer det med LØBENDE SYNC (master propageres til permanente kopier).
Begge er samme princip — kun opdaterings-mekanikken adskiller dem.
```

**Festival-implementeringen (engangsklon — det der bygges nu):**
```
HQ = master. Trailer = disponibel klon, lager nulstillet, stamdata redigeres ALDRIG lokalt
     for noget der skal bestå. Intet flyder tilbage til HQ.
```

**Kæde-implementeringen (løbende sync — fremtid, ikke bygget):** permanente sideordnede
lokationer deler ét fælles katalog via sync der bevarer en stabil cross-instans nøgle
(`global_key`). Bygges ikke nu — men arkitekturen spærrer ikke for den (se §6d-note nedenfor).

**Konsekvens — id'erne er identiske (kun ved klon).** Fordi en klon er en bit-for-bit kopi,
matcher `product_id`, `grocy_recipe_id`, `supplier_id` 1:1 mellem instanserne. Derfor:
- ingen cross-instans produkt-bro nødvendig **i festival** (transfer bruger samme id)
- opskrifter og menuer kan per definition ikke divergere ved klontidspunkt
- `indkob.js`'s eksisterende identitets-logik (shopping_location, barcode) multipliceres ikke

`global_key`-userfield bevares på alle produkter. **I festival** er det billig drift-forsikring.
**I en kæde** (uafhængige permanente instanser uden klon) er id'erne *ikke* identiske, og
`global_key` bliver da en **afhængighed**, ikke valgfri — transfer og sync slår op via den.
Derfor skal `transferStock` altid slå op via `global_key` (ikke rå `product_id`), så den virker
uændret om id'erne tilfældigvis matcher (klon) eller ej (kæde).

### Klon-operationen er deployment-infrastruktur — ikke Bon v2

Klon-og-tøm udføres af infrastruktur (kopiér Grocy-DB-fil / dump-restore + nulstil lager).
Det er **ikke** Bon v2 der skriver i Grocy. §6 tillader Bon v2 at skrive til Grocy, men
**kun via API'et** — og forbyder direkte skrivning i Grocys DB-fil. Klon er en fil-/DB-operation
på deployment-niveau, udført af bror uden for app'en, og falder derfor uden for §6's domæne:
det er ikke Bon v2 der rører filen. (Var det Bon v2 der gjorde det, ville §6 forbyde det.)

Festival-setup, repeterbart pr. event:

| Behold | Nulstil / tøm | Regenerér |
|--------|---------------|-----------|
| products, recipes, suppliers, quantity_units, product_groups, shopping_locations, storage_locations, barcodes, userfields | `stock`, `stock_log`, transaktioner, evt. `shopping_list` | trailer-instansens egen API-nøgle + dens `locations`-row i Bon v2 |

(Eksakte tøm-tabeller bekræftes mod den kørende Grocy-version — nyere regner lager fra
`stock`, ældre fra `stock_log`.)

### Lokale undtagelser under festival — tilladt, fordi traileren er disponibel

Disse er sikre netop fordi traileren smides væk og re-klones fra HQ; de kan ikke forurene masteren:

| Situation | Håndtering |
|-----------|------------|
| Indkøb hos leverandør uden for listen | book under generisk **dagligvareleverandør**; faktisk butik i fritekst hvis sporbarhed kræves |
| Nyt engangsprodukt opstået på festivalen | **tom opskrift** → consume kører, trækker intet (salg fanges) — *eller* midlertidig vare+opskrift hvis lager skal styres |

**Disciplin der holder modellen ren:** bliver et engangsprodukt en succes I vil gentage,
oprettes det i **HQ-master** — aldrig som permanent lokal redigering på traileren. Ellers
bliver traileren en skygge-master og drift vender tilbage.

**Graceful consume (ufravigelig):** sælges et produkt uden opskrifts-mapping, må consume
aldrig blokere eller fejle — salget registreres, lagertrækket springes over og flagges.
(Den tomme opskrift gør dette til normaltilfældet, ikke en fejltilstand.)

### Hvad der må ændres lokalt på traileren

| Må | Må ikke |
|-----|---------|
| lager (køb ind, modtag, sælg, transfer) | redigere/oprette **varig** stamdata (læg det på HQ) |
| disponible engangs-undtagelser (se ovenfor) | regne med at lokale ændringer overlever en re-klon |
