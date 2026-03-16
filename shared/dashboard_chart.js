/**
 * shared/dashboard_chart.js
 * ════════════════════════════════════════════════════════════
 * Custom canvas legoklods chart for dashboard.
 * Each bon is an individual rounded-rect brick, colored by price_category.
 *
 * API:
 *   initDashboardChart(canvasId, data, opts)
 *     opts: { showLastYear, onBrickClick }
 *     Returns: { destroy(), setMode(mode), toggleLastYear(show), getGeom() }
 *
 *   buildStaffBadges(containerId, canvasId, days)
 *   buildChartLegend(containerId)
 * ════════════════════════════════════════════════════════════
 */

/* ── Category colors ──────────────────────────────────────── */

const CATS = {
    Store:      { color: '#6d4c16', label: 'Store' },
    Catering:   { color: '#c49a45', label: 'Catering' },
    Festival:   { color: '#7a9c54', label: 'Festival' },
    Produktion: { color: '#7594b3', label: 'Produktion' },
    Waiste:     { color: '#c8c2bb', label: 'Waiste' },
};

const SHOW_INDIVIDUAL_MAX = 3;

/* ── State per chart instance ─────────────────────────────── */

const _instances = {}; // canvasId → instance

/* ── Helpers ──────────────────────────────────────────────── */

function rrect(ctx, x, y, w, h, r) {
    if (h < r * 2) r = h / 2;
    ctx.beginPath();
    ctx.moveTo(x + r, y); ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r); ctx.lineTo(x + w, y + h);
    ctx.lineTo(x, y + h); ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r); ctx.closePath();
}

function fmtKr(v) {
    if (v >= 1000) return Math.round(v / 1000) + 'k';
    return v + '';
}

/* ── Public API ───────────────────────────────────────────── */

/**
 * Initialize a dashboard chart.
 * @param {string} canvasId   — canvas element ID
 * @param {object} data       — { days: [...] } from /api/dashboard/stats
 * @param {object} opts
 * @param {boolean} opts.showLastYear  — show last-year dashed line (office)
 * @param {function} opts.onBrickClick — callback(bon) when brick clicked
 * @returns {{ destroy, setMode, toggleLastYear, getGeom }}
 */
