// scripts/audit-grocy-prices.js
// ============================================================
// Forkerte indkøbspriser i Grocy — og om de stadig betyder noget.
//
// HVORFOR SCRIPTET FINDES
// Grocys UI kan ikke søge på pris. En forkert postering er derfor i praksis
// umulig at finde i hånden — man opdager kun at den findes, fordi en kostpris
// pludselig er absurd. Scriptet leder i `stock_log` og skriver journal-id'et
// ud, så rækken kan slås op direkte i Lagerjournalen.
//
// HVORFOR DEN SORTERER I TRE
// Første udgave listede alle posteringer der nogensinde havde været forkerte.
// Det gav 38 rækker i produktion og lignede en arbejdsliste — men **ingen af
// dem** var et problem længere. En forkert postering betyder kun noget hvis
// den stadig er den nyeste, for det er `last_price` både Grocy og Bon læser
// først. Er der købt ind siden, er den gamle række ren historik.
//
// Det er værd at vide inden man går i gang: Grocy NÆGTER at fortryde et køb
// hvis den lagerbeholdning det skabte allerede er brugt op. Man kan altså
// ikke rydde historikken selv om man vil — og som regel behøver man det ikke.
//
// KUREN når en pris ER forkert: registrér et nyt indkøb til den rigtige pris.
// Det sætter `last_price` med det samme og kræver ingen tilladelse fra Grocy.
//
// METODE
// Hver postering holdes op mod medianen af varens ØVRIGE indkøbspriser.
// Medianen af alle duer ikke: har en vare kun to køb hvoraf det ene er fejlen,
// trækker fejlen medianen med sig og skjuler sig selv. Det skete for Stjerne
// Anis — 4.078.625 kr/kg blev først synlig da den blev holdt op mod de andre.
//
// Den hyppigste fejl er faktor ~1000 (kg/g-forveksling); næsthyppigst er
// pakkeprisen tastet som styk-pris.
//
// READ-ONLY. Måler mod grocy-hq.
//
//   node --env-file=.env scripts/audit-grocy-prices.js
//   node --env-file=.env scripts/audit-grocy-prices.js --alle   (vis også historik)
//
// Exit 1 hvis mindst én vares last_price stadig er forkert — så den kan bruges
// som tjek i en cron uden at larme over historik.
// ============================================================

'use strict';

const HQ = process.env.GROCY_HQ_URL;
const KEY = process.env.GROCY_HQ_KEY;
if (!HQ || !KEY) {
    console.error('Mangler GROCY_HQ_URL / GROCY_HQ_KEY i .env (husk --env-file=.env)');
    process.exit(2);
}
const VIS_ALLE = process.argv.includes('--alle');

// Hvor mange gange varens normale pris skal overskrides før det er en fejl.
// 8× er valgt fordi ægte prisudsving sjældent er over 3–4×, mens de fejl vi
// har set ligger på 70×, 500× og 1000×. Der er god luft imellem.
const FEJL_FAKTOR = 8;
// avg_price er kun fallback, så den skal være tydeligt skæv før den nævnes.
const AVG_FAKTOR = 2;

const g = async (path, forsoeg = 3) => {
    for (let i = 0; i < forsoeg; i++) {
        try {
            const r = await fetch(HQ + path, { headers: { 'GROCY-API-KEY': KEY } });
            if (r.ok) return r.json();
        } catch (e) { /* prøv igen */ }
        await new Promise(s => setTimeout(s, 200 * (i + 1)));
    }
    return null;
};

const pool = async (items, n, fn) => {
    const out = []; let i = 0;
    await Promise.all(Array.from({ length: n }, async () => {
        while (i < items.length) { const k = i++; out[k] = await fn(items[k]); }
    }));
    return out;
};

