-- Migration 053: contact_points (kontaktpunkter med kilde + offentlig/privat-flag)
-- Polymorf tabel: én kontaktpunkt tilhører enten et company eller en customer.
-- Backfill fra eksisterende email/phone/invoice_email kolonner som source='manual', is_public=0.
--
-- VIGTIGT: Denne migration tilføjer triggers på companies.email/phone og customers.email/phone.
-- Hvis en fremtidig migration skal ændre disse kolonner, skal triggerne droppes først:
--   DROP TRIGGER IF EXISTS trg_companies_email_to_cp;
--   DROP TRIGGER IF EXISTS trg_companies_phone_to_cp;
--   DROP TRIGGER IF EXISTS trg_customers_email_to_cp;
--   DROP TRIGGER IF EXISTS trg_customers_phone_to_cp;
-- ... og derefter genskabes (kopiér fra denne migration).

-- ==========================================
-- contact_points-tabel
-- ==========================================

CREATE TABLE contact_points (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type     TEXT NOT NULL
                        CHECK (entity_type IN ('company', 'customer')),
    entity_id       INTEGER NOT NULL,
    kind            TEXT NOT NULL
                        CHECK (kind IN ('email', 'phone')),
    value           TEXT NOT NULL,
    source          TEXT NOT NULL DEFAULT 'manual'
                        CHECK (source IN ('cvr', 'nemhandel', 'website', 'form', 'mail', 'manual')),
    is_public       INTEGER NOT NULL DEFAULT 0,
    is_primary      INTEGER NOT NULL DEFAULT 0,
    purpose         TEXT,
    verified_at     DATETIME,
    last_seen_at    DATETIME,
    is_active       INTEGER NOT NULL DEFAULT 1,
    notes           TEXT,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE(entity_type, entity_id, kind, value)
);

CREATE INDEX idx_cp_entity   ON contact_points(entity_type, entity_id);
CREATE INDEX idx_cp_value    ON contact_points(value);
CREATE INDEX idx_cp_public   ON contact_points(is_public) WHERE is_active = 1;
CREATE INDEX idx_cp_primary  ON contact_points(entity_type, entity_id, kind) WHERE is_primary = 1;

-- ==========================================
-- Backfill fra companies (email + phone som primary, invoice_email som ikke-primary med purpose='Faktura')
-- Default: source='manual', is_public=0 (juridisk sikker default)
-- ==========================================

INSERT INTO contact_points
    (entity_type, entity_id, kind, value, source, is_public, is_primary, purpose)
SELECT 'company', id, 'email', email, 'manual', 0, 1, 'Hovedmail'
FROM companies
WHERE email IS NOT NULL AND TRIM(email) != '';

INSERT INTO contact_points
    (entity_type, entity_id, kind, value, source, is_public, is_primary, purpose)
SELECT 'company', id, 'phone', phone, 'manual', 0, 1, 'Hovednummer'
FROM companies
WHERE phone IS NOT NULL AND TRIM(phone) != '';

-- invoice_email kun hvis forskellig fra email (og ikke tom)
INSERT INTO contact_points
    (entity_type, entity_id, kind, value, source, is_public, is_primary, purpose)
SELECT 'company', id, 'email', invoice_email, 'manual', 0, 0, 'Faktura'
FROM companies
WHERE invoice_email IS NOT NULL
  AND TRIM(invoice_email) != ''
  AND invoice_email != COALESCE(email, '');

-- ==========================================
-- Backfill fra customers
-- ==========================================

INSERT INTO contact_points
    (entity_type, entity_id, kind, value, source, is_public, is_primary, purpose)
SELECT 'customer', id, 'email', email, 'manual', 0, 1, NULL
FROM customers
WHERE email IS NOT NULL AND TRIM(email) != '';

INSERT INTO contact_points
    (entity_type, entity_id, kind, value, source, is_public, is_primary, purpose)
SELECT 'customer', id, 'phone', phone, 'manual', 0, 1, NULL
FROM customers
WHERE phone IS NOT NULL AND TRIM(phone) != '';

-- ==========================================
-- Cache-triggers: fang legacy-writes der UPDATE'er companies/customers direkte.
-- Sikrer at contact_points holdes i sync med den denormaliserede cache,
-- så vi ikke får et "kendt misforhold" når sync-v1, webhooks eller manuelle SQL-fixes
-- skriver direkte. Triggers skriver med source='manual', is_public=0 (sikker default).
--
-- Bemærk: contact_points → companies/customers retningen håndteres af
-- syncPrimaryCache() i shared/contactPoints.js (direkte UPDATE i routerne).
-- ==========================================