function initDashboardChart(canvasId, data, opts = {}) {
    // Destroy existing
    if (_instances[canvasId]) {
        _instances[canvasId].destroy();
    }

    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;

    const inst = {
        canvasId,
        data,
        opts,
        mode: 'enh',          // 'enh' or 'kr'
        showLastYear: opts.showLastYear || false,
        geom: null,
        hitBoxes: [],
        activeHit: null,
        tooltip: null,
        _listeners: [],
    };

    _instances[canvasId] = inst;

    // Create tooltip element
    let tooltip = document.getElementById(canvasId + 'Tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = canvasId + 'Tooltip';
        tooltip.className = 'chart-tooltip';
        document.body.appendChild(tooltip);
    }
    inst.tooltip = tooltip;

    // ── Draw function ──────────────────────────────────────
    function draw(hl) {
        const dpr = window.devicePixelRatio || 1;
        const cssW = canvas.clientWidth;
        const cssH = canvas.clientHeight;
        canvas.width = cssW * dpr;
        canvas.height = cssH * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        inst.hitBoxes = [];

        const W = cssW, H = cssH;
        const PAD_L = 34, PAD_R = 6, PAD_T = 14, DAY_H = 20, PAD_B = DAY_H;
        const chartW = W - PAD_L - PAD_R, chartH = H - PAD_T - PAD_B;
        const days = data.days;
        const N = days.length;
        if (N === 0) return;
        const slotW = chartW / N, barW = slotW * 0.58, GAP = 1.5;

        inst.geom = { PAD_L, slotW, N };

        const isKr = inst.mode === 'kr';

        // Value getters
        const getDayVal = d => isKr ? (d.total_price || 0) : (d.total_units || 0);
        const getBonVal = b => isKr ? (b.price || 0) : (b.units || 0);

        // Compute yMax
        let maxVal = Math.max(1, ...days.map(d => getDayVal(d)));
        if (inst.showLastYear) {
            maxVal = Math.max(maxVal, ...days.map(d => isKr ? (d.last_year_price || 0) : (d.last_year_units || 0)));
        }
        const yMax = isKr
            ? Math.ceil(maxVal / 5000) * 5000 + 2000
            : Math.ceil(maxVal / 100) * 100 + 60;

        // Grid lines
        const gridSteps = isKr ? [5000, 10000, 15000, 20000, 25000, 30000] : [100, 200, 300, 400];
        gridSteps.filter(v => v < yMax).forEach(val => {
            const gy = PAD_T + chartH - (val / yMax) * chartH;
            ctx.strokeStyle = '#ebebeb'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(PAD_L, gy); ctx.lineTo(W - PAD_R, gy); ctx.stroke();
            ctx.fillStyle = '#c0b9b2'; ctx.font = "8px 'Lato',sans-serif";
            ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
            ctx.fillText(isKr ? fmtKr(val) : val, PAD_L - 3, gy);
        });

        // Today highlight bg
        const todayIdx = days.findIndex(d => d.is_today);
        if (todayIdx >= 0) {
            ctx.fillStyle = '#fdfbf3';
            ctx.fillRect(PAD_L + todayIdx * slotW - 2, 0, slotW + 4, H);
        }

        // Separator line between history and today
        if (todayIdx > 0) {
            const sepX = PAD_L + (todayIdx - 0.5) * slotW + slotW / 2;
            ctx.save(); ctx.setLineDash([2, 4]);
            ctx.strokeStyle = '#d0c8c0'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(sepX, PAD_T); ctx.lineTo(sepX, PAD_T + chartH + 3); ctx.stroke();
            ctx.restore();
        }

        // Last-year dashed line (office)
        if (inst.showLastYear) {
            ctx.save();
            ctx.strokeStyle = 'rgba(180,170,160,0.55)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([3, 4]);
            ctx.beginPath();
            let started = false;
            days.forEach((day, i) => {
                const val = isKr ? (day.last_year_price || 0) : (day.last_year_units || 0);
                const cx = PAD_L + (i + 0.5) * slotW;
                const y = PAD_T + chartH - (val / yMax) * chartH;
                if (!started) { ctx.moveTo(cx, y); started = true; }
                else ctx.lineTo(cx, y);
            });
            ctx.stroke();
            ctx.restore();

            // "2025" label at end
            const lastDay = days[days.length - 1];
            const lyVal = isKr ? (lastDay.last_year_price || 0) : (lastDay.last_year_units || 0);
            const lyY = PAD_T + chartH - (lyVal / yMax) * chartH;
            ctx.fillStyle = 'rgba(160,150,140,0.7)';
            ctx.font = "italic 8px 'Lato',sans-serif";
            ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
            ctx.fillText('2025', PAD_L + chartW - 22, lyY - 6);
        }

        // Bars — individual bon bricks
        days.forEach((day, di) => {
            const slotX = PAD_L + di * slotW, cx = slotX + slotW / 2;
            const barX = slotX + (slotW - barW) / 2, baseY = PAD_T + chartH;
            let stackY = 0;
            const bons = day.bons || [];

            bons.forEach((bon, bi) => {
                const bonVal = getBonVal(bon);
                const brickPx = (bonVal / yMax) * chartH;
                const brickH = Math.max(brickPx - GAP, 2);
                const brickY = baseY - stackY - brickPx;
                const isHl = hl && hl.di === di && hl.bi === bi;
                const isFade = hl && !(hl.di === di && hl.bi === bi);

                ctx.globalAlpha = isFade ? 0.28 : 1;
                ctx.fillStyle = CATS[bon.category]?.color || '#aaa';
                rrect(ctx, barX, brickY + GAP / 2, barW, brickH, 3);
                ctx.fill();
                if (isHl) { ctx.strokeStyle = 'rgba(255,255,255,0.75)'; ctx.lineWidth = 1.5; ctx.stroke(); }
                ctx.globalAlpha = 1;
                inst.hitBoxes.push({ x: barX, y: brickY + GAP / 2, w: barW, h: brickH, di, bi, day, bon });
                stackY += brickPx;
            });

            // Total label above bar
            const dayVal = getDayVal(day);
            if (dayVal > 0) {
                const topY = PAD_T + chartH - (dayVal / yMax) * chartH;
                ctx.fillStyle = day.is_today ? '#8e631f' : '#b0a898';
                ctx.font = day.is_today ? "bold 9px 'Lato',sans-serif" : "8px 'Lato',sans-serif";
                ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
                ctx.fillText(isKr ? fmtKr(dayVal) : dayVal, cx, topY - 2);
            }

            // Day label under x-axis
            const label = day.label || '';
            const parts = label.split('\n');
            const dlY = PAD_T + chartH + 2;
            ctx.fillStyle = day.is_today ? '#8e631f' : '#b0a898';
            ctx.font = day.is_today ? "bold 8px 'Lato',sans-serif" : "8px 'Lato',sans-serif";
            ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
            if (parts[0]) ctx.fillText(parts[0], cx, dlY + 8);
            if (parts[1]) {
                ctx.fillStyle = '#c8c2bb'; ctx.font = "7px 'Lato',sans-serif";
                ctx.fillText(parts[1], cx, dlY + 15);
            }
        });
    }

    // ── Hit detection ──────────────────────────────────────
    function getHit(x, y) {
        for (let i = inst.hitBoxes.length - 1; i >= 0; i--) {
            const h = inst.hitBoxes[i];
            if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h;
        }
        return null;
    }

    function showTT(hit, px, py) {
        const { bon } = hit;
        const col = CATS[bon.category]?.color || '#aaa';
        const isKr = inst.mode === 'kr';
        const val = isKr ? (bon.price || 0) : (bon.units || 0);
        const valStr = isKr ? val.toLocaleString('da-DK') + ' kr' : val + ' enh';
        tooltip.innerHTML = `
            <div class="tt-kat" style="color:${col}">${bon.category || ''}</div>
            <div style="display:flex;align-items:baseline;gap:5px">
                <div class="tt-enh">${valStr}</div>
            </div>
            <div class="tt-row">
                <span class="tt-dim">${bon.bon_number || ''}</span>
                <span class="tt-val">${bon.customer_name || ''}</span>
            </div>`;
        tooltip.style.display = 'block';
        const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
        let tx = px + 14, ty = py - th / 2;
        if (tx + tw > window.innerWidth - 8) tx = px - tw - 14;
        if (ty < 4) ty = 4;
        if (ty + th > window.innerHeight - 4) ty = window.innerHeight - th - 4;
        tooltip.style.left = tx + 'px'; tooltip.style.top = ty + 'px';
    }

    function hideTT() { tooltip.style.display = 'none'; inst.activeHit = null; }

    // ── Event listeners ────────────────────────────────────
    function onMousemove(e) {
        const r = canvas.getBoundingClientRect();
        const hit = getHit(e.clientX - r.left, e.clientY - r.top);
        if (hit) {
            if (!inst.activeHit || inst.activeHit.di !== hit.di || inst.activeHit.bi !== hit.bi) {
                inst.activeHit = hit;
                draw({ di: hit.di, bi: hit.bi });
                showTT(hit, e.clientX, e.clientY);
                canvas.style.cursor = 'pointer';
            }
        } else if (inst.activeHit) {
            inst.activeHit = null;
            draw(null);
            hideTT();
            canvas.style.cursor = 'default';
        }
    }

    function onMouseleave() {
        inst.activeHit = null;
        draw(null);
        hideTT();
    }

    function onTouchstart(e) {
        e.preventDefault();
        const t = e.touches[0], r = canvas.getBoundingClientRect();
        const hit = getHit(t.clientX - r.left, t.clientY - r.top);
        if (hit) {
            inst.activeHit = hit;
            draw({ di: hit.di, bi: hit.bi });
            showTT(hit, t.clientX, t.clientY);
        } else {
            inst.activeHit = null;
            draw(null);
            hideTT();
        }
    }

    function onDocTouch(e) {
        if (!canvas.contains(e.target) && inst.activeHit) {
            inst.activeHit = null;
            draw(null);
            hideTT();
        }
    }

    function onClick(e) {
        if (inst.activeHit && opts.onBrickClick) {
            opts.onBrickClick(inst.activeHit.bon);
        }
    }

    function onResize() {
        draw(null);
    }

    canvas.addEventListener('mousemove', onMousemove);
    canvas.addEventListener('mouseleave', onMouseleave);
    canvas.addEventListener('touchstart', onTouchstart, { passive: false });
    canvas.addEventListener('click', onClick);
    document.addEventListener('touchstart', onDocTouch);
    window.addEventListener('resize', onResize);

    inst._listeners = [
        ['mousemove', onMousemove, canvas],
        ['mouseleave', onMouseleave, canvas],
        ['touchstart', onTouchstart, canvas],
        ['click', onClick, canvas],
        ['touchstart', onDocTouch, document],
        ['resize', onResize, window],
    ];

    // Initial draw
    draw(null);

    // ── Return handle ──────────────────────────────────────
    return {
        destroy() {
            for (const [evt, fn, el] of inst._listeners) {
                el.removeEventListener(evt, fn);
            }
            if (tooltip.parentNode) tooltip.parentNode.removeChild(tooltip);
            delete _instances[canvasId];
        },
        setMode(mode) {
            inst.mode = mode;
            draw(null);
        },
        toggleLastYear(show) {
            inst.showLastYear = show;
            draw(null);
        },
        getGeom() {
            return inst.geom;
        },
        redraw() {
            draw(null);
        },
        update(newData) {
            inst.data = newData;
            data = newData;
            draw(null);
        },
    };
}

