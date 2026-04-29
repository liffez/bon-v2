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
function buildStaffBadges(containerId, canvasId, days, opts = {}) {
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

    const alwaysCount = opts.alwaysCount === true;

    days.forEach((day, i) => {
        const cx = offsetLeft + PAD_L + (i + 0.5) * slotW;
        const staffList = day.shifts || [];
        if (!staffList.length) return;

        const typeClass = day.is_today ? 'type-today'
            : day.is_future ? 'type-future'
            : 'type-history';

        if (!alwaysCount && staffList.length <= SHOW_INDIVIDUAL_MAX) {
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

/* ── Monthly Bar Chart (12 months, this year vs prev year) ──── */

/**
 * 12-month bar chart: this year vs previous year side by side.
 * @param {string} canvasId
 * @param {object} data — { this_year: [{month, revenue, units, orders}], prev_year: [...] }
 * @param {object} opts — { mode: 'kr'|'enh' }
 * @returns {{ destroy, setMode, update, redraw }}
 */
function initMonthlyBarChart(canvasId, data, opts = {}) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;

    const MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'Maj', 'Jun', 'Jul', 'Aug', 'Sep', 'Okt', 'Nov', 'Dec'];
    const COLOR_THIS = '#8e631f';
    const COLOR_PREV = '#d0c8c0';

    const state = { mode: opts.mode || 'kr', data };
    let tooltip = document.getElementById(canvasId + 'Tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = canvasId + 'Tooltip';
        tooltip.className = 'chart-tooltip';
        document.body.appendChild(tooltip);
    }

    let hitBoxes = [];
    let activeHit = null;

    function niceMax(v) {
        if (v <= 0) return 100;
        const mag = Math.pow(10, Math.floor(Math.log10(v)));
        const norm = v / mag;
        const steps = [1, 1.5, 2, 3, 5, 7.5, 10];
        for (const s of steps) { if (norm <= s) return s * mag; }
        return 10 * mag;
    }

    function getVal(entry) {
        return state.mode === 'kr' ? (entry.revenue || 0) : (entry.units || 0);
    }

    function draw() {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        const W = rect.width, H = rect.height;

        const PAD_L = 42, PAD_R = 10, PAD_T = 16, PAD_B = 24;
        const chartW = W - PAD_L - PAD_R, chartH = H - PAD_T - PAD_B;

        const thisYear = state.data.this_year || [];
        const prevYear = state.data.prev_year || [];
        const months = [...new Set([...thisYear.map(e => e.month), ...prevYear.map(e => e.month)])].sort((a, b) => a - b);
        const N = months.length;
        if (N === 0) return;

        const thisMap = {}; thisYear.forEach(e => { thisMap[e.month] = e; });
        const prevMap = {}; prevYear.forEach(e => { prevMap[e.month] = e; });

        // Current month detection
        const currentMonth = new Date().getMonth() + 1;

        // yMax
        let maxVal = 1;
        months.forEach(m => {
            if (thisMap[m]) maxVal = Math.max(maxVal, getVal(thisMap[m]));
            if (prevMap[m]) maxVal = Math.max(maxVal, getVal(prevMap[m]));
        });
        const yMax = niceMax(maxVal * 1.1);

        // Grid lines
        const gridCount = 4;
        hitBoxes = [];
        ctx.font = "9px 'Lato',sans-serif";
        for (let i = 1; i <= gridCount; i++) {
            const val = Math.round((yMax / gridCount) * i);
            const gy = PAD_T + chartH - (val / yMax) * chartH;
            ctx.strokeStyle = '#ebebeb'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(PAD_L, gy); ctx.lineTo(W - PAD_R, gy); ctx.stroke();
            ctx.fillStyle = '#c0b9b2';
            ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
            ctx.fillText(fmtKr(val), PAD_L - 4, gy);
        }
        // Baseline
        ctx.strokeStyle = '#d7d1ca'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(PAD_L, PAD_T + chartH); ctx.lineTo(W - PAD_R, PAD_T + chartH); ctx.stroke();

        const slotW = chartW / N;
        const barW = slotW * 0.32;
        const gap = 2;
        const baseY = PAD_T + chartH;

        months.forEach((m, i) => {
            const cx = PAD_L + (i + 0.5) * slotW;

            // Prev year bar (left)
            const pv = prevMap[m] ? getVal(prevMap[m]) : 0;
            if (pv > 0) {
                const bh = (pv / yMax) * chartH;
                const bx = cx - barW - gap / 2;
                const by = baseY - bh;
                ctx.fillStyle = COLOR_PREV;
                rrect(ctx, bx, by, barW, bh, 2); ctx.fill();
                hitBoxes.push({ x: bx, y: by, w: barW, h: bh, month: m, year: 'prev', val: pv });
            }

            // This year bar (right)
            const tv = thisMap[m] ? getVal(thisMap[m]) : 0;
            if (tv > 0) {
                const bh = (tv / yMax) * chartH;
                const bx = cx + gap / 2;
                const by = baseY - bh;
                ctx.globalAlpha = (m === currentMonth) ? 0.5 : 1;
                ctx.fillStyle = COLOR_THIS;
                rrect(ctx, bx, by, barW, bh, 2); ctx.fill();
                ctx.globalAlpha = 1;
                hitBoxes.push({ x: bx, y: by, w: barW, h: bh, month: m, year: 'this', val: tv });
            }

            // Month label
            ctx.fillStyle = '#b0a898';
            ctx.font = "9px 'Lato',sans-serif";
            ctx.textAlign = 'center'; ctx.textBaseline = 'top';
            ctx.fillText(MONTH_LABELS[m - 1] || '', cx, baseY + 6);
        });
    }

    function getHit(x, y) {
        for (let i = hitBoxes.length - 1; i >= 0; i--) {
            const h = hitBoxes[i];
            if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h;
        }
        return null;
    }

    function showTT(hit, px, py) {
        const label = MONTH_LABELS[hit.month - 1] || '';
        const yearLabel = hit.year === 'this' ? 'I år' : 'Sidste år';
        const valStr = state.mode === 'kr' ? hit.val.toLocaleString('da-DK') + ' kr' : hit.val.toLocaleString('da-DK') + ' enh';
        tooltip.innerHTML = `<div class="tt-kat">${label} — ${yearLabel}</div><div class="tt-enh">${valStr}</div>`;
        tooltip.style.display = 'block';
        const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
        let tx = px + 14, ty = py - th / 2;
        if (tx + tw > window.innerWidth - 8) tx = px - tw - 14;
        if (ty < 4) ty = 4;
        tooltip.style.left = tx + 'px'; tooltip.style.top = ty + 'px';
    }

    function hideTT() { tooltip.style.display = 'none'; activeHit = null; }

    function onMousemove(e) {
        const r = canvas.getBoundingClientRect();
        const hit = getHit(e.clientX - r.left, e.clientY - r.top);
        if (hit) { activeHit = hit; showTT(hit, e.clientX, e.clientY); canvas.style.cursor = 'pointer'; }
        else if (activeHit) { hideTT(); canvas.style.cursor = 'default'; }
    }
    function onMouseleave() { hideTT(); }
    function onResize() { draw(); }

    canvas.addEventListener('mousemove', onMousemove);
    canvas.addEventListener('mouseleave', onMouseleave);
    window.addEventListener('resize', onResize);

    const listeners = [
        ['mousemove', onMousemove, canvas],
        ['mouseleave', onMouseleave, canvas],
        ['resize', onResize, window],
    ];

    draw();

    return {
        destroy() {
            for (const [evt, fn, el] of listeners) el.removeEventListener(evt, fn);
            if (tooltip.parentNode) tooltip.parentNode.removeChild(tooltip);
        },
        setMode(mode) { state.mode = mode; draw(); },
        update(newData) { state.data = newData; draw(); },
        redraw() { draw(); },
    };
}

/* ── Lego Stacked Chart (period comparison with stacked categories) ── */

/**
 * Stacked bar chart: split canvas into two halves (revenue left, orders right).
 * Each half shows one stacked bar per period.
 * @param {string} canvasId
 * @param {object} data — { periods: [{label, stacks: [{key, label, color, orders, revenue}]}], categories: [{key, label, color}] }
 * @param {object} opts — { mode: 'revenue'|'orders' } (default: split view showing both)
 * @returns {{ destroy, update, redraw }}
 */
function initLegoStackedChart(canvasId, data, opts = {}) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;

    const state = { mode: opts.mode || null, data };
    let tooltip = document.getElementById(canvasId + 'Tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = canvasId + 'Tooltip';
        tooltip.className = 'chart-tooltip';
        document.body.appendChild(tooltip);
    }

    let hitBoxes = [];
    let activeHit = null;

    function niceMax(v) {
        if (v <= 0) return 100;
        const mag = Math.pow(10, Math.floor(Math.log10(v)));
        const norm = v / mag;
        const steps = [1, 1.5, 2, 3, 5, 7.5, 10];
        for (const s of steps) { if (norm <= s) return s * mag; }
        return 10 * mag;
    }

    function drawHalf(ctx, field, title, ox, ow, PAD_T, chartH, PAD_B, periods) {
        const PAD_L_INNER = 42, PAD_R_INNER = 10;
        const areaW = ow - PAD_L_INNER - PAD_R_INNER;
        const baseY = PAD_T + chartH;

        // Compute max stacked total for this field
        let maxVal = 1;
        periods.forEach(p => {
            let total = 0;
            (p.stacks || []).forEach(s => { total += (s[field] || 0); });
            if (total > maxVal) maxVal = total;
        });
        const yMax = niceMax(maxVal * 1.1);

        // Title
        ctx.fillStyle = '#8e631f';
        ctx.font = "bold 10px 'Lato',sans-serif";
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillText(title, ox + PAD_L_INNER + areaW / 2, 2);

        // Grid lines + y-axis labels
        const gridCount = 4;
        ctx.font = "9px 'Lato',sans-serif";
        for (let i = 1; i <= gridCount; i++) {
            const val = Math.round((yMax / gridCount) * i);
            const gy = PAD_T + chartH - (val / yMax) * chartH;
            ctx.strokeStyle = '#ebebeb'; ctx.lineWidth = 1;
            ctx.beginPath();
            ctx.moveTo(ox + PAD_L_INNER, gy);
            ctx.lineTo(ox + PAD_L_INNER + areaW, gy);
            ctx.stroke();
            ctx.fillStyle = '#c0b9b2';
            ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
            ctx.fillText(field === 'revenue' ? fmtKr(val) : val + '', ox + PAD_L_INNER - 4, gy);
        }

        // Baseline
        ctx.strokeStyle = '#d7d1ca'; ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(ox + PAD_L_INNER, baseY);
        ctx.lineTo(ox + PAD_L_INNER + areaW, baseY);
        ctx.stroke();

        // Bars
        const N = periods.length;
        if (N === 0) return;
        const slotW = areaW / N;
        const barW = Math.min(slotW * 0.55, 60);

        periods.forEach((period, pi) => {
            const cx = ox + PAD_L_INNER + (pi + 0.5) * slotW;
            const bx = cx - barW / 2;
            let curY = baseY;

            (period.stacks || []).forEach(seg => {
                const val = seg[field] || 0;
                if (val <= 0) return;
                const segH = (val / yMax) * chartH;
                const sy = curY - segH;
                ctx.fillStyle = seg.color || CATS[seg.label]?.color || '#aaa';
                rrect(ctx, bx, sy, barW, segH, 2); ctx.fill();

                // Value label inside segment (white if tall enough, else above)
                const labelText = field === 'revenue' ? fmtKr(val) : val + '';
                if (segH >= 16) {
                    ctx.fillStyle = '#fff';
                    ctx.font = "bold 9px 'Lato',sans-serif";
                    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
                    ctx.fillText(labelText, bx + barW / 2, sy + segH / 2);
                } else if (segH >= 6) {
                    ctx.fillStyle = '#8e631f';
                    ctx.font = "8px 'Lato',sans-serif";
                    ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
                    ctx.fillText(labelText, bx + barW / 2, sy - 2);
                }

                hitBoxes.push({ x: bx, y: sy, w: barW, h: segH, segLabel: seg.label, segKey: seg.key, periodLabel: period.label, field, val });
                curY = sy;
            });

            // Period label below x-axis
            ctx.fillStyle = '#8e631f';
            ctx.font = "10px 'Lato',sans-serif";
            ctx.textAlign = 'center'; ctx.textBaseline = 'top';
            ctx.fillText(period.label, cx, baseY + 6);
        });
    }

    function draw() {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        const W = rect.width, H = rect.height;

        const PAD_T = 18, PAD_B = 44; // extra bottom for legend
        const chartH = H - PAD_T - PAD_B;
        const periods = state.data.periods || [];

        hitBoxes = [];

        if (state.mode === 'revenue') {
            drawHalf(ctx, 'revenue', 'OMSÆT KR', 0, W, PAD_T, chartH, PAD_B, periods);
        } else if (state.mode === 'orders') {
            drawHalf(ctx, 'orders', 'ANTAL ORDRER', 0, W, PAD_T, chartH, PAD_B, periods);
        } else {
            // Split view: left = revenue, right = orders
            const halfW = Math.floor(W / 2);
            // Divider line
            ctx.strokeStyle = '#e0dbd5'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(halfW, PAD_T - 4); ctx.lineTo(halfW, PAD_T + chartH + 20); ctx.stroke();

            drawHalf(ctx, 'revenue', 'OMSÆT KR', 0, halfW, PAD_T, chartH, PAD_B, periods);
            drawHalf(ctx, 'orders', 'ANTAL ORDRER', halfW, W - halfW, PAD_T, chartH, PAD_B, periods);
        }

        // Legend at bottom
        const cats = state.data.categories || [];
        if (cats.length > 0) {
            const legendY = H - 16;
            ctx.font = "9px 'Lato',sans-serif";
            ctx.textBaseline = 'middle';
            let lx = 12;
            cats.forEach(cat => {
                ctx.fillStyle = cat.color || CATS[cat.label]?.color || '#aaa';
                ctx.fillRect(lx, legendY - 5, 10, 10);
                lx += 14;
                ctx.fillStyle = '#8e631f';
                ctx.textAlign = 'left';
                const tw = ctx.measureText(cat.label).width;
                ctx.fillText(cat.label, lx, legendY);
                lx += tw + 14;
            });
        }
    }

    function getHit(x, y) {
        for (let i = hitBoxes.length - 1; i >= 0; i--) {
            const h = hitBoxes[i];
            if (x >= h.x && x <= h.x + h.w && y >= h.y && y <= h.y + h.h) return h;
        }
        return null;
    }

    function showTT(hit, px, py) {
        const fieldLabel = hit.field === 'revenue' ? 'kr' : 'ordrer';
        const valStr = hit.val.toLocaleString('da-DK') + ' ' + fieldLabel;
        tooltip.innerHTML = `<div class="tt-kat" style="color:${hit.color || CATS[hit.segLabel]?.color || '#aaa'}">${hit.segLabel} — ${hit.periodLabel}</div><div class="tt-enh">${valStr}</div>`;
        tooltip.style.display = 'block';
        const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
        let tx = px + 14, ty = py - th / 2;
        if (tx + tw > window.innerWidth - 8) tx = px - tw - 14;
        if (ty < 4) ty = 4;
        tooltip.style.left = tx + 'px'; tooltip.style.top = ty + 'px';
    }

    function hideTT() { tooltip.style.display = 'none'; activeHit = null; }

    function onMousemove(e) {
        const r = canvas.getBoundingClientRect();
        const hit = getHit(e.clientX - r.left, e.clientY - r.top);
        if (hit) { activeHit = hit; showTT(hit, e.clientX, e.clientY); canvas.style.cursor = 'pointer'; }
        else if (activeHit) { hideTT(); canvas.style.cursor = 'default'; }
    }
    function onMouseleave() { hideTT(); }
    function onResize() { draw(); }

    canvas.addEventListener('mousemove', onMousemove);
    canvas.addEventListener('mouseleave', onMouseleave);
    window.addEventListener('resize', onResize);

    const listeners = [
        ['mousemove', onMousemove, canvas],
        ['mouseleave', onMouseleave, canvas],
        ['resize', onResize, window],
    ];

    draw();

    return {
        destroy() {
            for (const [evt, fn, el] of listeners) el.removeEventListener(evt, fn);
            if (tooltip.parentNode) tooltip.parentNode.removeChild(tooltip);
        },
        update(newData) { state.data = newData; draw(); },
        redraw() { draw(); },
    };
}

/* ── Multi-Year Accumulated Revenue Chart ─────────────────────── */

/**
 * Multi-year cumulative revenue chart (standalone).
 * @param {string} canvasId
 * @param {object} data — { years: { "2023": [{week, cumulative}], "2024": [...], ... } }
 * @param {object} opts — { currentYear: '2025' }
 * @returns {{ destroy, setMode, update, redraw }}
 */
function initMultiYearAccumChart(canvasId, data, opts = {}) {
    const canvas = document.getElementById(canvasId);
    if (!canvas) return null;

    const state = { data, currentYear: opts.currentYear || String(new Date().getFullYear()) };
    let tooltip = document.getElementById(canvasId + 'Tooltip');
    if (!tooltip) {
        tooltip = document.createElement('div');
        tooltip.id = canvasId + 'Tooltip';
        tooltip.className = 'chart-tooltip';
        document.body.appendChild(tooltip);
    }

    let hoverWeek = null;
    let yearLines = []; // cached for hover: [{year, points: [{week, cum, x, y}]}]

    const PREV_COLORS = ['rgba(180,170,160,0.6)', 'rgba(180,170,160,0.35)', 'rgba(180,170,160,0.2)'];

    function draw() {
        const dpr = window.devicePixelRatio || 1;
        const rect = canvas.getBoundingClientRect();
        canvas.width = rect.width * dpr;
        canvas.height = rect.height * dpr;
        const ctx = canvas.getContext('2d');
        ctx.scale(dpr, dpr);
        const W = rect.width, H = rect.height;

        const PAD_L = 48, PAD_R = 50, PAD_T = 16, PAD_B = 24;
        const chartW = W - PAD_L - PAD_R, chartH = H - PAD_T - PAD_B;

        const years = state.data.years || {};
        const yearKeys = Object.keys(years).sort();
        if (yearKeys.length === 0) return;

        // yMax across all years
        let maxCum = 1;
        yearKeys.forEach(yk => {
            const pts = years[yk] || [];
            pts.forEach(p => { maxCum = Math.max(maxCum, p.cumulative || 0); });
        });
        const yMax = Math.ceil(maxCum / 50000) * 50000 + 20000 || maxCum * 1.15;

        // Grid lines
        const gridCount = 4;
        ctx.font = "9px 'Lato',sans-serif";
        for (let i = 1; i <= gridCount; i++) {
            const val = Math.round((yMax / gridCount) * i);
            const gy = PAD_T + chartH - (val / yMax) * chartH;
            ctx.strokeStyle = '#ebebeb'; ctx.lineWidth = 1;
            ctx.beginPath(); ctx.moveTo(PAD_L, gy); ctx.lineTo(W - PAD_R, gy); ctx.stroke();
            ctx.fillStyle = '#c0b9b2';
            ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
            ctx.fillText(fmtKr(val), PAD_L - 4, gy);
        }

        // Baseline
        ctx.strokeStyle = '#d7d1ca'; ctx.lineWidth = 1;
        ctx.beginPath(); ctx.moveTo(PAD_L, PAD_T + chartH); ctx.lineTo(W - PAD_R, PAD_T + chartH); ctx.stroke();

        // X-axis: weeks 1-52, labels every 4 weeks
        const weekToX = w => PAD_L + ((w - 1) / 51) * chartW;
        ctx.fillStyle = '#b0a898';
        ctx.font = "8px 'Lato',sans-serif";
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        for (let w = 4; w <= 52; w += 4) {
            ctx.fillText('U' + w, weekToX(w), PAD_T + chartH + 6);
        }

        const valToY = v => PAD_T + chartH - (v / yMax) * chartH;

        yearLines = [];

        // Draw previous years first (behind)
        let prevColorIdx = 0;
        const sortedYears = [...yearKeys].sort((a, b) => {
            if (a === state.currentYear) return 1; // draw current last
            if (b === state.currentYear) return -1;
            return a.localeCompare(b);
        });

        sortedYears.forEach(yk => {
            const pts = years[yk] || [];
            if (pts.length === 0) return;
            const isCurrent = yk === state.currentYear;

            const linePoints = pts.map(p => ({
                week: p.week,
                cum: p.cumulative || 0,
                x: weekToX(p.week),
                y: valToY(p.cumulative || 0),
            }));
            yearLines.push({ year: yk, points: linePoints });

            if (isCurrent) {
                // Filled area
                ctx.save();
                ctx.beginPath();
                ctx.moveTo(linePoints[0].x, PAD_T + chartH);
                linePoints.forEach(p => ctx.lineTo(p.x, p.y));
                ctx.lineTo(linePoints[linePoints.length - 1].x, PAD_T + chartH);
                ctx.closePath();
                ctx.fillStyle = 'rgba(142,99,31,0.15)';
                ctx.fill();
                ctx.restore();

                // Solid line
                ctx.save();
                ctx.strokeStyle = '#8e631f';
                ctx.lineWidth = 2;
                ctx.lineJoin = 'round';
                ctx.beginPath();
                linePoints.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
                ctx.stroke();
                ctx.restore();
            } else {
                // Dashed line
                const color = PREV_COLORS[prevColorIdx % PREV_COLORS.length];
                prevColorIdx++;
                ctx.save();
                ctx.strokeStyle = color;
                ctx.lineWidth = 1;
                ctx.setLineDash([4, 3]);
                ctx.lineJoin = 'round';
                ctx.beginPath();
                linePoints.forEach((p, i) => { if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y); });
                ctx.stroke();
                ctx.restore();
            }

            // Dot at last data point
            const last = linePoints[linePoints.length - 1];
            ctx.fillStyle = isCurrent ? '#8e631f' : 'rgba(180,170,160,0.6)';
            ctx.beginPath();
            ctx.arc(last.x, last.y, isCurrent ? 3.5 : 2.5, 0, Math.PI * 2);
            ctx.fill();

            // Year label at end
            ctx.fillStyle = isCurrent ? '#8e631f' : 'rgba(160,150,140,0.7)';
            ctx.font = isCurrent ? "bold 9px 'Lato',sans-serif" : "italic 8px 'Lato',sans-serif";
            ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
            ctx.fillText(yk, last.x + 6, last.y);
        });

        // Hover indicator
        if (hoverWeek !== null) {
            const hx = weekToX(hoverWeek);
            ctx.save();
            ctx.strokeStyle = 'rgba(142,99,31,0.25)';
            ctx.lineWidth = 1;
            ctx.setLineDash([2, 2]);
            ctx.beginPath(); ctx.moveTo(hx, PAD_T); ctx.lineTo(hx, PAD_T + chartH); ctx.stroke();
            ctx.restore();

            // Dots on each line at hover week
            yearLines.forEach(yl => {
                const pt = yl.points.find(p => p.week === hoverWeek);
                if (pt) {
                    const isCurrent = yl.year === state.currentYear;
                    ctx.fillStyle = isCurrent ? '#8e631f' : 'rgba(180,170,160,0.8)';
                    ctx.beginPath(); ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2); ctx.fill();
                }
            });
        }
    }

    function weekFromX(mx) {
        const rect = canvas.getBoundingClientRect();
        const PAD_L = 48, PAD_R = 50;
        const chartW = rect.width - PAD_L - PAD_R;
        const relX = mx - PAD_L;
        if (relX < 0 || relX > chartW) return null;
        return Math.round((relX / chartW) * 51) + 1;
    }

    function showTT(week, px, py) {
        let rows = `<div class="tt-kat">Uge ${week}</div>`;
        yearLines.forEach(yl => {
            const pt = yl.points.find(p => p.week === week);
            // Find closest if exact week missing
            let val = 0;
            if (pt) {
                val = pt.cum;
            } else {
                // Interpolate: find nearest below
                const below = yl.points.filter(p => p.week <= week);
                if (below.length > 0) val = below[below.length - 1].cum;
            }
            const isCurrent = yl.year === state.currentYear;
            const style = isCurrent ? 'font-weight:bold' : 'opacity:0.7';
            rows += `<div class="tt-row" style="${style}"><span>${yl.year}</span><span class="tt-val">${val.toLocaleString('da-DK')} kr</span></div>`;
        });
        tooltip.innerHTML = rows;
        tooltip.style.display = 'block';
        const tw = tooltip.offsetWidth, th = tooltip.offsetHeight;
        let tx = px + 14, ty = py - th / 2;
        if (tx + tw > window.innerWidth - 8) tx = px - tw - 14;
        if (ty < 4) ty = 4;
        tooltip.style.left = tx + 'px'; tooltip.style.top = ty + 'px';
    }

    function hideTT() { tooltip.style.display = 'none'; hoverWeek = null; }

    function onMousemove(e) {
        const r = canvas.getBoundingClientRect();
        const mx = e.clientX - r.left;
        const week = weekFromX(mx);
        if (week && week >= 1 && week <= 52) {
            hoverWeek = week;
            draw();
            showTT(week, e.clientX, e.clientY);
            canvas.style.cursor = 'crosshair';
        } else if (hoverWeek !== null) {
            hoverWeek = null;
            draw();
            hideTT();
            canvas.style.cursor = 'default';
        }
    }

    function onMouseleave() {
        hoverWeek = null;
        draw();
        hideTT();
    }

    function onResize() { draw(); }

    canvas.addEventListener('mousemove', onMousemove);
    canvas.addEventListener('mouseleave', onMouseleave);
    window.addEventListener('resize', onResize);

    const listeners = [
        ['mousemove', onMousemove, canvas],
        ['mouseleave', onMouseleave, canvas],
        ['resize', onResize, window],
    ];

    draw();

    return {
        destroy() {
            for (const [evt, fn, el] of listeners) el.removeEventListener(evt, fn);
            if (tooltip.parentNode) tooltip.parentNode.removeChild(tooltip);
        },
        setMode() { /* single mode — no-op for API consistency */ },
        update(newData) { state.data = newData; draw(); },
        redraw() { draw(); },
    };
}
