-- ==========================================
-- 006_views.sql
-- SQL Views til hyppigt brugte queries
-- ==========================================

-- ==========================================
-- v_kitchen_today
-- ==========================================
-- Køkkenets daglige view: kun dagens bonner,
-- ikke terminal/aflyst status.
-- Sorteret efter pickup-tid.

CREATE VIEW v_kitchen_today AS
SELECT
    b.id,
    b.bon_number,
    b.pickup_time,
    b.delivery_time,
    b.delivery_type,
    b.pax,
    b.total_units,
    b.kitchen_info,
    b.kitchen_selects,
    b.customer_collects,
    b.prep_ingredients_ready,
    b.prep_supplies_ready,
    s.code   AS status_code,
    s.label  AS status_label,
    s.color  AS status_color,
    c.first_name || ' ' || COALESCE(c.last_name, '') AS customer_name,
    co.name  AS company_name
FROM bons b
JOIN status_definitions s ON b.status_id = s.id
LEFT JOIN customers c ON b.customer_id = c.id
LEFT JOIN companies co ON b.company_id = co.id
WHERE b.delivery_date = DATE('now')
    AND s.category NOT IN ('terminal', 'cancel')
    AND b.is_offer = 0
ORDER BY b.pickup_time ASC;

-- ==========================================
-- v_kitchen_later
-- ==========================================
-- Prep-view: kommende bonner til forberedelse.
-- Viser bonner de næste 7 dage med GODKENDT/IGANG status.

CREATE VIEW v_kitchen_later AS
SELECT
    b.id,
    b.bon_number,
    b.delivery_date,
    b.pickup_time,
    b.pax,
    b.total_units,
    b.prep_ingredients_ready,
    b.prep_supplies_ready,
    s.code   AS status_code,
    s.label  AS status_label,
    s.color  AS status_color,
    c.first_name || ' ' || COALESCE(c.last_name, '') AS customer_name,
    co.name  AS company_name
FROM bons b
JOIN status_definitions s ON b.status_id = s.id
LEFT JOIN customers c ON b.customer_id = c.id
LEFT JOIN companies co ON b.company_id = co.id
WHERE b.delivery_date > DATE('now')
    AND b.delivery_date <= DATE('now', '+7 days')
    AND s.code IN ('GODKENDT', 'IGANG')
    AND b.is_offer = 0
ORDER BY b.delivery_date ASC, b.pickup_time ASC;

-- ==========================================
-- v_day_totals
-- ==========================================
-- Totaler per dag til kalender-header.
-- Bruges til at vise "8 bonner · 142 pax" i toppen.

CREATE VIEW v_day_totals AS
SELECT
    delivery_date,
    COUNT(*)                                                AS bon_count,
    SUM(COALESCE(pax, 0))                                   AS total_pax,
    SUM(COALESCE(total_units, 0))                           AS total_units
FROM bons
WHERE is_offer = 0
GROUP BY delivery_date;

-- ==========================================
-- v_active_notifications
-- ==========================================
-- Aktive flyvere der endnu ikke er læst af alle.
-- Backend bruger denne til SSE-push til klienter.

CREATE VIEW v_active_notifications AS
SELECT
    n.id,
    n.bon_id,
    b.bon_number,
    n.type,
    n.message,
    n.priority,
    n.created_at,
    n.sent_by_user_id,
    u.name AS sent_by_name
FROM notifications n
LEFT JOIN bons b ON n.bon_id = b.id
LEFT JOIN users u ON n.sent_by_user_id = u.id
ORDER BY n.created_at DESC;

-- ==========================================
-- v_category_totals_today
-- ==========================================
-- Dagsoverblik per varekategori.
-- "42 smørrebrød, 16 salater" i køkken-header.

CREATE VIEW v_category_totals_today AS
SELECT
    bl.category,
    SUM(bl.quantity) AS total_quantity,
    bl.unit
FROM bon_lines bl
JOIN bons b ON bl.bon_id = b.id
JOIN status_definitions s ON b.status_id = s.id
WHERE b.delivery_date = DATE('now')
    AND s.category NOT IN ('terminal', 'cancel')
    AND b.is_offer = 0
    AND bl.category IS NOT NULL
GROUP BY bl.category, bl.unit
ORDER BY total_quantity DESC;
