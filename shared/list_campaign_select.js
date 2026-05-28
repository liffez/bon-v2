/**
 * shared/list_campaign_select.js
 * ════════════════════════════════════════════════════════════
 * Toggle-baseret select-mode til CRM-lister (prospekter,
 * reaktivering, kundeindsigt) så office kan cherry-picke
 * firmaer/kunder til en outreach-kampagne uden at forlade listen.
 *
 * API:
 *   ListCampaignSelect.attach({
 *     hostEl,                     // listens for clicks; data-cselect attr toggles
 *     toolbarEl,                  // hvor toggle-knappen mountes
 *     contentEl,                  // hvor footer-bar indsættes (over rows)
 *     rowSelector,                // CSS-selector for række-elementer i hostEl
 *     getEntityFromRow,           // (rowEl) => { company_id?, customer_id?, name }
 *     contextName,                // "Prospekter" / "Reaktivering" / "Kundeindsigt"
 *     suggestedCampaignName,      // () => string (pre-fyldt navn ved opret-ny)
 *     onSelectionChange,          // optional (count) => void
 *   });
 *
 *   ListCampaignSelect.refresh();              // efter view re-render
 *   ListCampaignSelect.handleRowClick(rowEl);  // returnerer true hvis select-mode toggle blev kaldt
 *   ListCampaignSelect.isEnabled();            // boolean
 *   ListCampaignSelect.detach();               // ryd state ved view-skift
 *
 * Spec: docs/CLAUDE_OUTREACH_KAMPAGNER.md §2.3 (Fase 2b).
 * Genbruger shared/add_to_campaign_modal.js til selve modal-flowet.
 * ════════════════════════════════════════════════════════════
 */

