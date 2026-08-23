/**
 * tests/labor_location.test.js
 * ════════════════════════════════════════════════════════════
 * laborAdapter skal bære Smartplans LOKATION igennem.
 *
 * `_transformRow` byggede sin returværdi felt for felt og tabte `location` +
 * `location_class` — Smartplan-adapteren sætter dem (migration 122: 'Ristet
 * Rug' = hq, alt andet = events), drift-adapteren smed dem væk.
 *
 * Konsekvensen er ikke kosmetisk: `computeDay` lægger `labor_rows` råt ned i
 * `labor_day_snapshot`, så en dag der fryses uden feltet kan ALDRIG konteres
 * bagud på HQ vs. event. Spec: docs/CLAUDE_EVENT.md §18.2.
 *
 * Testen rammer den ÆGTE offentlige API (getLabor + getLaborMap) med Smartplan
 * og databasen stubbet i require-cachen — ikke en kopi af transformationen.
 * Begge veje testes: de deler `_transformRow` i dag, og skulle de en dag drive
 * fra hinanden, skal det fanges her.
 * ════════════════════════════════════════════════════════════
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');

/* ── Stub Smartplan + DB FØR laborAdapter loades ──────────── */

let SMARTPLAN_ROWS = [];

const spPath = require.resolve('../services/smartplanAdapter');
require.cache[spPath] = {
    id: spPath, filename: spPath, loaded: true, exports: {
        getLaborRows: async () => SMARTPLAN_ROWS,
    },
};

// Minimal db-attrap: kun de to opslag _wageRate og _roleMap laver.
const fakeDb = {
    prepare(sql) {
        if (sql.includes('smartplan_role_map')) {
            return { all: () => [{ jobtype_uuid: 'jt-kok', role_class: 'production' }] };
        }
        if (sql.includes('wage_rates')) {
            return { get: (ref) => (ref === 'emp-anne' ? { hourly_rate: 200 } : undefined) };
        }
        throw new Error('uventet SQL i test: ' + sql);
    },
};
const dbPath = require.resolve('../db/database');
require.cache[dbPath] = {
    id: dbPath, filename: dbPath, loaded: true, exports: { getDb: () => fakeDb },
};

const labor = require('../services/laborAdapter');

/* ── Fixture: to vagter samme dag, hver sin lokation ──────── */

const DATO = '2026-07-08';

function shift(over = {}) {
    return {
        employee_id: 'emp-anne', employee_name: 'Anne', date: DATO,
        jobtype_uuid: 'jt-kok', jobtype_title: 'Kok',
        planned_start: '08:00', planned_end: '16:00', planned_hours: 8,
        attendance_start: '08:00', attendance_end: '16:00', attendance_hours: 8,
        location: 'Ristet Rug', location_class: 'hq',
        ...over,
    };
}

const HQ_VAGT = shift();
const EVENT_VAGT = shift({
    employee_id: 'emp-leif', employee_name: 'Leif',
    location: 'Festivaler og Events', location_class: 'events',
});

/* ── Cases ────────────────────────────────────────────────── */

test('getLabor bærer location + location_class igennem', async () => {
    SMARTPLAN_ROWS = [HQ_VAGT, EVENT_VAGT];
    const rows = await labor.getLabor(DATO);

    assert.equal(rows.length, 2, 'begge vagter kommer med');
    const hq = rows.find(r => r.employee_name === 'Anne');
    const ev = rows.find(r => r.employee_name === 'Leif');

    assert.equal(hq.location, 'Ristet Rug', 'HQ-vagtens lokationsnavn bevares');
    assert.equal(hq.location_class, 'hq', 'HQ-vagten er klassificeret hq');
    assert.equal(ev.location, 'Festivaler og Events', 'event-vagtens lokationsnavn bevares');
    assert.equal(ev.location_class, 'events', 'event-vagten er klassificeret events');
});

test('getLaborMap (batch-vejen) bærer det samme igennem', async () => {
    SMARTPLAN_ROWS = [HQ_VAGT, EVENT_VAGT];
    const map = await labor.getLaborMap(DATO, DATO);

    const rows = map[DATO] || [];
    assert.equal(rows.length, 2, 'begge vagter grupperet på datoen');
    assert.deepEqual(
        rows.map(r => r.location_class).sort(),
        ['events', 'hq'],
        'batch-vejen taber ikke klassen'
    );
});

test('et event kan skille sine egne timer ud — grunden til feltet', async () => {
    SMARTPLAN_ROWS = [HQ_VAGT, EVENT_VAGT];
    const rows = await labor.getLabor(DATO);

    // Præcis det filter event-lønnen skal bruge (CLAUDE_EVENT.md §18.3).
    const paaPladsen = rows.filter(r => r.location_class === 'events');
    assert.equal(paaPladsen.length, 1, 'kun festivalvagten tilhører eventet');
    assert.equal(paaPladsen[0].employee_name, 'Leif');

    // ...og driftens modstykke, så HQ-dagen ikke bærer eventets timer.
    const paaHQ = rows.filter(r => r.location_class !== 'events');
    assert.equal(paaHQ.length, 1, 'HQ beholder sin egen vagt');
    assert.equal(paaHQ[0].employee_name, 'Anne');
});

test('ukendt/manglende klasse falder til hq — aldrig til et event', async () => {
    // En vagt uden lokation (Smartplan kan levere tom location.title) og en
    // med en værdi vi ikke kender. Ingen af dem må tilskrives et event: at
    // gætte forkert dér flytter løn ind i et regnskab hvor den ikke hører til.
    SMARTPLAN_ROWS = [
        shift({ employee_name: 'Uden', location: null, location_class: undefined }),
        shift({ employee_name: 'Ukendt', location: 'Noget nyt', location_class: 'vrøvl' }),
    ];
    const rows = await labor.getLabor(DATO);

    assert.equal(rows.length, 2);
    for (const r of rows) {
        assert.equal(r.location_class, 'hq', `${r.employee_name} falder til hq`);
    }
    assert.equal(rows[0].location, null, 'manglende lokationsnavn bliver null, ikke undefined');
    assert.equal(rows[1].location, 'Noget nyt', 'navnet bevares selvom klassen er ukendt');
});

test('de øvrige felter er uændrede (regression)', async () => {
    SMARTPLAN_ROWS = [HQ_VAGT, EVENT_VAGT];
    const [anne] = await labor.getLabor(DATO);

    assert.equal(anne.timer, 8, 'timer fra attendance');
    assert.equal(anne.sats, 200, 'sats fra wage_rates');
    assert.equal(anne.kostpris, 1600, 'kostpris = timer × sats');
    assert.equal(anne.role_class, 'production', 'rolle fra role_map');
    assert.equal(anne.role_unmapped, false);
    assert.equal(anne.rate_missing, false);
    assert.equal(anne.used_fallback_hours, false);
    assert.equal(anne.mode, 'realiseret');
});

test('forecast-mode bærer også lokationen', async () => {
    // forecast er den eneste tilgængelige mode på fremtidige events, så
    // feltet skal overleve BEGGE grene i _transformRow.
    SMARTPLAN_ROWS = [EVENT_VAGT];
    const [row] = await labor.getLabor(DATO, 'forecast');

    assert.equal(row.mode, 'forecast');
    assert.equal(row.location_class, 'events', 'forecast-grenen taber ikke klassen');
    assert.equal(row.location, 'Festivaler og Events');
});
