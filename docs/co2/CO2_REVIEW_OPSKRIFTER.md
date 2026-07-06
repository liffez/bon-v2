# CO₂ — opskrifter til gennemsyn (motor vs Katrines ark)

**Dato:** 6. juli 2026
**Baggrund:** Beregningsmotoren (F5) regner nu CO₂ pr. opskrift ud fra Grocys
opskrifter + de importerede råvarefaktorer. Vi sammenligner mod Katrines
"Samlet Data"-ark som en sund fornufts-tjek.

**Vigtigt:** Grocy er den operationelle sandhed — det er de opskrifter køkkenet
faktisk bruger. Katrines ark var en manuel beregning på et tidspunkt, og
sammensætningen kan have ændret sig siden. Så afvigelser betyder **ikke** at
motoren regner forkert — de betyder at Grocy-opskriften og Katrines beregning
bruger forskellige ingredienser/mængder. Listen her er til at spot-tjekke om et
par Grocy-opskrifter skal opdateres.

---

## Opskrifter hvor motor og ark afviger > 15%

Motoren giver konsekvent et lavere tal end arket — typisk fordi Grocy-opskriften
har en anden sammensætning (fx underopskrifter i stedet for flade ingredienser).

| Opskrift | Katrines ark | Motor (Grocy) | Afvigelse |
|----------|-------------:|--------------:|----------:|
| Kartoflen | 0,44 | 0,29 | −34 % |
| Ægget | 0,46 | 0,32 | −31 % |
| Skinken | 0,74 | 0,51 | −30 % |
| "Tunen" | 0,41 | 0,32 | −23 % |
| Italieneren | 0,71 | 0,56 | −21 % |
| Chili mayo Produktion | 4,23 | 3,36 | −21 % |

**Eksempel (Kartoflen):** Grocys opskrift har Brød Rug, Kartofler, Salt,
BurgerLommer, Servietter, Rødløg-Sylt, Purløg + 2 underopskrifter. Katrines ark
har Spinat, Kål, Mayonaise, Løvstikke, Brød Rug, Kartofler, Salt, BurgerLommer
fladt. Ingredienslisterne er ikke ens.

**Til gennemsyn:** Passer Grocy-opskriften med hvad I faktisk laver i dag? Hvis
ja, er motorens tal det rigtige. Hvis nej, skal Grocy-opskriften opdateres.

---

## Bemærkning: "substitut"-varer (kål/Hvidkål-typen)

Vi har koblet faktoren på både dublet-varerne (kål ↔ Hvidkål, Rødløg-Rå ↔
Rødløg-Sylt, Løvstikke-Frisk ↔ pakke), så begge tæller korrekt. Hvis der dukker
flere dublet-/substitut-par op i opskrifterne, så sig til — de er nemme at
tilføje.

---

## Status
- **32 af 108 opskrifter** har nu et fuldt CO₂-tal i Grocy (`recipes.Co2e`)
- De resterende 76 mangler enten kg-veje (køkkenets vejning), emballage-faktorer
  (Klimakompas) eller de sidste råvarefaktorer (B-listen) — de fyldes automatisk
  når de data lander
