// routes/wage_rates.js
// ==========================================
// Timeløn per medarbejder til driftsregnskabet. ADMIN-ONLY — løn er følsomt.
//
// Smartplans API leverer ingen løn (kun timer), så satser vedligeholdes som en
// lille CSV Leif selv styrer og importerer her. CSV-rækker matches mod
// Smartplan-rosteren (/members/) på initialer → navn, så smartplan_ref bliver
// owner.uuid og laborAdapter kan join'e satsen på worklogs.
//
// CSV-format (header påkrævet, komma eller semikolon):
//   navn,initialer,timeloen,gyldig_fra
//   Anne Lindhardt,AL,182.50,2026-01-01
// Tomme timeloen-rækker springes over (ingen sats endnu). Decimalkomma ok.
//
// Spec: docs/CLAUDE_DRIFTSREGNSKAB.md §9
// ==========================================

const express   = require('express');
const router    = express.Router();
const { getDb }     = require('../db/database');
const { handle, todayISO } = require('../db/helpers');
const { requireAuth } = require('../shared/auth');
const smartplan = require('../services/smartplanAdapter');

const ALL = requireAuth('admin');

// Hvor langt tilbage stoppede medarbejdere tages med (bagudrettede regnskaber).
const ROSTER_SINCE = '2025-01-01';

/* ---------- helpers ---------- */

const norm = (s) => (s || '').toString().trim().toLowerCase().replace(/\s+/g, ' ');

/**
 * Parse en talstreng til timeløn. Kontekst-afhængig:
 *   "1.250,75" (punktum+komma) → dansk: 1250.75
 *   "182,50"   (kun komma)     → decimalkomma: 182.50
 *   "182.50"   (kun punktum)   → engelsk decimal: 182.50
 *   "180"      (ingen)         → 180
 *
 * Og Smartplans egen løntype-tekst, så deres "Eksportér til Excel" kan
 * indsættes direkte i stedet for at satserne tastes af i hånden:
 *   "køkkenbordet assistent (145,-)"  → 145
 *   "Senior køkkenansvarlig (200,-)"  → 200
 *   "Vælg timeløn"                    → null (ingen sats valgt)
 * Uden det stopper importen på Smartplans eget format, og så bliver den
 * håndholdte liste ved med at drive fra hinanden — hvilket den ER: seks
 * satser afveg og tre manglede, målt august 2026.
 * @returns {number|null} positiv sats, eller null hvis tom/ugyldig.
 */
function parseRate(raw) {
    let s = (raw || '').trim();
    if (!s) return null;

    // Løntype-tekst med etiket: tag tallet i PARENTESEN. Kun dér — et tal andre
    // steder i strengen kan være hvad som helst ("assistent 2"), og et gæt på en
    // timeløn er værre end at afvise rækken. (Sådan ser den ud hvis man kopierer
    // fra Smartplans skærm frem for at eksportere.)
    if (/[a-zA-ZæøåÆØÅ]/.test(s)) {
        const m = s.match(/\(\s*([\d.,]+)\s*,?-?\s*\)/);
        if (!m) return null;
        s = m[1];
    }

    // Dansk regnskabsnotation for "hele kroner": 145,- betyder 145,00.
    // Smartplans eksport skriver netop sådan. Uden dette blev "145,-" til
    // "145.-" og dermed NaN, og HELE eksporten blev sprunget over uden en fejl:
    // parseRate returnerer null, og null-rækker filtreres bare fra.
    s = s.replace(/,\s*-\s*$/, '').replace(/\s*(kr\.?|dkk)\s*$/i, '').trim();

    if (s.includes('.') && s.includes(',')) s = s.replace(/\./g, '').replace(',', '.'); // dansk tusind+decimal
    else if (s.includes(',')) s = s.replace(',', '.');                                  // decimalkomma
    const n = Number(s);
    return (Number.isFinite(n) && n > 0) ? n : null;
}

