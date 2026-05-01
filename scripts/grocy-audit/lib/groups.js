// Klassifikation af `grupper`-userfield på sellable opskrifter.
//
// SALG: Opskrifter der sælges direkte til kunder. SKAL have Catering-pris.
// HALVFABRIKATA: Opskrifter der sælges som "ingrediens" i andre opskrifter
//                (sellable=1 så Grocy kan kostprisberegne dem). Salgspris
//                må være 0 eller mangle. Kostpris SKAL være sund.
// SERVICE: Levering, service-tillæg, m.m. — flade priser, ikke vareopskrifter.
// EMBALLAGE: Bokse, skinner, etc. — har egen kostpris men ofte ingen salgspris.

const SALG_GROUPS = [
    '01 Sandwich',
    '02 Salat',
    '03 Kager',
    '04 Slider',
    '05 Drikke',
    'Frugt'
];

const HALVFABRIKATA_GROUPS = [
    'RR Produktion',
    'RR produktion Hurtig',
    'Tilbehør & Bokse'  // diskutabel — kan splittes senere hvis nogle af dem er ægte salg
];

const SERVICE_GROUPS = [
    'x- Service',
    'x-Levering'
];

const EMBALLAGE_GROUPS = [
    '06 Emballage'
];

const ARKIV_GROUPS = [
    'xgamle opskrifter'  // Leifs egen "skraldespand" — bevares uden at være aktive
];

function classifyGroup(grupper) {
    if (!grupper) return 'UKLASSIFICERET';
    if (SALG_GROUPS.includes(grupper)) return 'SALG';
    if (HALVFABRIKATA_GROUPS.includes(grupper)) return 'HALVFABRIKATA';
    if (SERVICE_GROUPS.includes(grupper)) return 'SERVICE';
    if (EMBALLAGE_GROUPS.includes(grupper)) return 'EMBALLAGE';
    if (ARKIV_GROUPS.includes(grupper)) return 'ARKIV';
    return 'UKLASSIFICERET';
}

module.exports = { SALG_GROUPS, HALVFABRIKATA_GROUPS, SERVICE_GROUPS, EMBALLAGE_GROUPS, ARKIV_GROUPS, classifyGroup };
