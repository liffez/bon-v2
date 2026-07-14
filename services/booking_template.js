// services/booking_template.js
// ==========================================
// Renderer clipboard-tekst til manuel booking
// hos bud-leverandører (By-expressen, Taxa).
//
// Spec: docs/delivery/CLAUDE_DELIVERY.md
// Plan: Spor 1 — manuel bestilling (single-bon).
//
// Pladsholder-syntaks: {variabel}
// Multi-stop ({stops}-loop) implementeres senere i 3D.6.
// ==========================================

const { getDb } = require('../db/database');
const { getBon } = require('../db/helpers');

// ==========================================
// Variabel-katalog
// Bruges også af Settings-UI til at vise klikbare variabel-chips.
// ==========================================
const TEMPLATE_VARIABLES = [
    { key: 'bon_id', label: 'Bon-ID (intern)', example: '3447' },
    { key: 'bon_number', label: 'Bon-nummer (vist)', example: 'B-3447' },
    { key: 'customer_name', label: 'Bestiller (navn)', example: 'Anne Lindhardt' },
    { key: 'customer_phone', label: 'Bestiller (tlf)', example: '+45 12 34 56 78' },
    { key: 'customer_email', label: 'Bestiller (email)', example: 'anne@firma.dk' },
    { key: 'company_name', label: 'Firma', example: 'Nordic Fast Food' },
    { key: 'delivery_contact_name', label: 'Kontakt på dagen (navn)', example: 'Lene' },
    { key: 'delivery_contact_phone', label: 'Kontakt på dagen (tlf)', example: '+45 22 11 33 44' },
    { key: 'delivery_address', label: 'Leveringsadresse (komplet)', example: 'Nørre Allé 7, 2200 København N' },
    { key: 'delivery_address_street', label: 'Vej + nr', example: 'Nørre Allé 7' },
    { key: 'delivery_address_postal', label: 'Postnummer', example: '2200' },
    { key: 'delivery_address_city', label: 'By', example: 'København N' },
    { key: 'delivery_date', label: 'Dato (DD-MM-YYYY)', example: '03-05-2026' },
    { key: 'delivery_time', label: 'Leveringstid', example: '12:30' },
    { key: 'pickup_time', label: 'Afhentningstid (afgang fra HQ)', example: '12:00' },
    { key: 'total_boxes', label: 'Antal kasser', example: '4' },
    { key: 'total_pax', label: 'Antal personer', example: '15' },
    { key: 'delivery_notes', label: 'Leveringsinstruks', example: 'Ring på dørtelefon ved ankomst' },
    { key: 'packaging_lines', label: 'Pakke-info (linjeliste)', example: '4× Sandwich-kasse · 1× Drikke-kasse' }
];

const VARIABLE_KEYS = new Set(TEMPLATE_VARIABLES.map(v => v.key));

// ==========================================
// formatDate('2026-05-03') → '03-05-2026'
// ==========================================
function formatDate(iso) {
    if (!iso) return '';
    const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
    return m ? `${m[3]}-${m[2]}-${m[1]}` : String(iso);
}

// ==========================================
// Bygger sammenhængende adresse-streng.
// ==========================================
function buildAddressString(addr) {
    if (!addr) return '';
    const parts = [];
    const street = [addr.street_name, addr.street_nr].filter(Boolean).join(' ').trim();
    if (street) parts.push(street);
    if (addr.street_name2) parts.push(addr.street_name2);
    const cityLine = [addr.postal_code, addr.city].filter(Boolean).join(' ').trim();
    if (cityLine) parts.push(cityLine);
    return parts.join(', ');
}

// ==========================================
// Bygger pakke-info fra bon_lines.
// Aggregerer per kategori for kompakt visning.
// ==========================================
function buildPackagingLines(lines) {
    if (!Array.isArray(lines) || lines.length === 0) return '';
    const byCategory = new Map();
    for (const line of lines) {
        const cat = line.category || line.product_name || 'Andet';
        const qty = Number(line.quantity) || 0;
        if (!qty) continue;
        byCategory.set(cat, (byCategory.get(cat) || 0) + qty);
    }
    return Array.from(byCategory.entries())
        .map(([cat, qty]) => `${qty}× ${cat}`)
        .join(' · ');
}

