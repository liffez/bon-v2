// utils/buildId.js
// ==========================================
// Et id der skifter når den kode BROWSEREN kører er blevet skiftet ud.
//
// Bruges af shared/sse.js: id'et sendes med i 'connected'-eventet, og
// klienten (shared/utils.js) opdager at den kører gammel kode når id'et
// ændrer sig midt i en session.
//
// Hvorfor mtime og ikke git-sha: serveren er et git-checkout i dag, men
// skal ikke være afhængig af det — hverken af at .git findes, eller af at
// kunne starte en git-proces ved boot. `git pull` rører netop de filer der
// blev ændret, så nyeste mtime i klient-mapperne er et ærligt svar på
// "er der kommet ny frontend-kode siden sidst".
//
// Id'et beregnes ÉN gang ved opstart. Det er det rigtige: en deploy her
// er git pull + systemctl restart, så processens levetid er præcis den
// periode hvor koden ligger fast.
// ==========================================

const fs   = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// Kun de mapper browseren henter kode fra. Server-kode (routes/, services/,
// db/) er bevidst udenfor: en ændring dér kræver en genstart, ikke en
// genindlæsning i brugerens fane — og ville give en "ny version"-besked som
// brugeren ikke kan gøre noget ved.
const CLIENT_DIRS = ['office', 'shared', 'kitchen', 'mobile', 'settings', 'views'];
const CLIENT_EXT  = new Set(['.js', '.html', '.css']);

// Mapper der ikke er kilde — de ville gøre beregningen langsom og støjende.
const SKIP_DIRS = new Set(['node_modules', '.git', '.claude']);

/**
 * Gå mappen igennem og saml nyeste mtime + antal filer.
 *
 * Antallet tælles med, fordi en deploy der kun SLETTER en fil ikke flytter
 * nogen mtime. Uden tælleren ville den ændring være usynlig.
 */
function scan(dir, acc) {
    let entries;
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        return acc;   // mappen findes ikke i denne installation — spring den over
    }
    for (const entry of entries) {
        if (entry.isDirectory()) {
            if (SKIP_DIRS.has(entry.name)) continue;
            scan(path.join(dir, entry.name), acc);
            continue;
        }
        if (!CLIENT_EXT.has(path.extname(entry.name))) continue;
        try {
            const st = fs.statSync(path.join(dir, entry.name));
            if (st.mtimeMs > acc.newest) acc.newest = st.mtimeMs;
            acc.count++;
        } catch (err) { /* filen forsvandt under scanningen — den tæller bare ikke med */ }
    }
    return acc;
}

let cached = null;

/**
 * Build-id som kort streng, fx "742-mc3k1f9".
 *
 * Værdien er kun til SAMMENLIGNING — klienten spørger "er den anderledes
 * end den jeg startede på", aldrig "er den nyere". Derfor gør det ikke
 * noget at en rulle-tilbage giver et lavere tal.
 */
function buildId() {
    if (cached) return cached;
    const acc = { newest: 0, count: 0 };
    for (const dir of CLIENT_DIRS) scan(path.join(ROOT, dir), acc);
    // Ingen filer fundet (uventet — men så er et fast id bedre end at kalde
    // alting "ny version" ved hver genstart).
    cached = acc.count === 0
        ? 'ukendt'
        : `${acc.count}-${Math.floor(acc.newest).toString(36)}`;
    return cached;
}

module.exports = { buildId };