/** Parse løn-CSV → [{ navn, initialer, timeloen:Number, gyldig_fra }] (kun rækker med sats). */
function parseWageCsv(text) {
    // Strip evt. UTF-8 BOM (Excel/Numbers tilføjer den foran headeren).
    const lines = String(text || '').replace(/^﻿/, '').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    if (!lines.length) return { rows: [], error: 'Tom CSV.' };

    const NAME  = ['navn', 'name', 'medarbejder', 'fulde navn'];
    // Smartplans eksport deler navnet i to kolonner. Uden dem finder parseren
    // ingen navne-kolonne og afviser hele filen.
    const FIRST = ['fornavn', 'first_name', 'firstname'];
    const LAST  = ['efternavn', 'last_name', 'lastname'];
    const INIT  = ['initialer', 'init', 'initials'];
    // 'løntype' er Smartplans eget navn på sats-kolonnen.
    const RATE  = ['timeloen', 'timeløn', 'sats', 'hourly_rate', 'rate', 'loen', 'løn', 'løntype', 'lontype', 'loentype'];
    const FROM  = ['gyldig_fra', 'gyldigfra', 'valid_from', 'fra', 'dato'];

    // Find header-linjen + delimiter robust: Numbers/Excel-eksport lægger ofte en
    // titel-linje øverst, og dansk locale bruger ';'. Detektér delimiter FRA
    // header-linjen (ikke linje 0), og spring titel-/tomme linjer over.
    let headerIdx = -1, delim = ',';
    let iName = -1, iFirst = -1, iLast = -1, iInit = -1, iRate = -1, iFrom = -1;
    for (let i = 0; i < lines.length; i++) {
        const d = lines[i].includes(';') ? ';' : ',';
        const h = splitCsvLine(lines[i], d).map(x => norm(x));
        const col = (names) => h.findIndex(x => names.includes(x));
        const ri = col(RATE), ni = col(NAME), fi = col(FIRST), li = col(LAST), ii = col(INIT);
        // Navnet kan komme som ÉN kolonne, som fornavn+efternavn, eller som
        // initialer. Ét af dem er nok — sammen med en sats.
        if (ri !== -1 && (ni !== -1 || fi !== -1 || ii !== -1)) {
            headerIdx = i; delim = d;
            iRate = ri; iName = ni; iFirst = fi; iLast = li; iInit = ii; iFrom = col(FROM);
            break;
        }
    }

    if (headerIdx === -1) {
        return { rows: [], error: 'CSV mangler kolonner. Kræver en sats (timeloen/løntype) + enten navn, fornavn eller initialer.' };
    }

    const rows = [];
    for (let i = headerIdx + 1; i < lines.length; i++) {
        const c = splitCsvLine(lines[i], delim);
        const rate = parseRate((c[iRate] || '').trim());
        if (rate == null) continue;                 // ingen/ugyldig sats → spring over
        if (!Number.isFinite(rate) || rate <= 0) continue;
        const from = iFrom !== -1 && (c[iFrom] || '').trim() ? (c[iFrom] || '').trim() : null;
        // Fornavn + efternavn sættes sammen i samme rækkefølge som rosteren
        // bygger sit navn ([first_name, last_name].join(' ')), så navne-matchet
        // rammer. En hel navne-kolonne vinder hvis begge dele findes.
        const navn = iName !== -1 && (c[iName] || '').trim()
            ? (c[iName] || '').trim()
            : [iFirst !== -1 ? (c[iFirst] || '').trim() : '',
               iLast  !== -1 ? (c[iLast]  || '').trim() : ''].filter(Boolean).join(' ');

        rows.push({
            navn,
            initialer: iInit !== -1 ? (c[iInit] || '').trim() : '',
            timeloen:  rate,
            gyldig_fra: from,
        });
    }
    return { rows, error: null };
}

const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');

/** Citat-bevidst CSV-split: respekterer "felt med , komma" og dobbelt-quote escaping. */
function splitCsvLine(line, delim) {
    const out = [];
    let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
        const ch = line[i];
        if (inQ) {
            if (ch === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else inQ = false; }
            else cur += ch;
        } else if (ch === '"') inQ = true;
        else if (ch === delim) { out.push(cur); cur = ''; }
        else cur += ch;
    }
    out.push(cur);
    return out.map(s => s.trim());
}

/** Genopbyg valid_to-kæden for én medarbejder ud fra valid_from-rækkefølge. */
function rebuildChain(db, ref) {
    const rows = db.prepare(
        'SELECT id, valid_from FROM wage_rates WHERE smartplan_ref = ? ORDER BY valid_from'
    ).all(ref);
    const upd = db.prepare('UPDATE wage_rates SET valid_to = ? WHERE id = ?');
    for (let i = 0; i < rows.length; i++) {
        upd.run(i < rows.length - 1 ? rows[i + 1].valid_from : null, rows[i].id);
    }
}

