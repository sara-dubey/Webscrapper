CREATE TABLE "SemanticScholarCitation" (
    "id" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "citationKey" TEXT NOT NULL,
    "sourcePaperId" TEXT,
    "direction" TEXT NOT NULL,
    "citedPaperId" TEXT,
    "title" TEXT NOT NULL,
    "abstract" TEXT,
    "year" INTEGER,
    "venue" TEXT,
    "url" TEXT,
    "citationCount" INTEGER,
    "influentialCitationCount" INTEGER,
    "rawPayload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SemanticScholarCitation_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "SemanticScholarCitation_paperId_citationKey_key" ON "SemanticScholarCitation"("paperId", "citationKey");
CREATE INDEX "SemanticScholarCitation_paperId_idx" ON "SemanticScholarCitation"("paperId");
CREATE INDEX "SemanticScholarCitation_direction_idx" ON "SemanticScholarCitation"("direction");
CREATE INDEX "SemanticScholarCitation_year_idx" ON "SemanticScholarCitation"("year");

ALTER TABLE "SemanticScholarCitation"
ADD CONSTRAINT "SemanticScholarCitation_paperId_fkey"
FOREIGN KEY ("paperId")
REFERENCES "Paper"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