// ==========================================
// Bygger variabel-context til template-rendering.
// Tager bon-objekt (fra getBon) og returnerer flat map.
// Manglende felter bliver tom string i tekst,
// men listes også i `missing` så UI kan advare.
// ==========================================
function buildContext(bon) {
    if (!bon) return { vars: {}, missing: [...VARIABLE_KEYS] };

    const addr = bon.delivery_address || {};
    const fullAddress = buildAddressString(addr);

    // Customer name fra contact_name_full eller fallback
    let customerName = '';
    if (bon.contact_name_full) {
        customerName = String(bon.contact_name_full).trim();
    }

    const vars = {
        bon_id: bon.id != null ? String(bon.id) : '',
        bon_number: bon.bon_number || '',
        customer_name: customerName,
        customer_phone: bon.contact_phone || '',
        customer_email: bon.contact_email || '',
        company_name: bon.company_name || '',
        delivery_contact_name: bon.day_contact_name || customerName || '',
        delivery_contact_phone: bon.day_contact_phone || bon.contact_phone || '',
        delivery_address: fullAddress,
        delivery_address_street: [addr.street_name, addr.street_nr].filter(Boolean).join(' ').trim(),
        delivery_address_postal: addr.postal_code || '',
        delivery_address_city: addr.city || '',
        delivery_date: formatDate(bon.delivery_date),
        delivery_time: bon.delivery_time || '',
        pickup_time: bon.pickup_time || '',
        total_boxes: bon.boxes != null ? String(bon.boxes) : '',
        total_pax: bon.pax != null ? String(bon.pax) : '',
        delivery_notes: bon.delivery_notes || '',
        packaging_lines: buildPackagingLines(bon.lines)
    };

    const missing = [];
    for (const key of VARIABLE_KEYS) {
        if (!vars[key] || String(vars[key]).trim() === '') missing.push(key);
    }

    return { vars, missing };
}

// ==========================================
// Intern variant af renderTemplate der ALTID returnerer mangler-flag.
// Bruges af renderFields() til at markere felter med [mangler] +
// ikke-klikbare i popout-UI'et.
// ==========================================
function _renderWithMeta(template, vars) {
    if (template == null) return { text: '', hasMissing: false };
    let hasMissing = false;
    const text = String(template).replace(/\{([a-zA-Z_][a-zA-Z0-9_]*)\}/g, (full, key) => {
        const val = vars[key];
        if (val != null && String(val).trim() !== '') return String(val);
        if (!VARIABLE_KEYS.has(key)) {
            console.warn(`[booking_template] Ukendt placeholder: {${key}}`);
            return full;
        }
        hasMissing = true;
        return '[mangler]';
    });
    return { text, hasMissing };
}

// ==========================================
// Renderer template-streng med {variabel}-syntaks.
//
// renderTemplate('Hej {customer_name}', { customer_name: 'Anne' })
//   → 'Hej Anne'
//
// Manglende variabler erstattes med '[mangler]' så office kan se hvad
// der mangler i preview. options.markMissing=false fjerner markeringen.
// ==========================================
function renderTemplate(template, vars, options = {}) {
    if (template == null) return '';
    const { markMissing = true } = options;
    const { text, hasMissing } = _renderWithMeta(template, vars);
    if (!markMissing && hasMissing) {
        return text.replace(/\[mangler\]/g, '');
    }
    return text;
}

// ==========================================
// Renderer booking_fields_json til en array af { label, value, missing, step }.
// Bruges af popout-vinduet til at vise klikbare felt-chips.
//
// Returnerer null hvis vehicle ikke har booking_fields_json eller hvis
// JSON er ugyldig — popout falder så tilbage til "Samlet tekst"-mode.
// ==========================================
function renderFields(vehicle, vars) {
    if (!vehicle || !vehicle.booking_fields_json) return null;
    let fields;
    try {
        fields = JSON.parse(vehicle.booking_fields_json);
    } catch (e) {
        console.warn(`[booking_template] Ugyldig booking_fields_json for vehicle ${vehicle.code || vehicle.id}:`, e.message);
        return null;
    }
    if (!Array.isArray(fields)) return null;

    return fields.map(f => {
        const { text, hasMissing } = _renderWithMeta(f && f.template != null ? f.template : '', vars);
        return {
            label: String(f && f.label != null ? f.label : ''),
            value: text,
            missing: hasMissing,
            step: f && f.step ? String(f.step) : null
        };
    });
}

// ==========================================
// Vehicle-opslag.
// ==========================================
function getVehicleById(id) {
    return getDb().prepare(`
        SELECT id, code, label, type, is_internal,
               max_capacity_boxes, max_distance_km, pickup_lead_min,
               cost_formula_json, booking_method, booking_url, booking_template,
               booking_fields_json,
               co2_g_per_km, co2_g_fixed, co2_distance_multiplier, co2_positioning_km,
               booking_api_config_json, supplier_id, is_active, sort_order
        FROM delivery_vehicles
        WHERE id = ?
    `).get(id);
}

function getActiveVehicles() {
    return getDb().prepare(`
        SELECT id, code, label, type, is_internal,
               max_capacity_boxes, max_distance_km, pickup_lead_min,
               cost_formula_json, booking_method, booking_url, booking_template,
               booking_fields_json,
               supplier_id, is_active, sort_order
        FROM delivery_vehicles
        WHERE is_active = 1
        ORDER BY sort_order, label
    `).all();
}

