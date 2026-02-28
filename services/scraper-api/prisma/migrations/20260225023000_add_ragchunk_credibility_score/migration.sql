ALTER TABLE "RagChunk"
ADD COLUMN "credibilityScore" DOUBLE PRECISION;

CREATE INDEX "RagChunk_credibilityScore_idx" ON "RagChunk"("credibilityScore");
