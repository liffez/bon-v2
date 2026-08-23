/**
 * shared/add_to_campaign_modal.js
 * ════════════════════════════════════════════════════════════
 * Modal til at tilføje valgte firmaer/kunder til en outreach-kampagne.
 *
 * API:
 *   window.AddToCampaignModal.open({
 *     companies: [{ id, name }],     // valgte firmaer
 *     customers: [{ id, name }],     // valgte kunder (med eller uden firma)
 *     defaultName: 'Outreach maj',   // (valgfri) pre-fyldt kampagne-navn — auto-vælger "+ Opret ny"
 *     onDone: (result) => void,      // kaldes efter submit (result = { added, skipped })
 *   });
 *
 * Flow:
 *   1. Hent aktive kampagner (fetchCampaigns) ved åbning
 *   2. Bruger vælger eksisterende eller "+ Opret ny..."
 *      - Hvis ny: navn + valgfri beskrivelse
 *      - Hvis navn=lukket-kampagne: confirm "Genåben?" → reopenCampaign + fortsæt
 *      - Hvis navn=aktiv-kampagne (dublet): fejl
 *   3. POST /:id/members → resultat med added + skipped[]
 *   4. Toast: "N tilføjet, M sprunget over" (skipped grupperet per reason)
 *
 * Server håndhæver §10 + DNC + dedup, så modalen behøver ikke gentage logik.
 * Spec: docs/CLAUDE_OUTREACH_KAMPAGNER.md Fase 2.
 * ════════════════════════════════════════════════════════════
 */

