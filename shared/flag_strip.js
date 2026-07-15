/**
 * shared/flag_strip.js
 * ════════════════════════════════════════════════════════════
 * Renderer aktive flag (påmindelser) på en bons kunde/firma som
 * collapsible strip — bruges i bon-drawer.
 *
 * Forventer at have FlagStrip + esc() + ackFlagApi() + dismissFlagApi()
 * tilgængelige globalt (utils.js + api.js).
 *
 * API:
 *   const strip = new FlagStrip(containerEl, {
 *       bonId: 1234,
 *       onChange: () => drawer.load(bonId),
 *   });
 *   strip.setBonId(bonId);
 *   strip.setFlags(bon.flags);   // fra GET /api/bons/:id
 *   strip.forceExpand();         // når åbnet via 🚩-klik i listview
 *
 * Spec: docs/CLAUDE_KUNDE_FLAGS.md
 * ════════════════════════════════════════════════════════════
 */

class FlagStrip {
    constructor(container, opts) {
        this.el       = container;
        this.bonId    = opts.bonId || null;
        this.onChange = opts.onChange || (() => {});
        this.flags    = [];
        this.expanded = null;   // null = auto (1 = open, 2+ = collapsed); true/false = forceret
        // Read-only mode (køkken): kun køkken-synlige påmindelser, ingen Forstået/Fjern.
        // Kontoret styrer livscyklus fra office-draweren.
        this.readOnly = opts.readOnly || false;
    }

    setBonId(bonId) {
        // Når draweren skifter bon, nulstil expand-tilstand så ny bon bruger
        // default-heuristik (1 flag = åben, 2+ = lukket).
        if (bonId !== this.bonId) this.expanded = null;
        this.bonId = bonId;
    }

    setFlags(flags) {
        this.flags = Array.isArray(flags) ? flags : [];
        this.render();
    }

    /** Kaldes når draweren skifter til en anden bon. Resetter auto-collapse-heuristik. */
    resetExpansion() { this.expanded = null; }

    forceExpand() {
        this.expanded = true;
        this.render();
    }

    render() {
        // Read-only (køkken): kun køkken-synlige påmindelser.
        const visible = this.readOnly
            ? this.flags.filter(f => f.show_in_kitchen === 1 || f.show_in_kitchen === undefined)
            : this.flags;
        if (!visible || visible.length === 0) {
            this.el.innerHTML = '';
            return;
        }
        const pending = visible.filter(f => !f.acked_on_this_bon);
        const allHandled = !this.readOnly && pending.length === 0;
        const open = this.expanded !== null ? this.expanded : visible.length === 1;

        const label = this.readOnly
            ? `${visible.length} påmindels${visible.length === 1 ? 'e' : 'er'} fra kontoret`
            : (allHandled
                ? '✓ Alle påmindelser håndteret'
                : `${pending.length} påmindels${pending.length === 1 ? 'e' : 'er'} på kunden`);

        this.el.innerHTML = `
            <div class="flag-strip ${open ? 'open' : ''} ${allHandled ? 'all-handled' : ''} ${this.readOnly ? 'read-only' : ''}">
                <div class="flag-strip-head" data-act="toggle">
                    <span class="flag-strip-icon">📌</span>
                    <span class="flag-strip-text">${label}</span>
                    <span class="flag-strip-toggle">${open ? '▴' : '▾'}</span>
                </div>
                <div class="flag-strip-body" ${open ? '' : 'hidden'}>
                    ${visible.map(f => this._renderItem(f)).join('')}
                </div>
            </div>
        `;
        this._bind();
    }

    _renderItem(f) {
        const acked       = !!f.acked_on_this_bon;
        const targetLabel = f.entity_type === 'company' ? 'firmaet' : 'kunden';
        const by          = f.created_by_name ? esc(f.created_by_name) : '—';

        // Read-only (køkken): kun tekst — ingen markør, ingen ack-state, ingen knapper.
        if (this.readOnly) {
            return `
                <div class="flag-item read-only" data-flag-id="${f.id}">
                    <div class="flag-item-text">
                        <div class="flag-item-title">${esc(f.title)}</div>
                        ${f.body ? `<div class="flag-item-body">${esc(f.body)}</div>` : ''}
                        <div class="flag-item-meta">På ${targetLabel} · Tilføjet af ${by}</div>
                    </div>
                </div>
            `;
        }

        // Kontor-kun påmindelser (køkkenet ser dem ikke) markeres så det er tydeligt i draweren.
        const officeOnly  = f.show_in_kitchen === 0
            ? ' <span class="flag-office-only" title="Vises ikke for køkkenet">🔒 kun kontor</span>' : '';
        return `
            <div class="flag-item ${acked ? 'flag-acked' : ''}" data-flag-id="${f.id}">
                <div class="flag-item-text">
                    <div class="flag-item-title">${esc(f.title)}${officeOnly}</div>
                    ${f.body ? `<div class="flag-item-body">${esc(f.body)}</div>` : ''}
                    <div class="flag-item-meta">
                        På ${targetLabel} · Tilføjet af ${by}${acked ? ' · ✓ Forstået på denne bon' : ''}
                    </div>
                </div>
                ${acked ? '' : `
                    <div class="flag-actions">
                        <button class="flag-btn"         type="button" data-act="ack"     data-flag-id="${f.id}">Forstået</button>
                        <button class="flag-btn primary" type="button" data-act="dismiss" data-flag-id="${f.id}">Færdig — fjern</button>
                    </div>
                `}
            </div>
        `;
    }

    _bind() {
        const root = this.el.querySelector('.flag-strip');
        if (!root) return;

        const head = root.querySelector('.flag-strip-head');
        if (head) head.addEventListener('click', () => {
            this.expanded = !root.classList.contains('open');
            this.render();
        });

        root.querySelectorAll('[data-act="ack"]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                const flagId = parseInt(btn.dataset.flagId, 10);
                if (!this.bonId) { alert('Bon-ID mangler'); return; }
                try {
                    await ackFlagApi(flagId, this.bonId);
                    this.onChange();
                } catch (err) {
                    alert('Kunne ikke markere: ' + err.message);
                }
            });
        });

        root.querySelectorAll('[data-act="dismiss"]').forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.stopPropagation();
                if (!confirm('Markér som færdig — fjernes permanent fra alle fremtidige bonner?')) return;
                const flagId = parseInt(btn.dataset.flagId, 10);
                try {
                    await dismissFlagApi(flagId, this.bonId);
                    this.onChange();
                } catch (err) {
                    alert('Kunne ikke fjerne: ' + err.message);
                }
            });
        });
    }
}
