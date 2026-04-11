-- Migration 037: Staff-tabel for medarbejdernavne
-- Bruges i varemodtagelse, planlægning m.fl. — adskilt fra auth-brugere (users-tabellen)

CREATE TABLE staff (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    is_owner   INTEGER NOT NULL DEFAULT 0,
    is_active  INTEGER NOT NULL DEFAULT 1,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Seed standard-brugere (matcher Whiteboard)
INSERT INTO staff (name, is_owner) VALUES ('Leif', 1);
INSERT INTO staff (name, is_owner) VALUES ('Anne', 1);