const median = (a) => {
    const s = [...a].sort((x, y) => x - y);
    if (!s.length) return 0;
    return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

const kr = (n) => (Number(n) || 0).toFixed(2);

(async () => {
    const [prods, pos] = await Promise.all([g('/objects/products'), g('/objects/recipes_pos')]);
    if (!prods) { console.error('Kunne ikke hente produkter'); process.exit(2); }
    const brugtIOpskrift = new Set((pos || []).map(p => String(p.product_id)));

    console.log(`\nGennemgår indkøbshistorik for ${prods.length} produkter i PRODUKTION…`);

    const fund = [];
    await pool(prods, 6, async (p) => {
        const log = await g(`/objects/stock_log?query%5B%5D=product_id%3D${p.id}&limit=500`);
        if (!Array.isArray(log)) return;

        const kob = log.filter(l => l.transaction_type === 'purchase'
                                 && String(l.undone) !== '1'
                                 && Number(l.price) > 0);
        if (kob.length < 2) return;   // uden sammenligningsgrundlag kan intet kaldes en afviger

        const priser = kob.map(l => Number(l.price));
        const erAfviger = priser.map((pris, i) => {
            const andre = priser.filter((_, j) => j !== i);
            const m = median(andre);
            return m > 0 && pris > m * FEJL_FAKTOR;
        });
        if (!erAfviger.some(Boolean)) return;

        const rene = priser.filter((_, i) => !erAfviger[i]);
        const normal = rene.length ? median(rene) : median(priser);

        const d = await g('/stock/products/' + p.id);
        const last = Number(d?.last_price) || 0;
        const avg  = Number(d?.avg_price)  || 0;

        fund.push({
            vare: p.name,
            normal,
            last, avg,
            lastGal: normal > 0 && last > normal * FEJL_FAKTOR,
            avgGal:  normal > 0 && avg  > normal * AVG_FAKTOR,
            iOpskrift: brugtIOpskrift.has(String(p.id)),
            raekker: kob.filter((_, i) => erAfviger[i]).map(l => ({
                id: l.id,
                dato: String(l.purchased_date || l.row_created_timestamp).slice(0, 10),
                maengde: Number(l.amount),
                pris: Number(l.price),
                faktor: normal > 0 ? Number(l.price) / normal : 0,
            })),
        });
    });

    if (!fund.length) {
        console.log('\n✓ Ingen varer har afvigende indkøbspriser.\n');
        return;
    }

    const haster  = fund.filter(f => f.lastGal);
    const kunAvg  = fund.filter(f => !f.lastGal && f.avgGal);
    const historik = fund.filter(f => !f.lastGal && !f.avgGal);
    const raekker = fund.reduce((s, f) => s + f.raekker.length, 0);

    console.log(`${fund.length} varer har mindst én afvigende postering (${raekker} rækker i alt).\n`);

    // ── 1. Det der faktisk skal handles på ──
    console.log(`\x1b[1m── HASTER: last_price er stadig forkert (${haster.length}) ──\x1b[0m`);
    if (!haster.length) {
        console.log('   \x1b[32mingen\x1b[0m — alle varer er købt ind siden, så de gamle rækker er ren historik\n');
    } else {
        console.log('   Kur: registrér et nyt indkøb til den rigtige pris. At fortryde den gamle');
        console.log('   postering virker sjældent — Grocy nægter når beholdningen er brugt op.\n');
        for (const f of haster.sort((a, b) => b.last - a.last)) {
            console.log(`   \x1b[31m${f.vare}\x1b[0m — last_price ${kr(f.last)}, normalt ${kr(f.normal)}`
                      + (f.iOpskrift ? '  \x1b[33m(bruges i opskrifter)\x1b[0m' : ''));
            f.raekker.forEach(r => console.log(
                `      journal-id ${String(r.id).padStart(6)} · ${r.dato} · ${r.maengde} à ${kr(r.pris)} · ${Math.round(r.faktor)}×`));
        }
        console.log('');
    }

    // ── 2. Værd at kende, men ikke i vejen ──
    console.log(`\x1b[1m── Kun avg_price forurenet (${kunAvg.length}) ──\x1b[0m`);
    console.log('   \x1b[2mavg_price bruges kun som fallback når last_price mangler. Bevares i');
    console.log('   Grocys prishistorik uanset lager, så det sker i praksis ikke.\x1b[0m');
    kunAvg.sort((a, b) => b.avg - a.avg).forEach(f => console.log(
        `   ${f.vare.padEnd(24).slice(0, 24)} last ${kr(f.last).padStart(9)} · avg ${kr(f.avg).padStart(11)} · normalt ${kr(f.normal)}`));
    if (!kunAvg.length) console.log('   ingen');

    // ── 3. Ren historik ──
    console.log(`\n\x1b[1m── Uden betydning i dag (${historik.length}) ──\x1b[0m`);
    console.log('   \x1b[2mFejlen ligger i historikken, men der er købt ind siden.\x1b[0m');
    if (VIS_ALLE) {
        historik.forEach(f => {
            console.log(`   ${f.vare} — last_price ${kr(f.last)} (normalt ${kr(f.normal)})`);
            f.raekker.forEach(r => console.log(
                `      journal-id ${String(r.id).padStart(6)} · ${r.dato} · ${r.maengde} à ${kr(r.pris)} · ${Math.round(r.faktor)}×`));
        });
    } else {
        console.log('   ' + historik.map(f => f.vare).join(' · '));
        console.log('   \x1b[2m(kør med --alle for at se posteringerne)\x1b[0m');
    }

    console.log('');
    process.exit(haster.length ? 1 : 0);
})();
