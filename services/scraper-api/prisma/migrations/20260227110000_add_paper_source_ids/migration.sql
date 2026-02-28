ALTER TABLE "paper_paper"
  ADD COLUMN IF NOT EXISTS "arxivId" TEXT,
  ADD COLUMN IF NOT EXISTS "semanticScholarPaperId" TEXT,
  ADD COLUMN IF NOT EXISTS "openreviewForumId" TEXT;

CREATE INDEX IF NOT EXISTS "paper_paper_arxivId_idx"
  ON "paper_paper"("arxivId");

CREATE INDEX IF NOT EXISTS "paper_paper_semanticScholarPaperId_idx"
  ON "paper_paper"("semanticScholarPaperId");

CREATE INDEX IF NOT EXISTS "paper_paper_openreviewForumId_idx"
  ON "paper_paper"("openreviewForumId");