/**
 * Build staff badges below chart, positioned by chart geometry.
 * @param {string} containerId — staff row element ID
 * @param {string} canvasId    — canvas element ID (for geometry + positioning)
 * @param {Array}  days        — days array from /api/dashboard/stats
 */
function buildStaffBadges(containerId, canvasId, days) {
    const inst = _instances[canvasId];
    if (!inst?.geom) return;
    const { PAD_L, slotW } = inst.geom;
    const container = document.getElementById(containerId);
    if (!container) return;
    container.innerHTML = '';

    const canvasEl = document.getElementById(canvasId);
    const canvasRect = canvasEl.getBoundingClientRect();
    const rowRect = container.getBoundingClientRect();
    const offsetLeft = canvasRect.left - rowRect.left;

    days.forEach((day, i) => {
        const cx = offsetLeft + PAD_L + (i + 0.5) * slotW;
        const staffList = day.shifts || [];
        if (!staffList.length) return;

        const typeClass = day.is_today ? 'type-today'
            : day.is_future ? 'type-future'
            : 'type-history';

        if (staffList.length <= SHOW_INDIVIDUAL_MAX) {
            const total = staffList.length;
            const SPREAD = 22;
            const startX = cx - ((total - 1) * SPREAD) / 2;
            staffList.forEach((s, si) => {
                const el = document.createElement('div');
                el.className = `sb ${typeClass}`;
                el.style.left = (startX + si * SPREAD) + 'px';
                el.innerHTML = `
                    <div class="sb-av">${s.init || ''}</div>
                    <div class="sb-tt">${s.name || ''}<br><span style="opacity:.6">${s.tid || ''}</span></div>
                `;
                container.appendChild(el);
            });
        } else {
            const el = document.createElement('div');
            el.className = `sb ${typeClass}`;
            el.style.left = cx + 'px';
            el.innerHTML = `
                <div class="sb-av">${staffList.length}</div>
                <span style="font-size:9px">👤</span>
                <div class="sb-tt">${staffList.map(s => `${s.name || ''} <span style="opacity:.55">${s.tid || ''}</span>`).join('<br>')}</div>
            `;
            container.appendChild(el);
        }
    });
}

