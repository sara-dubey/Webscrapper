ALTER TABLE "Paper"
ADD COLUMN IF NOT EXISTS "topic" TEXT;

CREATE TABLE IF NOT EXISTS "Collection" (
  "id" TEXT NOT NULL,
  "userId" TEXT NOT NULL,
  "name" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "Collection_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "Collection_userId_idx"
ON "Collection"("userId");

CREATE UNIQUE INDEX IF NOT EXISTS "Collection_userId_name_key"
ON "Collection"("userId", "name");

ALTER TABLE "Collection"
ADD CONSTRAINT "Collection_userId_fkey"
FOREIGN KEY ("userId")
REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE IF NOT EXISTS "PaperCollection" (
  "id" TEXT NOT NULL,
  "paperId" TEXT NOT NULL,
  "collectionId" TEXT NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "PaperCollection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "PaperCollection_paperId_collectionId_key"
ON "PaperCollection"("paperId", "collectionId");

CREATE INDEX IF NOT EXISTS "PaperCollection_paperId_idx"
ON "PaperCollection"("paperId");

CREATE INDEX IF NOT EXISTS "PaperCollection_collectionId_idx"
ON "PaperCollection"("collectionId");

ALTER TABLE "PaperCollection"
ADD CONSTRAINT "PaperCollection_paperId_fkey"
FOREIGN KEY ("paperId")
REFERENCES "Paper"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PaperCollection"
ADD CONSTRAINT "PaperCollection_collectionId_fkey"
FOREIGN KEY ("collectionId")
REFERENCES "Collection"("id")
ON DELETE CASCADE ON UPDATE CASCADE;
