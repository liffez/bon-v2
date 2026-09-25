/**
 * shared/crm_call_draft.js — en påbegyndt samtale-log må ikke forsvinde
 * ================================================================
 * Når man ringer rundt, noterer man stemning og note mens man taler — og
 * sender måske kunden en mail undervejs. Listerne (service-kald, ringelisten,
 * kampagne-detaljen) tegnes forfra når noget ændrer sig: en sendt mail, en
 * kollegas aktivitet via SSE. Uden hjælp forsvinder log-formularen og alt
 * hvad der stod i den, og fordi mailen tæller som "håndteret", forsvinder
 * selve kortet også.
 *
 * Dette modul giver kaldestederne tre ting — de ejer selv hvornår de bruges:
 *
 *   snapshot(formEl)            → øjebliksbillede af formularen (valg + tekst)
 *   restore(formEl, snap)       → læg det tilbage efter en gentegning
 *   same(a, b)                  → er der ændret noget siden a?
 *   askUnsaved(formEl, {onSave, onDiscard})
 *                               → "Du har noteret noget …" med Gem / Kassér /
 *                                 Fortsæt — inde i formularen, ikke en confirm()
 *                                 der kun kan svare ja/nej til ét af to spørgsmål
 *   banner(formEl, html)        → fx "✓ Mail sendt til … — log samtalen eller luk"
 *   guard(isDirtyFn)            → advar ved sidelukning mens noget er ugemt
 *
 * Snapshot'et er positionsbaseret: formularens markup er den samme før og
 * efter en gentegning, så element nr. N er det samme felt. Det gør modulet
 * uafhængigt af hver formulars egne id'er og knapper. Modulets egne indsatte
 * elementer (banner, spørgsmål) er mærket data-ccd-ui og tælles ikke med.
 */
(function () {
    'use strict';

    const UI_ATTR = 'data-ccd-ui';

    function fields(formEl) {
        if (!formEl) return [];
        return Array.from(formEl.querySelectorAll('*')).filter(el => !el.closest('[' + UI_ATTR + ']'));
    }

    function snapshot(formEl) {
        return fields(formEl).map(el => {
            const s = { c: el.className && typeof el.className === 'string' ? el.className : '' };
            if ('value' in el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) s.v = el.value;
            if (el.tagName === 'BUTTON') s.d = !!el.disabled;
            // Hint-tekster (fx opfølgningens "Lander på …") er afledt, men skal
            // stå der igen efter en gentegning.
            if (el.classList && el.classList.contains('cfu-hint')) s.t = el.textContent;
            return s;
        });
    }

    function restore(formEl, snap) {
        if (!formEl || !Array.isArray(snap)) return false;
        const els = fields(formEl);
        // Anden markup end da billedet blev taget — hellere ingenting end et
        // forkert felt fyldt ud.
        if (els.length !== snap.length) return false;
        els.forEach((el, i) => {
            const s = snap[i];
            if (typeof el.className === 'string') el.className = s.c;
            if (s.v !== undefined) el.value = s.v;
            if (s.d !== undefined) el.disabled = s.d;
            if (s.t !== undefined) el.textContent = s.t;
        });
        return true;
    }

    // Kun valg og tekst tæller som "noteret" — ikke om Gem-knappen er slået til.
    function same(a, b) {
        if (!a || !b || a.length !== b.length) return false;
        for (let i = 0; i < a.length; i++) {
            if (a[i].c !== b[i].c) return false;
            if ((a[i].v || '') !== (b[i].v || '')) return false;
        }
        return true;
    }

    let _styled = false;
    function ensureStyles() {
        if (_styled) return;
        _styled = true;
        const st = document.createElement('style');
        st.textContent = `
            .ccd-banner { display: flex; align-items: center; gap: 8px; flex-wrap: wrap;
                margin: 0 0 10px; padding: 7px 10px; border-radius: 6px; font-size: 12.5px;
                background: var(--color-sentiment-pos-bg, #E6F7F0); color: #1f5e40;
                border: 1px solid var(--color-sentiment-pos, #2E9E6B); }
            .ccd-ask { margin: 10px 0 0; padding: 9px 10px; border-radius: 6px; font-size: 12.5px;
                background: #fef3cd; border: 1px solid #e0c36b; color: #5c4400;
                display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
            .ccd-ask b { margin-right: auto; }
            .ccd-ask button { padding: 4px 10px; border-radius: 6px; font: inherit; font-size: 12px; cursor: pointer;
                border: 1px solid var(--color-border, #d7d1ca); background: #fff; color: #333; }
            .ccd-ask button.ccd-save { background: var(--brand-primary, #8e631f); color: #fff; border-color: transparent; }
            .ccd-ask button.ccd-discard { color: var(--color-sentiment-neg, #c94040); }
        `;
        document.head.appendChild(st);
    }

    function banner(formEl, html) {
        if (!formEl) return;
        ensureStyles();
        let b = formEl.querySelector(':scope > .ccd-banner');
        if (!html) { if (b) b.remove(); return; }
        if (!b) {
            b = document.createElement('div');
            b.className = 'ccd-banner';
            b.setAttribute(UI_ATTR, '1');
            formEl.insertBefore(b, formEl.firstChild);
        }
        b.innerHTML = html;
    }

    /**
     * Spørg før noget noteret smides væk. Tre svar, fordi der er tre ønsker:
     * gem det, smid det væk, eller "ups, jeg var ikke færdig".
     */
    function askUnsaved(formEl, { onSave, onDiscard, text } = {}) {
        if (!formEl) return;
        ensureStyles();
        const old = formEl.querySelector('.ccd-ask');
        if (old) old.remove();
        const box = document.createElement('div');
        box.className = 'ccd-ask';
        box.setAttribute(UI_ATTR, '1');
        box.innerHTML = '<b>' + (text || 'Du har noteret noget, der ikke er gemt.') + '</b>' +
            '<button type="button" class="ccd-save">Gem</button>' +
            '<button type="button" class="ccd-discard">Kassér</button>' +
            '<button type="button" class="ccd-keep">Fortsæt</button>';
        formEl.appendChild(box);
        box.addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) return;
            e.preventDefault();
            e.stopPropagation();
            box.remove();
            if (btn.classList.contains('ccd-save') && onSave) onSave();
            else if (btn.classList.contains('ccd-discard') && onDiscard) onDiscard();
        });
        // 'center', ikke 'nearest': på mobilen ville boksen ellers lægge sig bag
        // den faste bundmenu.
        box.scrollIntoView && box.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    // Sidelukning/genindlæsning mens noget er ugemt. Hvert kaldested registrerer
    // sin egen "er der noget?"-funktion; browseren viser sin standardbesked.
    const _guards = new Set();
    function guard(fn) {
        _guards.add(fn);
        return () => _guards.delete(fn);
    }
    function anyDirty() {
        for (const fn of _guards) { try { if (fn()) return true; } catch (_) { /* en fejl må ikke spærre siden */ } }
        return false;
    }
    if (typeof window !== 'undefined' && window.addEventListener) {
        window.addEventListener('beforeunload', (e) => {
            if (!anyDirty()) return;
            e.preventDefault();
            e.returnValue = '';
        });
    }

    window.CrmCallDraft = { snapshot, restore, same, askUnsaved, banner, guard, anyDirty };
})();
