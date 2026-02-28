ALTER TABLE "User"
  DROP COLUMN IF EXISTS "mfaEnabled",
  DROP COLUMN IF EXISTS "mfaSecret",
  DROP COLUMN IF EXISTS "mfaTempSecret",
  DROP COLUMN IF EXISTS "mfaRecoveryCodes";
