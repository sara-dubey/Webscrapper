CREATE TABLE "OpenReviewNote" (
    "id" TEXT NOT NULL,
    "paperId" TEXT NOT NULL,
    "forumId" TEXT NOT NULL,
    "noteId" TEXT NOT NULL,
    "parentNoteId" TEXT,
    "noteType" TEXT NOT NULL,
    "invitation" TEXT,
    "title" TEXT,
    "summary" TEXT,
    "strengths" TEXT,
    "weaknesses" TEXT,
    "questions" TEXT,
    "comment" TEXT,
    "details" TEXT,
    "decision" TEXT,
    "soundness" TEXT,
    "presentation" TEXT,
    "contribution" TEXT,
    "ratingText" TEXT,
    "confidenceText" TEXT,
    "ratingScore" DOUBLE PRECISION,
    "confidenceScore" DOUBLE PRECISION,
    "url" TEXT,
    "readers" JSONB,
    "signatures" JSONB,
    "rawContent" JSONB,
    "createdAtRemote" TIMESTAMP(3),
    "updatedAtRemote" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OpenReviewNote_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "OpenReviewNote_paperId_noteId_key" ON "OpenReviewNote"("paperId", "noteId");
CREATE INDEX "OpenReviewNote_paperId_idx" ON "OpenReviewNote"("paperId");
CREATE INDEX "OpenReviewNote_forumId_idx" ON "OpenReviewNote"("forumId");
CREATE INDEX "OpenReviewNote_noteType_idx" ON "OpenReviewNote"("noteType");
CREATE INDEX "OpenReviewNote_createdAtRemote_idx" ON "OpenReviewNote"("createdAtRemote");

ALTER TABLE "OpenReviewNote"
ADD CONSTRAINT "OpenReviewNote_paperId_fkey"
FOREIGN KEY ("paperId")
REFERENCES "Paper"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
