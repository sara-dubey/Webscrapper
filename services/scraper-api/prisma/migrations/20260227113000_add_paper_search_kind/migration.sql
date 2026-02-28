ALTER TABLE "paper_paper"
  ADD COLUMN IF NOT EXISTS "searchKind" TEXT NOT NULL DEFAULT 'main_search';

CREATE INDEX IF NOT EXISTS "paper_paper_searchKind_idx"
  ON "paper_paper"("searchKind");
