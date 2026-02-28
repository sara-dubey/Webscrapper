CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE "RagChunk" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "searchId" TEXT,
    "paperId" TEXT,
    "redditPostId" TEXT,
    "sourceType" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "chunkIndex" INTEGER NOT NULL,
    "content" TEXT NOT NULL,
    "metadata" JSONB,
    "embeddingModel" TEXT,
    "embedding" vector,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RagChunk_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "RagChunk_userId_sourceType_sourceId_chunkIndex_key"
ON "RagChunk"("userId", "sourceType", "sourceId", "chunkIndex");

CREATE INDEX "RagChunk_userId_idx" ON "RagChunk"("userId");
CREATE INDEX "RagChunk_searchId_idx" ON "RagChunk"("searchId");
CREATE INDEX "RagChunk_paperId_idx" ON "RagChunk"("paperId");
CREATE INDEX "RagChunk_redditPostId_idx" ON "RagChunk"("redditPostId");

ALTER TABLE "RagChunk"
ADD CONSTRAINT "RagChunk_userId_fkey"
FOREIGN KEY ("userId")
REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RagChunk"
ADD CONSTRAINT "RagChunk_searchId_fkey"
FOREIGN KEY ("searchId")
REFERENCES "Search"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "RagChunk"
ADD CONSTRAINT "RagChunk_paperId_fkey"
FOREIGN KEY ("paperId")
REFERENCES "Paper"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "RagChunk"
ADD CONSTRAINT "RagChunk_redditPostId_fkey"
FOREIGN KEY ("redditPostId")
REFERENCES "RedditPost"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

DO $$
BEGIN
  CREATE INDEX IF NOT EXISTS "RagChunk_embedding_ivfflat_idx"
  ON "RagChunk"
  USING ivfflat ("embedding" vector_cosine_ops)
  WITH (lists = 100);
EXCEPTION
  WHEN undefined_object OR feature_not_supported OR invalid_parameter_value THEN
    NULL;
END $$;