// ==========================================
// Hovedfunktion: byg booking-payload til UI.
//
// Returnerer:
// {
//   booking_method: 'manual_clipboard' | 'api' | 'calendar',
//   booking_url: string | null,
//   clipboard_text: string | null,        // null hvis template ikke konfigureret
//   missing_fields: ['delivery_contact_phone', ...],
//   vehicle: { id, label, code, type, ... },
//   bon: { id, bon_number, ... summary ... },
//   estimated_cost_dkk: number | null,
//   warnings: ['template_not_configured', ...]
// }
// ==========================================
function buildBookingPayload(bonId, vehicleId) {
    const bon = getBon(bonId);
    if (!bon) {
        const err = new Error(`Bon ${bonId} ikke fundet`);
        err.statusCode = 404;
        throw err;
    }

    const vehicle = getVehicleById(vehicleId);
    if (!vehicle) {
        const err = new Error(`Vehicle ${vehicleId} ikke fundet`);
        err.statusCode = 404;
        throw err;
    }

    const { vars, missing } = buildContext(bon);
    const warnings = [];

    let clipboard_text = null;
    if (vehicle.booking_method === 'manual_clipboard') {
        if (!vehicle.booking_template || !vehicle.booking_template.trim()) {
            warnings.push('template_not_configured');
        } else {
            clipboard_text = renderTemplate(vehicle.booking_template, vars);
        }
    }

    if (vehicle.booking_method === 'manual_clipboard' && !vehicle.booking_url) {
        warnings.push('booking_url_not_configured');
    }

    const estimated = estimateCost(vehicle, bon);

    return {
        booking_method: vehicle.booking_method,
        booking_url: vehicle.booking_url || null,
        clipboard_text,
        fields: renderFields(vehicle, vars),
        missing_fields: missing,
        vehicle: {
            id: vehicle.id,
            code: vehicle.code,
            label: vehicle.label,
            type: vehicle.type,
            is_internal: !!vehicle.is_internal,
            supplier_id: vehicle.supplier_id || null
        },
        bon: {
            id: bon.id,
            bon_number: bon.bon_number,
            delivery_date: bon.delivery_date,
            delivery_time: bon.delivery_time,
            pickup_time: bon.pickup_time,
            delivery_address: vars.delivery_address,
            customer_name: vars.customer_name,
            company_name: vars.company_name,
            boxes: bon.boxes,
            pax: bon.pax
        },
        estimated_cost_dkk: estimated,
        warnings
    };
}

// ==========================================
// Estimat fra cost-formel.
// Returnerer null hvis formel mangler eller er ukendt.
//
// Formel-typer:
//   { base, per_km }                                     — Volvo, Taxa
//   { base, included_boxes, extra_box_cost }             — By-expressen
//   { base, standard_inner_city }                        — fallback i byen
//   { base }                                             — Egen cykel
//
// opts.distance_km (valgfri): faktisk køreafstand fra ORS. Når den er
// givet bruges per_km-leddet; ellers falder per_km-formler tilbage til
// base (bagudkompatibelt — Spor 1 kalder uden distance).
//
// Rute-aggregater (multi-stop, Workflow A): kald med en syntetisk bon
// { boxes: total_boxes } og { distance_km: total_km } — samme formler
// gælder for hele turen.
// ==========================================
function estimateCost(vehicle, bon, opts = {}) {
    if (!vehicle?.cost_formula_json) return null;
    let formula;
    try {
        formula = JSON.parse(vehicle.cost_formula_json);
    } catch (e) {
        console.warn(`[booking_template] Ugyldig cost_formula_json for vehicle ${vehicle.code}:`, e.message);
        return null;
    }
    if (!formula || typeof formula !== 'object') return null;

    const boxes = Number(bon?.boxes) || 0;
    const distanceKm = Number(opts.distance_km);
    const hasDistance = Number.isFinite(distanceKm);

    // Standard inner city tager forrang — fast bypris uafhængig af afstand.
    if (formula.standard_inner_city != null) {
        if (formula.included_boxes != null && formula.extra_box_cost != null) {
            const extra = Math.max(0, boxes - formula.included_boxes) * formula.extra_box_cost;
            return Math.round(formula.standard_inner_city + extra);
        }
        return Math.round(formula.standard_inner_city);
    }

    // base (+ per_km × afstand) (+ ekstra kasser)
    if (formula.base != null) {
        let cost = Number(formula.base);
        if (formula.per_km != null && hasDistance) {
            cost += Number(formula.per_km) * distanceKm;
        }
        if (formula.included_boxes != null && formula.extra_box_cost != null) {
            cost += Math.max(0, boxes - formula.included_boxes) * Number(formula.extra_box_cost);
        }
        return Math.round(cost);
    }

    return null;
}

module.exports = {
    TEMPLATE_VARIABLES,
    renderTemplate,
    renderFields,
    buildContext,
    buildBookingPayload,
    buildPackagingLines,
    buildAddressString,
    formatDate,
    estimateCost,
    getVehicleById,
    getActiveVehicles
};
