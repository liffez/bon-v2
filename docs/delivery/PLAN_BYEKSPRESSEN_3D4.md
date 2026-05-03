# Plan: By-expressen som manual_clipboard i 3D.4

> Indtil API-credentials fra Sebastian er på plads, behandles By-expressen **præcist som taxa**.
> Office copy-paster bestillingsdata til By-expressens bestillings-side i nyt vindue.
> Når API'et er klar (3D.5): én SQL-update skifter mode — ingen kode-ændring.

---

## Princippet

| Komponent | Hvad sker |
|-----------|-----------|
| **Bon v2** | Genererer struktureret bestillings-tekst og kopierer til clipboard |
| **By-expressens side** | Åbnes i nyt vindue ved klik. Office paster tekst manuelt ind |
| **Kontoret** | Bekræfter booking på deres side, indtaster ref tilbage i Bon v2 (valgfri) |
| **Faktisk omkostning** | Indtastes manuelt i Bon v2 når By-expressen-fakturaen modtages |

Det er **identisk** med hvordan taxa fungerer. Forskellen er kun URL'en og template-indholdet.

---

## Konfiguration

I seed-data: `delivery_vehicles`-rækken for By-expressen sættes op som taxa:

```sql
INSERT INTO delivery_vehicles (
    code, label, type, is_internal,
    max_capacity_boxes, max_distance_km,
    cost_formula_json,
    booking_method, booking_url, booking_template
) VALUES (
    'byekspressen', 'By-expressen', 'bike', 0,
    4, 8,
    '{"base":100,"included_boxes":2,"extra_box_cost":50}',
    'manual_clipboard',
    '<DERES BESTILLINGSSIDE URL>',
    '<TEMPLATE - se nedenfor>'
);
```

---

## Template-indhold

Bygges efter samme princip som taxa-template. **Skal verificeres** med office før 3D.4 deployes.

### Forslag til template (skal valideres)

```
Afhentning hos:
Ristet Rug · Prinsesse Charlottesgade 16, 2200 København N
Tid: {pickup_time} {delivery_date}

Levering til:
{delivery_address}
{contact_name}
Tlf på dagen: {delivery_contact_phone}

Antal kasser: {total_boxes}
Bon-ID: {bon_ids}

{delivery_notes}
```

### Pladsholdere der bruges

| Pladsholder | Erstattes med |
|-------------|---------------|
| `{pickup_time}` | Afgangstid fra HQ (fx "11:35") |
| `{delivery_date}` | Dato (fx "01-05-2026") |
| `{delivery_address}` | Komplet leveringsadresse |
| `{contact_name}` | Kontakt-på-dagen navn (fallback: bestiller) |
| `{delivery_contact_phone}` | Kontakt-på-dagen telefon |
| `{total_boxes}` | Sum af kasser på turen |
| `{bon_ids}` | Fx "#3447" eller ved multi-stop "#3447 + #3448" |
| `{delivery_notes}` | Leveringsinstruks fra bonnen |

### For multi-stop (sjælden men muligt)

Template bruger `{stops}`-loop:

```
Levering til flere stop:
{stops:Stop {sequence}: {customer} · {address} · senest {delivery_time}}

Antal kasser samlet: {total_boxes}
```

---

## Office-flowet i praksis

```
1. Bon planlagt til By-expressen i "Plan i morgen"
2. "Bekræft og bestil"
   ↓
3. Manual booking-modal åbner (samme komponent som taxa)
4. Office klikker "Kopiér og åbn By-expressen"
   ↓
5. Tekst i clipboard · By-expressens side åbner i nyt vindue
6. Office paster i deres formular og bekræfter
   ↓
7. Tilbage i Bon v2: indtast booking-ref (valgfri) · "Marker som booket"
   ELLER "Spring over" → forbliver in_progress
   ↓
8. Senere når By-expressen-faktura modtages:
   Indtast faktisk omkostning i tur-card
```

---

## Inden 3D.4 deployes — afklaring nødvendig

| Item | Spørgsmål til dig |
|------|-------------------|
| URL | Er det den nuværende bestillingsside-URL hos By-expressen? |
| Template | Matcher det indhold vi typisk paster ind? |
| Felter | Mangler By-expressen noget vi ikke har med? Fx vægt? |
| Specielle noter | Skriver office altid noget specifikt vi kan tilføje som default? |

Vis evt. et eksempel på hvad I copy-paster i dag — så kan vi matche det 1:1.

---

## Migrering til API i 3D.5

Når Sebastian leverer credentials:

```sql
UPDATE delivery_vehicles
SET booking_method = 'api',
    booking_api_config_json = '{
        "endpoint": "https://api.byekspressen.dk/v3/bookings",
        "api_key": "<SECRET>",
        "webhook_secret": "<SECRET>"
    }',
    booking_template = NULL,
    booking_url = NULL
WHERE code = 'byekspressen';
```

Det er hele migrationen. Resten håndteres automatisk:

| Hvad | Hvordan |
|------|---------|
| Frontend | Ingen ændring — modal-flow ændrer sig automatisk fordi `booking_method='api'` springer manual-modal over |
| Booking | Auto-kald til `services/byekspressen.js` |
| Booking-ref | Returneres synkront fra API |
| Faktisk omkostning | Auto-registreres via webhook |

---

## Hvad der står klar dag 1 i 3D.4

| Komponent | Status |
|-----------|--------|
| `delivery_vehicles`-row for By-expressen | ✅ Konfigureret som manual_clipboard |
| Manual booking-modal | ✅ Eksisterer (bygges til taxa, virker for alle manual-vehicles) |
| Booking-template | ⚠ Skal verificeres med office før deploy |
| URL | ⚠ Skal verificeres |
| Faktisk-omkostning-felt | ✅ I tur-card (bygges til taxa, virker for alle) |
| Office-flow uændret | ✅ Bruger samme UI som taxa |

---

*Sammenfatning af eksisterende krav i `CLAUDE_DELIVERY.md` 3D.4 + overgangsstrategi-sektionen.*