-- companies.email
CREATE TRIGGER trg_companies_email_to_cp
AFTER UPDATE OF email ON companies
WHEN COALESCE(NEW.email, '') != COALESCE(OLD.email, '')
BEGIN
    UPDATE contact_points
       SET value = NEW.email,
           updated_at = CURRENT_TIMESTAMP
     WHERE entity_type = 'company'
       AND entity_id = NEW.id
       AND kind = 'email'
       AND is_primary = 1
       AND is_active = 1
       AND NEW.email IS NOT NULL
       AND TRIM(NEW.email) != '';

    INSERT INTO contact_points
        (entity_type, entity_id, kind, value, source, is_public, is_primary, purpose)
    SELECT 'company', NEW.id, 'email', NEW.email, 'manual', 0, 1, 'Hovedmail'
    WHERE NEW.email IS NOT NULL
      AND TRIM(NEW.email) != ''
      AND NOT EXISTS (
          SELECT 1 FROM contact_points
          WHERE entity_type = 'company'
            AND entity_id = NEW.id
            AND kind = 'email'
            AND is_primary = 1
            AND is_active = 1
      );
END;

-- companies.phone
CREATE TRIGGER trg_companies_phone_to_cp
AFTER UPDATE OF phone ON companies
WHEN COALESCE(NEW.phone, '') != COALESCE(OLD.phone, '')
BEGIN
    UPDATE contact_points
       SET value = NEW.phone,
           updated_at = CURRENT_TIMESTAMP
     WHERE entity_type = 'company'
       AND entity_id = NEW.id
       AND kind = 'phone'
       AND is_primary = 1
       AND is_active = 1
       AND NEW.phone IS NOT NULL
       AND TRIM(NEW.phone) != '';

    INSERT INTO contact_points
        (entity_type, entity_id, kind, value, source, is_public, is_primary, purpose)
    SELECT 'company', NEW.id, 'phone', NEW.phone, 'manual', 0, 1, 'Hovednummer'
    WHERE NEW.phone IS NOT NULL
      AND TRIM(NEW.phone) != ''
      AND NOT EXISTS (
          SELECT 1 FROM contact_points
          WHERE entity_type = 'company'
            AND entity_id = NEW.id
            AND kind = 'phone'
            AND is_primary = 1
            AND is_active = 1
      );
END;

-- customers.email
CREATE TRIGGER trg_customers_email_to_cp
AFTER UPDATE OF email ON customers
WHEN COALESCE(NEW.email, '') != COALESCE(OLD.email, '')
BEGIN
    UPDATE contact_points
       SET value = NEW.email,
           updated_at = CURRENT_TIMESTAMP
     WHERE entity_type = 'customer'
       AND entity_id = NEW.id
       AND kind = 'email'
       AND is_primary = 1
       AND is_active = 1
       AND NEW.email IS NOT NULL
       AND TRIM(NEW.email) != '';

    INSERT INTO contact_points
        (entity_type, entity_id, kind, value, source, is_public, is_primary)
    SELECT 'customer', NEW.id, 'email', NEW.email, 'manual', 0, 1
    WHERE NEW.email IS NOT NULL
      AND TRIM(NEW.email) != ''
      AND NOT EXISTS (
          SELECT 1 FROM contact_points
          WHERE entity_type = 'customer'
            AND entity_id = NEW.id
            AND kind = 'email'
            AND is_primary = 1
            AND is_active = 1
      );
END;

-- customers.phone
CREATE TRIGGER trg_customers_phone_to_cp
AFTER UPDATE OF phone ON customers
WHEN COALESCE(NEW.phone, '') != COALESCE(OLD.phone, '')
BEGIN
    UPDATE contact_points
       SET value = NEW.phone,
           updated_at = CURRENT_TIMESTAMP
     WHERE entity_type = 'customer'
       AND entity_id = NEW.id
       AND kind = 'phone'
       AND is_primary = 1
       AND is_active = 1
       AND NEW.phone IS NOT NULL
       AND TRIM(NEW.phone) != '';

    INSERT INTO contact_points
        (entity_type, entity_id, kind, value, source, is_public, is_primary)
    SELECT 'customer', NEW.id, 'phone', NEW.phone, 'manual', 0, 1
    WHERE NEW.phone IS NOT NULL
      AND TRIM(NEW.phone) != ''
      AND NOT EXISTS (
          SELECT 1 FROM contact_points
          WHERE entity_type = 'customer'
            AND entity_id = NEW.id
            AND kind = 'phone'
            AND is_primary = 1
            AND is_active = 1
      );
END;