/**
 * Build chart legend.
 * @param {string} containerId — legend container element ID
 */
function buildChartLegend(containerId) {
    const el = document.getElementById(containerId);
    if (!el) return;
    el.innerHTML = Object.entries(CATS).map(([, v]) =>
        `<div class="leg-item"><div class="leg-sw" style="background:${v.color}"></div>${v.label}</div>`
    ).join('');
}

/* ── Accumulated area chart ────────────────────────────────── */

/**
 * Initialize accumulated area chart below the main chart.
 * Uses the same x-axis geometry as the main chart (PAD_L, slotW).
 * @param {string} canvasId — canvas element ID for the accum chart
 * @param {string} mainCanvasId — canvas ID of the main legoklods chart (for geometry)
 * @param {object} data — { days: [...] } from /api/dashboard/stats
 * @param {object} opts — { mode: 'enh'|'kr' }
 * @returns {{ destroy, setMode, redraw }}
 */
function initAccumChart(canvasId, mainCanvasId, data, opts = {}) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;

    const state = { mode: opts.mode || 'enh', data };

    function draw() {
        const mainInst = _instances[mainCanvasId];
        if (!mainInst?.geom) return;

        const { PAD_L, slotW, N } = mainInst.geom;
        const dpr = window.devicePixelRatio || 1;
        const cssW = canvas.clientWidth;
        const cssH = canvas.clientHeight;
        canvas.width = cssW * dpr;
        canvas.height = cssH * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);

        const W = cssW, H = cssH;
        const PAD_T = 4, PAD_B = 2, PAD_R = 32;
        const chartH = H - PAD_T - PAD_B;
        const chartW = W - PAD_L - PAD_R;
        const days = state.data.days || [];
        const isKr = state.mode === 'kr';
        const getDayVal = d => isKr ? (d.total_price || 0) : (d.total_units || 0);

        // Calculate accumulated values
        let accum = 0;
        const points = [];
        days.forEach((day, i) => {
            accum += getDayVal(day);
            points.push({ x: PAD_L + (i + 0.5) * slotW, val: accum, day });
        });
        if (points.length === 0) return;

        const accMax = accum || 1;
        const yMax = isKr
            ? Math.ceil(accMax / 5000) * 5000 + 2000
            : Math.ceil(accMax / 100) * 100 + 60;

        // Grid
        const baseY = PAD_T + chartH;
        const nSteps = 2;
        for (let i = 1; i <= nSteps; i++) {
            const val = Math.round((yMax / (nSteps + 1)) * i);
            const gy = PAD_T + chartH - (val / yMax) * chartH;
            ctx.strokeStyle = '#ebebeb'; ctx.lineWidth = 0.5;
            ctx.beginPath(); ctx.moveTo(PAD_L, gy); ctx.lineTo(PAD_L + chartW, gy); ctx.stroke();
        }

        // Today highlight
        const todayIdx = days.findIndex(d => d.is_today);
        if (todayIdx >= 0) {
            ctx.fillStyle = '#fdfbf3';
            ctx.fillRect(PAD_L + todayIdx * slotW - 2, 0, slotW + 4, H);
        }

        // Filled area
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(points[0].x, baseY);
        points.forEach(p => {
            const y = PAD_T + chartH - (p.val / yMax) * chartH;
            ctx.lineTo(p.x, y);
        });
        ctx.lineTo(points[points.length - 1].x, baseY);
        ctx.closePath();

        const grad = ctx.createLinearGradient(0, PAD_T, 0, baseY);
        grad.addColorStop(0, 'rgba(142,99,31,0.18)');
        grad.addColorStop(1, 'rgba(142,99,31,0.03)');
        ctx.fillStyle = grad;
        ctx.fill();
        ctx.restore();

        // Line
        ctx.save();
        ctx.strokeStyle = 'rgba(142,99,31,0.55)';
        ctx.lineWidth = 1.5;
        ctx.lineJoin = 'round';
        ctx.beginPath();
        points.forEach((p, i) => {
            const y = PAD_T + chartH - (p.val / yMax) * chartH;
            if (i === 0) ctx.moveTo(p.x, y); else ctx.lineTo(p.x, y);
        });
        ctx.stroke();

        // Dots
        points.forEach(p => {
            const y = PAD_T + chartH - (p.val / yMax) * chartH;
            ctx.fillStyle = p.day.is_today ? '#8e631f' : 'rgba(142,99,31,0.5)';
            ctx.beginPath(); ctx.arc(p.x, y, p.day.is_today ? 3 : 2, 0, Math.PI * 2); ctx.fill();
        });

        // Value labels at key points (first, today, last)
        const labelPts = [points[points.length - 1]];
        if (todayIdx >= 0 && todayIdx < points.length - 1) labelPts.unshift(points[todayIdx]);

        labelPts.forEach(p => {
            const y = PAD_T + chartH - (p.val / yMax) * chartH;
            ctx.fillStyle = p.day.is_today ? '#8e631f' : 'rgba(142,99,31,0.65)';
            ctx.font = p.day.is_today ? "bold 9px 'Lato',sans-serif" : "8px 'Lato',sans-serif";
            ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
            ctx.fillText(isKr ? fmtKr(p.val) : p.val, p.x, y - 4);
        });

        // Right y-axis: total label
        const last = points[points.length - 1];
        const lastY = PAD_T + chartH - (last.val / yMax) * chartH;
        ctx.fillStyle = 'rgba(142,99,31,0.5)';
        ctx.font = "bold 9px 'Lato',sans-serif";
        ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
        const totalLabel = isKr ? last.val.toLocaleString('da-DK') + ' kr' : last.val.toLocaleString('da-DK');
        ctx.fillText(totalLabel, PAD_L + chartW + 4, lastY);

        ctx.restore();
    }

    // Initial draw (delayed to let main chart compute geom)
    setTimeout(draw, 60);

    return {
        destroy() { /* canvas cleared on removal */ },
        setMode(mode) { state.mode = mode; draw(); },
        redraw() { draw(); },
        update(newData) { state.data = newData; draw(); },
    };
}