(function () {
    'use strict';

    const state = {
        enabled: false,
        selected: new Map(),  // key → { company_id, customer_id, name }
        opts: null,
        toggleEl: null,
        barEl: null,
    };

    function entityKey(e) {
        return `${e.company_id || 0}:${e.customer_id || 0}`;
    }

    function ensureStyles() {
        if (document.getElementById('csel-styles')) return;
        const s = document.createElement('style');
        s.id = 'csel-styles';
        s.textContent = `
            .csel-toggle {
                padding: 6px 12px; border-radius: 6px;
                border: 1px solid var(--color-border, #d7d1ca);
                background: var(--color-surface, #fff);
                font-size: 13px; cursor: pointer;
                font-family: inherit; color: var(--color-text, #333);
                white-space: nowrap;
            }
            .csel-toggle:hover { background: #f5f3f0; }
            .csel-toggle.csel-on {
                background: var(--brand-primary, #8e631f); color: #fff;
                border-color: transparent;
            }
            .csel-bar {
                display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
                margin: 10px 0; padding: 10px 14px; border-radius: 10px;
                background: var(--brand-primary-light, #f1e6b2);
                border: 1px solid color-mix(in srgb, var(--brand-primary, #8e631f) 30%, transparent);
                font-size: 13px;
                position: sticky; top: 0; z-index: 50;
            }
            .csel-count { font-weight: 700; color: var(--brand-primary, #8e631f); }
            .csel-count-dim { font-weight: 400; color: #765a30; font-size: 12px; }
            .csel-btn {
                padding: 6px 12px; border-radius: 6px;
                border: 1px solid var(--color-border, #d7d1ca);
                background: var(--color-surface, #fff);
                font-size: 13px; cursor: pointer;
                font-family: inherit;
            }
            .csel-btn:hover { filter: brightness(0.97); }
            .csel-btn-primary {
                background: var(--brand-primary, #8e631f); color: #fff;
                border-color: transparent; font-weight: 600;
            }
            .csel-btn-primary:hover { filter: brightness(1.08); }
            .csel-btn-primary:disabled {
                background: var(--color-border, #d7d1ca); color: #888;
                cursor: not-allowed; filter: none;
            }
            /* Visuel select-tilstand på rækker — generisk, virker på alle rækketyper */
            [data-cselect="on"] {
                /* Cursor-hint på alle rækker når toggle er aktiv */
            }
            .csel-checked {
                background: color-mix(in srgb, var(--brand-primary, #8e631f) 10%, transparent) !important;
                box-shadow: inset 4px 0 0 0 var(--brand-primary, #8e631f) !important;
            }
        `;
        document.head.appendChild(s);
    }

    function buildToggle() {
        const btn = document.createElement('button');
        btn.className = 'csel-toggle';
        btn.type = 'button';
        btn.innerHTML = '✓ Vælg til kampagne';
        btn.title = 'Slå multi-valg til/fra for at tilføje flere firmaer til en kampagne';
        btn.addEventListener('click', () => {
            if (state.enabled) disable();
            else enable();
        });
        return btn;
    }

    function renderBar() {
        if (state.barEl) return;
        const bar = document.createElement('div');
        bar.className = 'csel-bar';
        bar.innerHTML = `
            <span class="csel-count">0 valgt</span>
            <button class="csel-btn csel-btn-primary" data-action="add" disabled>+ Tilføj til kampagne</button>
            <button class="csel-btn" data-action="all">Vælg alle synlige</button>
            <button class="csel-btn" data-action="clear">Ryd valg</button>
        `;
        bar.querySelector('[data-action="add"]').addEventListener('click', openModal);
        bar.querySelector('[data-action="all"]').addEventListener('click', selectAllVisible);
        bar.querySelector('[data-action="clear"]').addEventListener('click', clearSelection);

        // Indsæt over contentEl (eller før hostEl's første barn)
        const anchor = state.opts.contentEl || state.opts.hostEl.firstChild;
        if (anchor && anchor.parentNode) {
            anchor.parentNode.insertBefore(bar, anchor);
        } else {
            state.opts.hostEl.insertBefore(bar, state.opts.hostEl.firstChild);
        }
        state.barEl = bar;
    }

    function updateBar() {
        if (!state.barEl) return;
        const total = state.selected.size;
        const rows = state.opts.hostEl.querySelectorAll(state.opts.rowSelector);
        let visible = 0;
        rows.forEach(row => {
            const entity = state.opts.getEntityFromRow(row);
            if (entity && state.selected.has(entityKey(entity))) visible++;
        });

        const countEl = state.barEl.querySelector('.csel-count');
        if (total === 0) {
            countEl.innerHTML = '0 valgt';
        } else if (total > visible) {
            countEl.innerHTML = `${total} valgt <span class="csel-count-dim">(${visible} synlige med aktuelt filter)</span>`;
        } else {
            countEl.innerHTML = `${total} valgt`;
        }
        state.barEl.querySelector('[data-action="add"]').disabled = total === 0;

        if (typeof state.opts.onSelectionChange === 'function') {
            state.opts.onSelectionChange(total);
        }
    }

    function applyVisualState() {
        // Efter re-render: anvend .csel-checked på rækker hvis valgt
        const rows = state.opts.hostEl.querySelectorAll(state.opts.rowSelector);
        rows.forEach(row => {
            const entity = state.opts.getEntityFromRow(row);
            const isChecked = entity && state.selected.has(entityKey(entity));
            row.classList.toggle('csel-checked', !!isChecked);
        });
        updateBar();
    }

    function enable() {
        state.enabled = true;
        state.opts.hostEl.dataset.cselect = 'on';
        if (state.toggleEl) {
            state.toggleEl.classList.add('csel-on');
            state.toggleEl.innerHTML = '✕ Afslut valg';
        }
        renderBar();
        applyVisualState();
    }

    function disable() {
        state.enabled = false;
        state.selected.clear();
        if (state.opts && state.opts.hostEl) {
            delete state.opts.hostEl.dataset.cselect;
            state.opts.hostEl.querySelectorAll('.csel-checked').forEach(el => el.classList.remove('csel-checked'));
        }
        if (state.toggleEl) {
            state.toggleEl.classList.remove('csel-on');
            state.toggleEl.innerHTML = '✓ Vælg til kampagne';
        }
        if (state.barEl) {
            state.barEl.remove();
            state.barEl = null;
        }
    }

    /**
     * Kaldes af view's egne click-handlers. Hvis select-mode er aktiv,
     * toggler valg på rækken og returnerer true (så viewet ved at den ikke
     * skal navigere videre). Returnerer false hvis select-mode er off.
     */
    function handleRowClick(rowEl) {
        if (!state.enabled) return false;
        if (!rowEl) return false;
        const entity = state.opts.getEntityFromRow(rowEl);
        if (!entity || (!entity.company_id && !entity.customer_id)) {
            return true;  // Slug klikket — der er bare ingen entity at vælge (degraderer pænt)
        }
        const key = entityKey(entity);
        if (state.selected.has(key)) {
            state.selected.delete(key);
            rowEl.classList.remove('csel-checked');
        } else {
            state.selected.set(key, entity);
            rowEl.classList.add('csel-checked');
        }
        updateBar();
        return true;
    }

    function selectAllVisible() {
        const rows = state.opts.hostEl.querySelectorAll(state.opts.rowSelector);
        rows.forEach(row => {
            const entity = state.opts.getEntityFromRow(row);
            if (entity && (entity.company_id || entity.customer_id)) {
                state.selected.set(entityKey(entity), entity);
            }
        });
        applyVisualState();
    }

    function clearSelection() {
        state.selected.clear();
        applyVisualState();
    }

    function openModal() {
        if (state.selected.size === 0) return;
        if (typeof window.AddToCampaignModal?.open !== 'function') {
            alert('Kampagne-modal er ikke loadet.');
            return;
        }

        // Grupér efter type: ren company / ren customer / B2B med kontakt
        const companies = [];
        const customers = [];
        for (const e of state.selected.values()) {
            if (e.company_id && e.customer_id) {
                // B2B med kontakt — som customer (modal sender begge IDs videre)
                customers.push({ id: e.customer_id, company_id: e.company_id, name: e.name || `Kunde ${e.customer_id}` });
            } else if (e.company_id) {
                companies.push({ id: e.company_id, name: e.name || `Firma ${e.company_id}` });
            } else if (e.customer_id) {
                customers.push({ id: e.customer_id, name: e.name || `Kunde ${e.customer_id}` });
            }
        }

        // Pre-fyldt kampagne-navn baseret på context
        const defaultName = typeof state.opts.suggestedCampaignName === 'function'
            ? state.opts.suggestedCampaignName()
            : null;

        window.AddToCampaignModal.open({
            companies,
            customers,
            defaultName,
            onDone: (result) => {
                if (result && result.added > 0) {
                    // Ryd valg + luk select-mode → tilbage til læse-tilstand
                    disable();
                }
            },
        });
    }

    function attach(opts) {
        if (!opts || !opts.hostEl || !opts.toolbarEl || !opts.rowSelector || typeof opts.getEntityFromRow !== 'function') {
            console.warn('ListCampaignSelect.attach: missing required opts', opts);
            return;
        }
        ensureStyles();

        // Idempotent re-bind: hvis samme contextName, bevar selected + enabled
        // (sker når et view re-rendrer hele sin DOM, fx crm-kundeindsigt ved filter-skift).
        const sameContext = state.opts && state.opts.contextName === opts.contextName;
        const wasEnabled = state.enabled;
        const prevSelected = sameContext ? new Map(state.selected) : null;

        // Ryd gammel toggle + bar (døde DOM-referencer efter re-render)
        if (state.toggleEl && state.toggleEl.parentNode) state.toggleEl.remove();
        if (state.barEl && state.barEl.parentNode) state.barEl.remove();
        state.toggleEl = null;
        state.barEl = null;
        if (!sameContext) {
            state.selected.clear();
            state.enabled = false;
        }

        state.opts = opts;
        state.toggleEl = buildToggle();
        opts.toolbarEl.appendChild(state.toggleEl);

        // Genskab enabled-state (efter re-render i samme kontekst)
        if (wasEnabled && sameContext) {
            if (prevSelected) state.selected = prevSelected;
            enable();
        }
    }

    function detach() {
        disable();
        if (state.toggleEl) {
            state.toggleEl.remove();
            state.toggleEl = null;
        }
        state.selected.clear();
        state.opts = null;
    }

    function refresh() {
        if (!state.enabled) return;
        applyVisualState();
    }

    function isEnabled() {
        return state.enabled;
    }

    window.ListCampaignSelect = {
        attach,
        detach,
        refresh,
        handleRowClick,
        isEnabled,
    };
})();
