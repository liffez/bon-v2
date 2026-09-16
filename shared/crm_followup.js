/**
 * shared/crm_followup.js
 * ════════════════════════════════════════════════════════════
 * "Følg op"-vælgeren i CRM's log-formularer.
 *
 * Et service-kald eller et ringeliste-opkald er logget NU. Vil man derudover
 * huske at vende tilbage, er det en SELVSTÆNDIG række — ikke et felt på
 * opkaldet: den er planlagt (due_at sat, done_at NULL) mens opkaldet er
 * udført. To tilstande kan ikke bo i samme række (docs/CLAUDE_CRM_PLANLAGT.md §3).
 *
 * Derfor logger kaldsstederne TO aktiviteter når der er valgt en opfølgning:
 * opkaldet (type 'call'/'service_call') og opfølgningen (type 'followup').
 *
 * Findes i forvejen: 'callback' som resultat lægger kunden på Ring-tilbage-listen
 * — men UDEN dato, så "ring efter sommerferien" kunne ikke udtrykkes. Den her
 * giver datoen; de to udelukker ikke hinanden.
 *
 *   el.innerHTML = CrmFollowup.html(uid);
 *   CrmFollowup.wire(containerEl);            // viser/skjuler datofeltet
 *   const fu = CrmFollowup.read(containerEl); // → null | { due_at, text }
 *
 * `read` returnerer null når intet er valgt — kaldsstedet springer så den
 * anden POST over. Dato i fortiden afvises (en opfølgning peger fremad).
 * ════════════════════════════════════════════════════════════
 */