(function () {
    'use strict';

    const REASON_LABELS = {
        no_entity: 'manglende kunde/firma',
        no_marketing_consent_b2c: 'mangler samtykke',
        do_not_contact: 'må ikke kontaktes',
        already_member: 'allerede medlem',
        db_error: 'database-fejl',
    };

    let _overlay = null;
    let _campaigns = [];
    let _busy = false;

    function esc(s) {
        return String(s ?? '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
        }[ch]));
    }

    function ensureStyles() {
        if (document.getElementById('atc-modal-styles')) return;
        const style = document.createElement('style');
        style.id = 'atc-modal-styles';
        style.textContent = `
            .atc-overlay {
                position: fixed; inset: 0;
                background: rgba(0,0,0,0.45);
                display: flex; align-items: center; justify-content: center;
                z-index: 9999;
                font-family: var(--font-body, 'DM Sans', system-ui, sans-serif);
            }
            .atc-modal {
                background: var(--color-surface, #fff);
                border-radius: 12px;
                width: 480px; max-width: 92vw; max-height: 90vh;
                overflow: auto;
                box-shadow: 0 20px 60px rgba(0,0,0,0.25);
            }
            .atc-header {
                padding: 18px 22px; border-bottom: 1px solid var(--color-border, #e7e2db);
                display: flex; justify-content: space-between; align-items: center;
            }
            .atc-title {
                font-family: var(--font-heading, 'Playfair Display', Georgia, serif);
                font-size: 19px; font-weight: 700; margin: 0;
            }
            .atc-close {
                background: none; border: none; font-size: 22px; cursor: pointer;
                color: var(--color-text-dim, #888); padding: 0; line-height: 1;
            }
            .atc-body { padding: 18px 22px; }
            .atc-sub {
                font-size: 13px; color: var(--color-text-dim, #888);
                margin: 0 0 14px 0;
            }
            .atc-field { margin-bottom: 14px; }
            .atc-label {
                display: block; font-size: 12px; font-weight: 600;
                text-transform: uppercase; letter-spacing: .04em;
                color: var(--color-text-dim, #888); margin-bottom: 6px;
            }
            .atc-input, .atc-select, .atc-textarea {
                width: 100%; box-sizing: border-box;
                padding: 9px 12px; font-size: 14px;
                border: 1px solid var(--color-border, #d7d1ca);
                border-radius: 8px; font-family: inherit;
                background: var(--color-surface, #fff);
            }
            .atc-input:focus, .atc-select:focus, .atc-textarea:focus {
                outline: 2px solid var(--brand-primary, #8e631f);
                outline-offset: -1px; border-color: transparent;
            }
            .atc-textarea { resize: vertical; min-height: 60px; }
            .atc-new-block {
                background: var(--color-surface-alt, #fafaf7);
                border: 1px solid var(--color-border, #e7e2db);
                border-radius: 8px; padding: 12px; margin-top: 10px;
            }
            .atc-footer {
                padding: 14px 22px;
                border-top: 1px solid var(--color-border, #e7e2db);
                display: flex; justify-content: flex-end; gap: 10px;
            }
            .atc-btn {
                padding: 9px 18px; border-radius: 8px; border: none;
                font-size: 14px; font-weight: 600; cursor: pointer;
                font-family: inherit;
            }
            .atc-btn-cancel {
                background: transparent; color: var(--color-text-dim, #555);
            }
            .atc-btn-cancel:hover { color: var(--color-text, #333); }
            .atc-btn-primary {
                background: var(--brand-primary, #8e631f); color: #fff;
            }
            .atc-btn-primary:hover { filter: brightness(1.08); }
            .atc-btn-primary:disabled {
                background: var(--color-border, #d7d1ca); cursor: not-allowed;
                filter: none;
            }
            .atc-error {
                background: #fdecea; color: #a13d2e;
                border-radius: 6px; padding: 8px 12px; font-size: 13px;
                margin-top: 8px;
            }
            .atc-toast {
                position: fixed; bottom: 20px; left: 50%;
                transform: translateX(-50%);
                background: var(--color-text, #333); color: #fff;
                padding: 12px 20px; border-radius: 10px;
                font-size: 14px; box-shadow: 0 8px 24px rgba(0,0,0,0.25);
                z-index: 10000;
                animation: atc-fade-in .15s ease-out;
            }
            .atc-toast.success { background: #2c7a3d; }
            .atc-toast.warning { background: #b8761c; }
            @keyframes atc-fade-in {
                from { opacity: 0; transform: translate(-50%, 10px); }
                to   { opacity: 1; transform: translate(-50%, 0); }
            }
        `;
        document.head.appendChild(style);
    }

    function buildHeader(companies, customers) {
        const parts = [];
        if (companies.length) parts.push(`${companies.length} firma${companies.length === 1 ? '' : 'er'}`);
        if (customers.length) parts.push(`${customers.length} kunde${customers.length === 1 ? '' : 'r'}`);
        return parts.join(' + ');
    }

    function close() {
        if (!_overlay) return;
        _overlay.remove();
        _overlay = null;
        document.removeEventListener('keydown', onEscape);
    }

    function onEscape(e) {
        if (e.key === 'Escape' && !_busy) close();
    }

    function showToast(message, level) {
        // Fjern eksisterende toast
        const existing = document.querySelector('.atc-toast');
        if (existing) existing.remove();

        const t = document.createElement('div');
        t.className = 'atc-toast' + (level ? ' ' + level : '');
        t.textContent = message;
        document.body.appendChild(t);
        setTimeout(() => t.remove(), 4500);
    }

    function summariseSkipped(skipped) {
        if (!skipped || skipped.length === 0) return '';
        const groups = {};
        for (const s of skipped) {
            const reason = s.reason || 'ukendt';
            groups[reason] = (groups[reason] || 0) + 1;
        }
        return Object.entries(groups)
            .map(([reason, n]) => `${n} ${REASON_LABELS[reason] || reason}`)
            .join(', ');
    }

    async function loadCampaigns() {
        try {
            _campaigns = await fetchCampaigns(); // kun aktive
        } catch (err) {
            console.error('Kunne ikke hente kampagner:', err);
            _campaigns = [];
        }
    }

    function renderBody(companies, customers) {
        const headerStr = buildHeader(companies, customers);
        const hasCampaigns = _campaigns.length > 0;

        return `
            <div class="atc-header">
                <h3 class="atc-title">Tilføj til kampagne</h3>
                <button class="atc-close" id="atc-close" aria-label="Luk">×</button>
            </div>
            <div class="atc-body">
                <p class="atc-sub">${esc(headerStr)} bliver tilføjet.</p>

                <div class="atc-field">
                    <label class="atc-label" for="atc-campaign-select">Kampagne</label>
                    <select class="atc-select" id="atc-campaign-select">
                        ${hasCampaigns
                            ? _campaigns.map(c =>
                                `<option value="${c.id}">${esc(c.name)}${c.member_count ? ` (${c.member_count})` : ''}</option>`
                            ).join('')
                            : '<option value="" disabled selected>Ingen aktive kampagner</option>'
                        }
                        <option value="__new__">+ Opret ny kampagne…</option>
                    </select>
                </div>

                <div class="atc-new-block" id="atc-new-block" style="display:none;">
                    <div class="atc-field" style="margin-bottom:10px;">
                        <label class="atc-label" for="atc-new-name">Kampagne-navn</label>
                        <input class="atc-input" id="atc-new-name" type="text" placeholder="fx Forår 2026 — Kantiner" autocomplete="off">
                    </div>
                    <div class="atc-field" style="margin-bottom:0;">
                        <label class="atc-label" for="atc-new-desc">Beskrivelse (valgfri)</label>
                        <textarea class="atc-textarea" id="atc-new-desc" placeholder="Hvad er formålet med kampagnen?"></textarea>
                    </div>
                </div>

                <div id="atc-error" class="atc-error" style="display:none;"></div>
            </div>
            <div class="atc-footer">
                <button class="atc-btn atc-btn-cancel" id="atc-cancel">Annullér</button>
                <button class="atc-btn atc-btn-primary" id="atc-submit">Tilføj</button>
            </div>
        `;
    }

    function showError(msg) {
        const el = document.getElementById('atc-error');
        if (!el) return;
        el.textContent = msg;
        el.style.display = 'block';
    }
    function clearError() {
        const el = document.getElementById('atc-error');
        if (el) { el.textContent = ''; el.style.display = 'none'; }
    }

    function setBusy(busy) {
        _busy = busy;
        const submit = document.getElementById('atc-submit');
        const cancel = document.getElementById('atc-cancel');
        const close = document.getElementById('atc-close');
        if (submit) {
            submit.disabled = busy;
            submit.textContent = busy ? 'Tilføjer…' : 'Tilføj';
        }
        if (cancel) cancel.disabled = busy;
        if (close) close.disabled = busy;
    }

    // Forsøg at oprette ny kampagne. Returnerer { campaignId } eller kaster.
    // Håndterer 409 name_closed (reopenable) ved at spørge brugeren og genåbne.
    async function createNewCampaign(name, description) {
        try {
            const r = await createCampaign({ name, description });
            return { campaignId: r.id, reopened: false };
        } catch (err) {
            if (err.status === 409 && err.body) {
                if (err.body.error === 'name_in_use') {
                    throw new Error(`Navnet "${name}" er allerede i brug af en aktiv kampagne.`);
                }
                if (err.body.error === 'name_closed' && err.body.reopenable && err.body.existing_id) {
                    const ok = window.confirm(
                        `Der findes en lukket kampagne med navnet "${name}". ` +
                        `Vil du genåbne den og tilføje medlemmerne dér?`,
                    );
                    if (!ok) throw new Error('Genåbning afvist.');
                    await reopenCampaign(err.body.existing_id);
                    return { campaignId: err.body.existing_id, reopened: true };
                }
            }
            throw err;
        }
    }

    async function submit(opts) {
        const select = document.getElementById('atc-campaign-select');
        if (!select || !select.value) {
            showError('Vælg en kampagne eller opret en ny.');
            return;
        }

        let campaignId;
        let reopened = false;

        clearError();
        setBusy(true);

        try {
            if (select.value === '__new__') {
                const name = (document.getElementById('atc-new-name')?.value || '').trim();
                const desc = (document.getElementById('atc-new-desc')?.value || '').trim();
                if (!name) {
                    showError('Indtast et navn til den nye kampagne.');
                    setBusy(false);
                    return;
                }
                const created = await createNewCampaign(name, desc || null);
                campaignId = created.campaignId;
                reopened = created.reopened;
            } else {
                campaignId = parseInt(select.value, 10);
            }

            // Byg member-array — server filtrerer ulovlige
            const members = [];
            for (const co of opts.companies) members.push({ company_id: co.id });
            for (const cu of opts.customers) {
                if (cu.company_id) {
                    members.push({ company_id: cu.company_id, customer_id: cu.id });
                } else {
                    members.push({ customer_id: cu.id });
                }
            }

            const result = await addCampaignMembers(campaignId, members);

            // Toast med resultat
            const skippedSummary = summariseSkipped(result.skipped);
            let toastMsg;
            let toastLevel = 'success';
            if (result.added === 0 && result.skipped.length > 0) {
                toastMsg = `0 tilføjet · ${skippedSummary}`;
                toastLevel = 'warning';
            } else if (result.skipped.length > 0) {
                toastMsg = `${result.added} tilføjet · ${result.skipped.length} sprunget over (${skippedSummary})`;
                toastLevel = 'warning';
            } else {
                toastMsg = `${result.added} tilføjet til kampagnen${reopened ? ' (genåbnet)' : ''}`;
            }
            showToast(toastMsg, toastLevel);
            close();
            if (typeof opts.onDone === 'function') {
                opts.onDone({ ...result, campaign_id: campaignId, reopened });
            }
        } catch (err) {
            console.error('Tilføj til kampagne fejlede:', err);
            showError(err.message || 'Kunne ikke tilføje. Prøv igen.');
            setBusy(false);
        }
    }

    async function open(opts) {
        const companies = Array.isArray(opts.companies) ? opts.companies : [];
        const customers = Array.isArray(opts.customers) ? opts.customers : [];
        if (companies.length === 0 && customers.length === 0) {
            showToast('Vælg mindst ét firma eller én kunde først.', 'warning');
            return;
        }

        ensureStyles();
        close(); // luk evt. eksisterende
        await loadCampaigns();

        _overlay = document.createElement('div');
        _overlay.className = 'atc-overlay';
        _overlay.innerHTML = `<div class="atc-modal" role="dialog" aria-modal="true">${renderBody(companies, customers)}</div>`;
        document.body.appendChild(_overlay);

        // Klik på overlay (uden for modal) lukker
        closeOnOutsideClick(_overlay, () => { if (!_busy) close(); });
        document.addEventListener('keydown', onEscape);

        document.getElementById('atc-close').addEventListener('click', () => { if (!_busy) close(); });
        document.getElementById('atc-cancel').addEventListener('click', () => { if (!_busy) close(); });
        document.getElementById('atc-submit').addEventListener('click', () => submit({ companies, customers, onDone: opts.onDone }));

        const select = document.getElementById('atc-campaign-select');
        const newBlock = document.getElementById('atc-new-block');
        select.addEventListener('change', () => {
            newBlock.style.display = select.value === '__new__' ? 'block' : 'none';
            clearError();
            if (select.value === '__new__') {
                setTimeout(() => document.getElementById('atc-new-name')?.focus(), 0);
            }
        });

        // Auto-vælg "+ Opret ny" hvis defaultName er givet, eller hvis der ingen aktive kampagner er
        if (opts.defaultName || _campaigns.length === 0) {
            select.value = '__new__';
            select.dispatchEvent(new Event('change'));
            if (opts.defaultName) {
                setTimeout(() => {
                    const nameInput = document.getElementById('atc-new-name');
                    if (nameInput) {
                        nameInput.value = String(opts.defaultName);
                        nameInput.focus();
                        nameInput.select();  // markér tekst så brugeren kan overskrive
                    }
                }, 0);
            }
        }
    }

    window.AddToCampaignModal = { open };
})();
