ALTER TABLE "paper_paper"
  ADD COLUMN IF NOT EXISTS "venue" TEXT,
  ADD COLUMN IF NOT EXISTS "citationCount" INTEGER,
  ADD COLUMN IF NOT EXISTS "referenceCount" INTEGER;

ALTER TABLE "paper_semantic_scholar_citation"
  DROP COLUMN IF EXISTS "year",
  DROP COLUMN IF EXISTS "venue",
  DROP COLUMN IF EXISTS "citationCount";
