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
     * label:      Vises på knapper og filtre (konfigurerbar via settings)
     * color:      Baggrund på aktiv knap, venstre strip og kalender-blok
     * text:       Tekstfarve på aktiv knap ('white' eller mørk hex)
     * cardButton: false = statussen vises IKKE som knap på bon-kortet i views
     *             der ellers viser alle statusser (VIEW_WINDOWS 'all'). Den har
     *             stadig label og farve, så den kan vises og filtreres.
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
        // Aflyst er ikke et trin i sekvensen — men den skal have label og farve
        // ét sted. Manglede den her, viste bon-draweren INGEN aktiv status på en
        // aflyst bon (bonen så statusløs ud), og kalenderen måtte holde sin egen
        // kopi for at kunne filtrere. Grå, ikke rød: den er ude af spil, og rød
        // er allerede AFSLUTTET. cardButton:false — køkkenkortene skal ikke have
        // et aflys-klik ved siden af KLAR; aflysning hører til i draweren.
        'aflyst':     { label: 'AFLYST',      color: '#8a8a8a', text: '#ffffff', cardButton: false },
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
