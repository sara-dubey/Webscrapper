ALTER TABLE "paper_paper"
  ADD COLUMN IF NOT EXISTS "huggingfaceComments" JSONB;
