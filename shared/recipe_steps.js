// shared/recipe_steps.js
// ==========================================
// Fremgangsmåden: trin med valgfri tid, i Grocys ENE beskrivelsesfelt.
//
// HVAD FELTET FAKTISK INDEHOLDER (målt på grocy-hq 21.09.2026)
// 34 af 131 opskrifter har en beskrivelse. **32 af dem er HTML** — `<p>`,
// `<ul><li>`, `<span style="font-size:13.6px">`, `<br>`, `<div>`, `<a>` —
// skrevet i Grocys egen editor. Den rå visning (R9.2) er altså IKKE
// undtagelsen; den er tilstanden i dag, og løftet om at ingen data går tabt
// er det der bærer hele feltet.
//
// ⚠️ Nummererede trin FINDES i drift — de er bare ikke til at se i råteksten.
// Den første måling talte hvor mange beskrivelser der *begynder* med "1." og
// fandt nul. Men Grocys editor pakker tallet ind (`<span>\t</span>1.<span>`),
// så en nummereret liste begynder aldrig strengen. Efter at tags er fjernet,
// er `Falaffel- stegning` (97) seks rigtige trin. Trin-tilstanden er derfor
// nået i drift, og round-trippet nedenfor er ikke teoretisk.
//
// TRE RETTELSER TIL SPECENS §9.2
//   1. Der skrives HTML, ikke ren tekst. Grocy RENDERER feltet som HTML, så
//      linjeskift i ren tekst ville blive klappet sammen til ét afsnit — og
//      køkkenet læser det på skærmen. Trinnene skrives derfor som `<p>`-linjer,
//      som både renderer rigtigt og parser tilbage identisk.
//   2. Et uændret felt skrives ALDRIG om. `toStore` returnerer den oprindelige
//      tekst byte for byte, så diffen ikke ser en ændring (I4/R9.3). Det gælder
//      også når kalderen slet ikke nævner beskrivelsen: `steps === undefined`
//      betyder "ikke rørt", ikke "tom". Uden dét ville et Gem der handler om
//      noget helt andet omskrive feltet — målt på 97: 1496 → 680 tegn.
//   3. Linjer FØR det første nummer er en overskrift ("Tilberedning") og bæres
//      med som `lead`. De er ikke trin, men de er heller ikke vores at slette
//      første gang nogen retter et trin.
//
// ⚠️ Når trinnene FØRST er rettet, skrives feltet som `<p>`-linjer, og
// `<ul>`-strukturen fra Grocys editor går tabt. Det er en envejsændring, og
// den skal siges på skærmen — "vis rå tekst" (R9.4) viser præcis hvad der gemmes.
// ==========================================