(function () {
    'use strict';

    // Nøglerne er dem plannedComputeWhen kender (shared/planned.js). 'none' er vores
    // egen: ingen opfølgning. Rækkefølgen er den knapperne vises i.
    const CHOICES = [
        { key: 'none',   label: 'Ingen' },
        { key: '3d',     label: 'Om 3 dage' },
        { key: '1w',     label: 'Om 1 uge' },
        { key: '2w',     label: 'Om 2 uger' },
        { key: '1m',     label: 'Om 1 måned' },
        { key: 'custom', label: 'Dato…' },
    ];

    function ensureStyles() {
        if (document.getElementById('crm-followup-styles')) return;
        const s = document.createElement('style');
        s.id = 'crm-followup-styles';
        s.textContent = `
            .cfu { margin-top: 10px; }
            .cfu-label { font-size: 11px; text-transform: uppercase; letter-spacing: .04em;
                         color: var(--color-text-dim, #888); display: block; margin-bottom: 5px; }
            .cfu-label .cfu-opt { font-weight: 400; text-transform: none; letter-spacing: 0; opacity: .7; }
            .cfu-btns { display: flex; flex-wrap: wrap; gap: 5px; }
            .cfu-btn { padding: 5px 11px; font-size: 12px; font-family: inherit; cursor: pointer;
                       border: 1px solid var(--color-border, #d7d1ca); border-radius: 6px;
                       background: #fff; color: #333; }
            .cfu-btn:hover { background: var(--brand-primary-light, #f1e6b2); }
            .cfu-btn.active { background: var(--brand-primary, #8e631f); border-color: var(--brand-primary, #8e631f); color: #fff; }
            .cfu-custom { display: none; margin-top: 7px; gap: 6px; align-items: center; flex-wrap: wrap; }
            .cfu-custom.open { display: flex; }
            .cfu-custom input { padding: 5px 7px; border: 1px solid var(--color-border, #d7d1ca);
                                border-radius: 6px; font-size: 13px; font-family: inherit; }
            .cfu-note { width: 100%; box-sizing: border-box; margin-top: 7px; padding: 6px 8px; font-size: 13px;
                        font-family: inherit; border: 1px solid var(--color-border, #d7d1ca); border-radius: 6px;
                        display: none; }
            .cfu-note.open { display: block; }
            .cfu-hint { font-size: 11px; color: var(--color-text-dim, #888); margin-top: 5px; display: none; }
            .cfu-hint.open { display: block; }
            .cfu-hint.err { color: var(--color-sentiment-neg, #b00); }
        `;
        document.head.appendChild(s);
    }

    /** Markup til én vælger. `uid` skal være unik på siden (flere kort i en liste). */
    function html(uid) {
        ensureStyles();
        const btns = CHOICES.map(c =>
            `<button type="button" class="cfu-btn${c.key === 'none' ? ' active' : ''}" data-cfu="${c.key}">${c.label}</button>`
        ).join('');
        return `
        <div class="cfu" data-cfu-root="${uid}">
            <span class="cfu-label">Følg op <span class="cfu-opt">(valgfrit)</span></span>
            <div class="cfu-btns">${btns}</div>
            <div class="cfu-custom"><input type="date" class="cfu-date"><input type="time" class="cfu-time" step="900" placeholder="kl."></div>
            <input type="text" class="cfu-note" placeholder="Hvad skal du huske? (valgfrit)">
            <div class="cfu-hint"></div>
        </div>`;
    }

    function _root(el) {
        return el && (el.matches?.('[data-cfu-root]') ? el : el.querySelector('[data-cfu-root]'));
    }

    /** Klik-håndtering: marker valg, vis datofelt + note når der ER valgt noget. */
    function wire(containerEl) {
        const root = _root(containerEl);
        if (!root || root._cfuBound) return;
        root.addEventListener('click', (e) => {
            const btn = e.target.closest('.cfu-btn');
            if (!btn) return;
            e.preventDefault();
            e.stopPropagation();
            root.querySelectorAll('.cfu-btn').forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            const key = btn.dataset.cfu;
            root.querySelector('.cfu-custom').classList.toggle('open', key === 'custom');
            root.querySelector('.cfu-note').classList.toggle('open', key !== 'none');
            _renderHint(root);
        });
        root.addEventListener('change', (e) => {
            if (e.target.closest('.cfu-date, .cfu-time')) _renderHint(root);
        });
        root._cfuBound = true;
    }

    function _selected(root) {
        return root.querySelector('.cfu-btn.active')?.dataset.cfu || 'none';
    }

    // Beregn due_at via den DELTE helper — samme regler som Kunde 360°'s
    // Hvornår-vælger, så de to ikke kan blive uenige om hvad "om 1 uge" betyder.
    function _compute(root) {
        const key = _selected(root);
        if (key === 'none') return null;
        const date = root.querySelector('.cfu-date')?.value || '';
        const time = root.querySelector('.cfu-time')?.value || '';
        if (key === 'custom' && !date) return { error: 'Vælg en dato for opfølgningen' };
        const st = window.plannedComputeWhen(key, date, time);
        // 'backdate' = brugeren valgte en dato i fortiden. En opfølgning peger fremad,
        // så det er en fejl her — ikke en bagudrettet log som i Kunde 360°.
        if (st.mode !== 'plan' || !st.due_at) return { error: 'Opfølgningen skal ligge i fremtiden' };
        return { due_at: st.due_at };
    }

    function _renderHint(root) {
        const hint = root.querySelector('.cfu-hint');
        if (!hint) return;
        const r = _compute(root);
        if (!r) { hint.className = 'cfu-hint'; hint.textContent = ''; return; }
        if (r.error) { hint.className = 'cfu-hint open err'; hint.textContent = r.error; return; }
        const f = window.plannedFmtDue(r.due_at);
        hint.className = 'cfu-hint open';
        hint.textContent = 'Lander på "Mine opfølgninger" ' + f.label + '.';
    }

    /**
     * → null (ingen opfølgning) | { error } | { due_at, text }
     * `fallbackText` bruges når brugeren ikke selv skrev noget — en opfølgning
     * uden tekst ville stå som en tom linje på dashboardet.
     */
    function read(containerEl, fallbackText) {
        const root = _root(containerEl);
        if (!root) return null;
        const r = _compute(root);
        if (!r || r.error) return r;
        const note = (root.querySelector('.cfu-note')?.value || '').trim();
        return { due_at: r.due_at, text: note || fallbackText || 'Følg op' };
    }

    /** Nulstil til "Ingen" (efter et gem, så formularen ikke bærer forrige valg videre). */
    function reset(containerEl) {
        const root = _root(containerEl);
        if (!root) return;
        root.querySelectorAll('.cfu-btn').forEach(b => b.classList.toggle('active', b.dataset.cfu === 'none'));
        root.querySelector('.cfu-custom')?.classList.remove('open');
        const note = root.querySelector('.cfu-note');
        if (note) { note.value = ''; note.classList.remove('open'); }
        const hint = root.querySelector('.cfu-hint');
        if (hint) { hint.className = 'cfu-hint'; hint.textContent = ''; }
    }

    window.CrmFollowup = { html, wire, read, reset, CHOICES };
})();