/* ---------- GET — roster + nuværende satser ---------- */
// Returnerer hele løn-rosteren (nuværende + stoppede med historiske worklogs)
// joinet med seneste sats, så UI kan vise hvem der mangler en sats. Falder
// tilbage til DB-distinct hvis Smartplan er nede.
router.get('/', ALL, handle(async (req, res) => {
    const db = getDb();
    const since = /^\d{4}-\d{2}-\d{2}$/.test(req.query.since) ? req.query.since : ROSTER_SINCE;
    let roster = [];
    try {
        roster = await smartplan.withCaller('wage_rates:liste', () => smartplan.getLaborRoster(since));
    } catch {
        roster = db.prepare(
            'SELECT DISTINCT smartplan_ref AS uuid, employee_name AS name FROM wage_rates'
        ).all().map(r => ({ ...r, initials: null, active: false, last_shift: null }));
    }

    const latest = db.prepare(`
        SELECT smartplan_ref, hourly_rate, valid_from
          FROM wage_rates w
         WHERE valid_to IS NULL
            OR valid_from = (SELECT MAX(valid_from) FROM wage_rates WHERE smartplan_ref = w.smartplan_ref)
    `).all();
    const byRef = new Map(latest.map(r => [r.smartplan_ref, r]));

    const out = roster.map(m => {
        const cur = byRef.get(m.uuid);
        return {
            uuid:        m.uuid,
            name:        m.name,
            initials:    m.initials || null,
            active:      m.active !== false,
            last_shift:  m.last_shift || null,
            hourly_rate: cur ? Number(cur.hourly_rate) : null,
            valid_from:  cur ? cur.valid_from : null,
            has_rate:    !!cur,
        };
    });
    res.json({ employees: out });
}));

/** Match CSV-rækker mod roster, upsert + genopbyg kæder. Ren funktion (testbar). */
function importWageRows(db, rows, roster, today) {
    // Navn er primær nøgle (entydigt). Initialer kun som fallback OG kun når de
    // er unikke i rosteren — to "Anne'r" kan dele initialer (AL), så initial-match
    // alene ville koble forkert.
    const byName = new Map();
    const initCount = new Map();
    for (const m of roster) {
        if (m.name) byName.set(norm(m.name), m);
        if (m.initials) initCount.set(norm(m.initials), (initCount.get(norm(m.initials)) || 0) + 1);
    }
    const byInit = new Map();
    for (const m of roster) {
        if (m.initials && initCount.get(norm(m.initials)) === 1) byInit.set(norm(m.initials), m);
    }

    const upsert = db.prepare(`
        INSERT INTO wage_rates (smartplan_ref, employee_name, hourly_rate, valid_from)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(smartplan_ref, valid_from)
        DO UPDATE SET hourly_rate = excluded.hourly_rate,
                      employee_name = excluded.employee_name
    `);

    const result = { imported: 0, unmatched: [], invalid: [] };
    const touched = new Set();

    for (const r of rows) {
        const m = (r.navn && byName.get(norm(r.navn))) || (r.initialer && byInit.get(norm(r.initialer)));
        if (!m) { result.unmatched.push(r.navn || r.initialer); continue; }

        const from = r.gyldig_fra || today;
        if (!isDate(from)) { result.invalid.push(`${m.name}: ugyldig dato "${r.gyldig_fra}"`); continue; }

        upsert.run(m.uuid, m.name, r.timeloen, from);
        touched.add(m.uuid);
        result.imported++;
    }

    for (const ref of touched) rebuildChain(db, ref);
    return result;
}

/* ---------- POST /import — CSV → wage_rates ---------- */
router.post('/import', ALL, handle(async (req, res) => {
    const { csv } = req.body || {};
    const { rows, error } = parseWageCsv(csv);
    if (error) return res.status(400).json({ error });
    if (!rows.length) return res.status(400).json({ error: 'Ingen rækker med en sats fundet i CSV.' });

    // Smartplans eksport har ingen dato-kolonne. Uden et valg ville hver import
    // lave en NY sats gældende fra i dag — i stedet for at rette den forkerte
    // der allerede står. Begge dele er legitime (en lønstigning kontra en
    // rettelse), så det skal være kalderens valg, ikke en tavs default.
    const fallbackFrom = (req.body?.gyldig_fra || '').trim();
    if (fallbackFrom && !isDate(fallbackFrom)) {
        return res.status(400).json({ error: `Ugyldig "gælder fra"-dato: ${fallbackFrom}` });
    }

    const roster = await smartplan.withCaller('wage_rates:import', () => smartplan.getLaborRoster(ROSTER_SINCE));
    // dansk kalenderdato (UTC-slice ramte forkert dag nær midnat)
    res.json(importWageRows(getDb(), rows, roster, fallbackFrom || todayISO()));
}));

module.exports = router;
module.exports._test = { parseWageCsv, importWageRows, rebuildChain };
