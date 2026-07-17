/**
 * BonConfig.js
 * ════════════════════════════════════════════════════════════
 * Central konfiguration for Bon v2 status-system.
 * Rettes ét sted — virker i alle views og komponenter.
 *
 * På sigt erstattes denne fil af et API-kald mod backend/settings.
 * ════════════════════════════════════════════════════════════
 */

const BON_CONFIG = {

    /**
     * Statusser
     * label:   Vises på knapper og filtre (konfigurerbar via settings)
     * color:   Baggrund på aktiv knap, venstre strip og kalender-blok
     * text:    Tekstfarve på aktiv knap ('white' eller mørk hex)
     */
    statuses: {
        'ny':         { label: 'NY',          color: '#8090b0', text: '#ffffff' },
        'venter':     { label: 'VENTER INFO', color: '#d4aa20', text: '#4a3a00' },
        'godkendt':   { label: 'GODKENDT',    color: '#5aa05a', text: '#ffffff' },
        'igang':      { label: 'IGANG',       color: '#d4781a', text: '#ffffff' },
        'klar':       { label: 'KLAR',        color: '#2e8b2e', text: '#ffffff' },
        'lev':        { label: 'LEV',         color: '#ffffff', text: '#333333' },
        'faktureret': { label: 'FAKTURERET',  color: '#9040b0', text: '#ffffff' },
        'betalt':     { label: 'BETALT',      color: '#e020a0', text: '#ffffff' },
        'afsluttet':  { label: 'AFSLUTTET',   color: '#cc2020', text: '#ffffff' },
        'tilbud':     { label: 'TILBUD',      color: '#b0b8c8', text: '#333333' },
    },

    /**
     * Sekventiel rækkefølge for fremrykning.
     * TILBUD er et separat spor — se tilbudTarget.
     */
    sequence: [
        'ny', 'venter', 'godkendt', 'igang', 'klar',
        'lev', 'faktureret', 'betalt', 'afsluttet'
    ],

    /**
     * Status som TILBUD konverteres til ved godkendelse.
     */
    tilbudTarget: 'godkendt',

    /**
     * Betalingstyper der springer 'faktureret' over i sekvensen.
     * VÆRDIERNE ER payment_types.code — ikke labels. ('kontant' stod her før og
     * ramte aldrig, fordi koden er 'cash'.)
     */
    skipFaktureret: ['cash', 'barter', 'sponsorship'],
};
