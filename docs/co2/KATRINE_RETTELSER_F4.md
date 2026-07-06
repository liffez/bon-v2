# CO₂ — rettelser i ESG-arket (til Katrine)

**Fil:** `ESG_Samlet_Katrine.xlsx` → fanen **"Ingredienser"**
**Baggrund:** Vi har importeret dine 124 råvarer til Grocy. **102 gik rent igennem.**
De nedenstående kunne ikke importeres automatisk — de skal lige rettes i arket,
så kører vi importen igen (den rører kun de nye/rettede).

Dato: 6. juli 2026

---

## A) Konflikter — to råvarer peger på samme vare (4)

Her har to rækker fået **samme Hørkram-varenr**, så systemet kan ikke vide hvilken
faktor der hører til hvilken vare. Ret varenummeret på den forkerte (eller slet
varenr'et, så matcher vi på navn i stedet).

| # | Vare 1 | Vare 2 | Problem | Hvad skal gøres |
|---|--------|--------|---------|-----------------|
| 1 | **honning** | Mayonaise | honning har Mayonaises varenr (60105401) | Ret honnings Hørkram-varenr |
| 2 | **Frikadelle med bønner** | Frikadeller | deler samme varenr | Ret varenr på "Frikadelle med bønner" |
| 3 | **Hvidløg** (1,25) | Hvidløg - i tern (1,2476) | næsten samme tal — er det samme vare? | Slå sammen, eller giv dem hver sit varenr |
| 4 | **Sriracha hot chilisauce** (2,1) | Spicy Chili Sauce (2,102) | næsten samme tal — samme vare? | Slå sammen, eller giv dem hver sit varenr |

*(1 og 2 er rigtige fejl. 3 og 4 er formentlig bare samme vare skrevet to gange.)*

---

## B) Mangler CO₂-faktor (7)

Disse råvarer matcher fint en Grocy-vare, men **CO2e-feltet er tomt**. Find en
faktor (Klimadatabase eller Hørkram) og skriv den ind:

- Chilli Pulver
- Spidskommen
- Stjerne Anis
- Cayenne peber
- Røget Paprika
- Balsamico
- ~~Bagepapir~~ *(ignorér — det er emballage, ikke en fødevare)*

---

## C) Matcher ingen Grocy-vare (3)

Navnet ligner ikke nogen vare i Grocy godt nok. Tjek om navnet/varenr passer med
en eksisterende Grocy-vare:

- **Olie (solsikkekerne)** — hedder måske bare "Olie" i Grocy?
- **Pepper** — er det "Peber"?
- **Gris** — hvilken Grocy-vare svarer den til?

*(Rækkerne "Bønnen - Salat - produktion" og "Kartoflen - Salat - produktion" er
underopskrifter, ikke råvarer — dem skal du ikke gøre noget ved.)*

---

## D) Bruges i opskrifter, men mangler faktor (fundet af beregningsmotoren)

Disse råvarer bruges i mange opskrifter, men fik ikke en faktor — fordi arket
mapper dem (via varenr) til et Grocy-produkt med et **andet navn** end det
opskrifterne bruger. Tjek at faktoren havner på den vare opskrifterne faktisk
bruger (eller at de to varer slås sammen i Grocy):

| Råvare i arket | Mapper til (Grocy) | Bruges i opskrifter som | Antal opskrifter |
|----------------|--------------------|-------------------------|-----------------:|
| kål | Hvidkål | **kål** | 29 |
| Rødløg - Sylt | Rødløg - Rå | **Rødløg - Sylt** | 13 |
| Løvstikke pakke | Løvstikke - Frisk | **Løvstikke pakke** | 11 |

*(Mayonaise + Frikadeller er allerede dækket under A) — konflikterne.)*

---

## Når du er færdig
Sig til — så trækker vi de rettede tal ud af arket igen og kører importen. Alt det
der allerede gik rent (de 102) bliver ikke rørt.