(function (root, factory) {
    const api = factory();
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.RecipeSteps = api;
})(typeof self !== 'undefined' ? self : this, function () {

    /** Linjen der skiller fremgangsmåden fra importens note (R9.5). */
    const NOTE_PREFIX = 'Importnote:';

    // Grocy gemmer UTF-8 direkte — der er NUL navngivne entiteter i de 34
    // beskrivelser i drift. Listen er et værn, ikke et målt behov: kommer teksten
    // ind udefra (import, klip fra en hjemmeside), skal æøå kunne læses. En entitet
    // vi IKKE kender lades stå som den er frem for at blive gettet på — den er grim
    // på skærmen, men `raw` bærer stadig sandheden.
    const ENTITETER = {
        amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0',
        aelig: 'æ', oslash: 'ø', aring: 'å',
        AElig: 'Æ', Oslash: 'Ø', Aring: 'Å',
        eacute: 'é', deg: '°', frac12: '½', frac14: '¼', hellip: '…',
        ndash: '–', mdash: '—', rsquo: '’', lsquo: '‘',
        ldquo: '“', rdquo: '”',
    };

    function afkod(s) {
        return String(s == null ? '' : s)
            .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
            .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
            // Eksakt navn først: `&AElig;` og `&aelig;` er to forskellige tegn.
            .replace(/&([a-z]+);/gi, (m, n) =>
                (n in ENTITETER ? ENTITETER[n]
                 : n.toLowerCase() in ENTITETER ? ENTITETER[n.toLowerCase()] : m));
    }

    /**
     * HTML → læsbare linjer. Blok-tags bliver til linjeskift, resten falder væk.
     * Feltet kan lige så godt være ren tekst — så sker der ingenting.
     *
     * Tabulatorer og hårde mellemrum inde i en linje er Grocy-editorens
     * indrykning (`<span>\t</span>`), ikke indhold. De klappes sammen til ét
     * mellemrum, så et trin ikke bærer usynlig formatering videre.
     */
    function tilLinjer(raw) {
        const s = String(raw == null ? '' : raw);
        if (!s.trim()) return [];
        return afkod(s
                .replace(/\r\n?/g, '\n')
                .replace(/<\s*br\s*\/?\s*>/gi, '\n')
                .replace(/<\s*\/\s*(p|div|li|ul|ol|h[1-6]|tr)\s*>/gi, '\n')
                .replace(/<\s*(p|div|li|ul|ol|h[1-6]|tr)\b[^>]*>/gi, '\n')
                .replace(/<[^>]*>/g, ''))
            .split('\n')
            .map(l => l.replace(/[\t\u00a0 ]+/g, ' ').trim())
            .filter(l => l !== '');
    }

    /** `[4 min]`, `[4min]`, `[4 m]` sidst på linjen. Returnerer tekst uden den. */
    function traekTid(linje) {
        const m = String(linje).match(/\s*\[\s*(\d+(?:[.,]\d+)?)\s*(?:min|m|minutter)?\s*\]\s*$/i);
        if (!m) return { text: String(linje).trim(), minutes: null };
        const n = Number(String(m[1]).replace(',', '.'));
        return {
            text: String(linje).slice(0, m.index).trim(),
            minutes: Number.isFinite(n) ? n : null,
        };
    }

    /** Linjen indleder et trin: `1.` eller `1)` (R9.1). */
    const erTrinStart = (l) => /^\s*\d+\s*[.)]\s+\S/.test(l);

    /**
     * Læs beskrivelsesfeltet.
     *
     * @returns {{
     *   mode: 'steps'|'raw',
     *   steps: [{text, minutes}],
     *   lead: string|null,     // linjer før det første nummer (overskrift)
     *   note: string|null,     // Importnotens tekst UDEN præfikslinjen
     *   raw: string,           // præcis det Grocy har — bruges af toStore
     *   plain: string,         // læsbar tekst uden tags (rå-visningen)
     * }}
     */
    function parseDescription(raw) {
        const alle = tilLinjer(raw);

        // Importnoten tages af FØRST: den er ikke fremgangsmåde, og dens linjer
        // må ikke ende som trin (R9.5).
        let note = null;
        const i = alle.findIndex(l => l.toLowerCase().startsWith(NOTE_PREFIX.toLowerCase()));
        let linjer = alle;
        if (i >= 0) {
            const første = alle[i].slice(NOTE_PREFIX.length).trim();
            note = [første, ...alle.slice(i + 1)].filter(Boolean).join('\n');
            linjer = alle.slice(0, i);
        }

        // Trin-tilstand kræver at der FINDES en nummereret linje. Uden den er
        // feltet fri tekst fra Grocy, og så røres det ikke.
        const steps = [];
        const lead = [];
        if (linjer.some(erTrinStart)) {
            for (const l of linjer) {
                if (erTrinStart(l)) {
                    steps.push(traekTid(l.replace(/^\s*\d+\s*[.)]\s*/, '')));
                } else if (steps.length) {
                    // Ombrudt linje hører til trinnet ovenfor — ellers ville en
                    // linje uden nummer forsvinde.
                    const s = steps[steps.length - 1];
                    s.text = (s.text + ' ' + l).trim();
                } else {
                    // Før det første nummer: en overskrift. Den er ikke et trin,
                    // men den skal med tilbage når feltet skrives om.
                    lead.push(l);
                }
            }
        }

        return {
            mode: steps.length ? 'steps' : 'raw',
            steps,
            lead: lead.length ? lead.join('\n') : null,
            note,
            raw: String(raw == null ? '' : raw),
            plain: alle.join('\n'),
        };
    }

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function afsnit(tekst) {
        return String(tekst == null ? '' : tekst).split('\n')
            .map(l => l.trim()).filter(Boolean)
            .map(l => '<p>' + esc(l) + '</p>');
    }

    /**
     * Trin → det der gemmes i Grocy.
     *
     * `<p>` pr. linje, fordi Grocy renderer feltet som HTML: ren tekst med
     * linjeskift ville blive ét afsnit på skærmen.
     */
    function serializeSteps(steps, note, lead) {
        const dele = afsnit(lead);
        (steps || [])
            .filter(s => String(s && s.text || '').trim() !== '')
            .forEach((s, i) => {
                const tid = (s.minutes != null && s.minutes !== '' && Number(s.minutes) > 0)
                    ? ' [' + String(s.minutes).replace('.', ',') + ' min]' : '';
                dele.push('<p>' + (i + 1) + '. ' + esc(String(s.text).trim()) + esc(tid) + '</p>');
            });
        const n = String(note == null ? '' : note).trim();
        if (n) dele.push('<p>' + esc(NOTE_PREFIX) + '</p>', ...afsnit(n));
        return dele.join('');
    }

    /** Fri tekst → HTML, så linjeskift overlever Grocys rendering. */
    function serializePlain(plain) {
        return afsnit(plain).join('');
    }

    function trinEns(a, b) {
        const A = (a || []).filter(s => String(s && s.text || '').trim() !== '');
        const B = (b || []).filter(s => String(s && s.text || '').trim() !== '');
        if (A.length !== B.length) return false;
        return A.every((s, i) =>
            String(s.text).trim() === String(B[i].text).trim() &&
            (s.minutes == null ? null : Number(s.minutes)) === (B[i].minutes == null ? null : Number(B[i].minutes)));
    }

    const tekstEns = (a, b) => String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim();

    /**
     * Hvad skal stå i beskrivelsesfeltet efter Gem?
     *
     * Er intet rørt, returneres det OPRINDELIGE byte for byte — så diffen ikke
     * ser en ændring, og et Gem uden ændringer skriver intet (I4/R9.3). Det er
     * afgørende netop fordi feltet i drift er HTML: uden dette ville første Gem
     * på hver af de 32 opskrifter omskrive deres formatering.
     *
     * `steps === undefined` er "ikke rørt"; `steps: []` er "ryddet". De to må
     * ikke forveksles — kalderen nævner ofte slet ikke beskrivelsen.
     *
     * @param parsed  resultatet af parseDescription
     * @param edited  { steps, note, lead, plain } — som brugeren har dem nu
     */
    function toStore(parsed, edited) {
        const e = edited || {};
        const trinRørt = e.steps !== undefined;
        const noteEns = tekstEns(e.note === undefined ? parsed.note : e.note, parsed.note);
        const leadEns = tekstEns(e.lead === undefined ? parsed.lead : e.lead, parsed.lead);
        const nyNote = e.note === undefined ? parsed.note : e.note;
        const nyLead = e.lead === undefined ? parsed.lead : e.lead;

        if (parsed.mode === 'steps') {
            if ((!trinRørt || trinEns(parsed.steps, e.steps)) && noteEns && leadEns) return parsed.raw;
            return serializeSteps(trinRørt ? e.steps : parsed.steps, nyNote, nyLead);
        }

        // Rå tilstand: brugeren har set teksten uden tags. Er den uændret, må
        // feltet ikke røres — HTML'en bliver stående som den er.
        const plainEns = tekstEns(e.plain === undefined ? parsed.plain : e.plain, parsed.plain);
        const harTrin = trinRørt && e.steps.length > 0;
        if (!harTrin && plainEns && noteEns && leadEns) return parsed.raw;
        if (harTrin) {
            // Den fri tekst må ALDRIG forsvinde fordi der kom et trin til.
            // Fem linjers arbejdsbeskrivelse fra Grocy blev tidligere kasseret
            // her — usynligt, fordi editoren heller ikke viste den. Den står nu
            // foran trinene; ryddes feltet, er det brugerens eget valg.
            const p = e.plain === undefined ? parsed.plain : e.plain;
            const foran = String(p == null ? '' : p).trim() ? serializePlain(p) : '';
            return foran + serializeSteps(e.steps, nyNote, nyLead);
        }

        const hale = String(nyNote == null ? '' : nyNote).trim();
        return serializePlain(e.plain === undefined ? parsed.plain : e.plain) +
            (hale ? serializeSteps([], hale) : '');
    }

    /** Samlet tid, som overblikket viser. null når intet trin har en tid. */
    function totalMinutes(steps) {
        const tal = (steps || []).map(s => Number(s && s.minutes)).filter(n => Number.isFinite(n) && n > 0);
        return tal.length ? tal.reduce((a, b) => a + b, 0) : null;
    }

    return { parseDescription, serializeSteps, serializePlain, toStore, totalMinutes,
             tilLinjer, traekTid, erTrinStart, NOTE_PREFIX };
});
