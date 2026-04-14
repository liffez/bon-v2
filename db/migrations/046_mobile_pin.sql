-- 046: Separat mobil-PIN kolonne
-- Tablet-PIN forbliver i 'pin', mobil-app bruger 'mobile_pin'
ALTER TABLE users ADD COLUMN mobile_pin TEXT;
