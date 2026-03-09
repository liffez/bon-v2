/**
 * BonConfigBar.js
 * ════════════════════════════════════════════════════════════
 * Definerer status-vinduer per view.
 *
 * BON-KORT: Hvilke status-knapper vises på kortet i dette view?
 * VIEW-FILTER: Hvilke statusser kan slås til/fra som filter
 *              øverst i kalender og planlægning?
 *
 * null = alle statusser (ingen filtrering)
 * ════════════════════════════════════════════════════════════
 */

const VIEW_WINDOWS = {

    /**
     * Køkken I Dag
     * Bons der skal laves/afleveres i dag.
     * Statusser der er relevante for køkkenet nu.
     */
    'kitchen-today': ['igang', 'klar', 'lev'],

    /**
     * Køkken Senere
     * Fremtidige bons køkkenet skal kende til.
     * Inkluderer tilbud så køkkenet kan planlægge.
     */
    'kitchen-later': ['tilbud', 'venter', 'godkendt', 'igang', 'klar'],

    /**
     * Faktura
     * Bons klar til eller under fakturering.
     */
    'invoice': ['lev', 'faktureret', 'betalt', 'afsluttet'],

    /**
     * Kalender og Planlægning
     * Alle statusser vises — toggle-filter styres på view-niveau.
     * Kortet viser alle statusser som knapper.
     */
    'all': null,
};
