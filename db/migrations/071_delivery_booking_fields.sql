-- ==========================================
-- 071_delivery_booking_fields.sql
-- Spor 1 — Popout: Felt-for-felt-bestilling
--
-- Tilføjer en JSON-konfiguration pr. vehicle hvor hvert "felt" er en
-- mini-template med samme {variabel}-syntaks som booking_template.
-- Popout-vinduet rendrer dem som klikbare chips (klik = kopier).
--
-- Spec: docs/CLAUDE_DELIVERY_POPOUT.md
--
-- Bagudkompatibel: NULL betyder "ingen felt-konfiguration", og popout
-- falder tilbage til "Samlet tekst"-mode (eksisterende booking_template).
-- ==========================================

ALTER TABLE delivery_vehicles ADD COLUMN booking_fields_json TEXT;

-- ==========================================
-- SEED — By-expressen (Lobo 4-trins wizard)
-- step-property grupperer felter visuelt i popout, så kontoret
-- kan se hvilke felter der hører til hvilket Lobo-trin.
-- ==========================================
UPDATE delivery_vehicles
SET booking_fields_json = '[
  { "step": "Trin 2: Afhentning", "label": "Afhentningssted",  "template": "Ristet Rug, Prinsesse Charlottesgade 16, 2200" },
  { "step": "Trin 2: Afhentning", "label": "Klar kl.",         "template": "{pickup_time}" },
  { "step": "Trin 2: Afhentning", "label": "Senest",           "template": "{delivery_time}" },
  { "step": "Trin 2: Afhentning", "label": "Antal kolli",      "template": "{total_boxes}" },
  { "step": "Trin 2: Afhentning", "label": "Indhold",          "template": "Mad — {packaging_lines}" },
  { "step": "Trin 2: Afhentning", "label": "Reference",        "template": "{bon_id}" },
  { "step": "Trin 2: Afhentning", "label": "Afsender-kontakt", "template": "Køkken — 33 21 89 89" },
  { "step": "Trin 3: Levering",   "label": "Lev.-adresse",     "template": "{delivery_address_street}, {delivery_address_postal} {delivery_address_city}" },
  { "step": "Trin 3: Levering",   "label": "Modtager + tlf",   "template": "{delivery_contact_name}, {delivery_contact_phone}" },
  { "step": "Trin 3: Levering",   "label": "Firma",            "template": "{company_name}" },
  { "step": "Trin 3: Levering",   "label": "Bemærkn.",         "template": "{delivery_notes}" }
]'
WHERE code = 'byekspressen';

-- ==========================================
-- SEED — Taxa 4×35 (ét samlet bestillings-skema, ingen step-gruppering)
-- ==========================================
UPDATE delivery_vehicles
SET booking_fields_json = '[
  { "label": "Pickup-adresse",  "template": "Ristet Rug, Prinsesse Charlottesgade 16" },
  { "label": "Afhentning",      "template": "{pickup_time}" },
  { "label": "Dato",            "template": "{delivery_date}" },
  { "label": "Firma",           "template": "{company_name}" },
  { "label": "Kontakt + tlf",   "template": "{delivery_contact_name} · {delivery_contact_phone}" },
  { "label": "Adresse",         "template": "{delivery_address_street}" },
  { "label": "Postnr",          "template": "{delivery_address_postal}" },
  { "label": "By",              "template": "{delivery_address_city}" },
  { "label": "Lev.-tid",        "template": "{delivery_time}" },
  { "label": "Reference",       "template": "{bon_id} · {total_boxes} kasser · lev. {delivery_time}" },
  { "label": "Bemærkn.",        "template": "{packaging_lines}. {delivery_notes}" }
]'
WHERE code = 'taxa-4x35';
