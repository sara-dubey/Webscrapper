ALTER TABLE "PaperSummary"
  ADD COLUMN IF NOT EXISTS "promptText" TEXT;

ALTER TABLE "PaperSummary"
  ADD COLUMN IF NOT EXISTS "summarySource" JSONB;
