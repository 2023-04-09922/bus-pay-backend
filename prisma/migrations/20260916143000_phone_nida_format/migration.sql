-- Normalize stored phones to +255XXXXXXXXX so the Flutter +255 XXX XXXXXX
-- field matches existing 07XXXXXXXX accounts.
UPDATE "User"
SET "phone" = '+255' || RIGHT(REGEXP_REPLACE("phone", '[^0-9]', '', 'g'), 9)
WHERE REGEXP_REPLACE("phone", '[^0-9]', '', 'g') ~ '^[0-9]{9,12}$'
  AND "phone" !~ '^\+255[1-9][0-9]{8}$';

-- Store NIDA as 20 digits (xxxxxxxx-xxxxxxxxxxx-x without the dashes).
UPDATE "User"
SET "nida" = LEFT(REGEXP_REPLACE("nida", '[^0-9]', '', 'g'), 20)
WHERE "nida" IS NOT NULL
  AND (
    "nida" ~ '[^0-9]'
    OR char_length("nida") <> 20
  );
