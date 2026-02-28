CREATE TABLE "PaperHighlight" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "paperId" TEXT,
    "source" TEXT,
    "externalId" TEXT,
    "pdfUrl" TEXT,
    "quote" TEXT NOT NULL,
    "note" TEXT,
    "color" TEXT DEFAULT '#ffe066',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PaperHighlight_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "PaperHighlight_userId_idx" ON "PaperHighlight"("userId");
CREATE INDEX "PaperHighlight_paperId_idx" ON "PaperHighlight"("paperId");
CREATE INDEX "PaperHighlight_userId_source_externalId_idx"
ON "PaperHighlight"("userId", "source", "externalId");

ALTER TABLE "PaperHighlight"
ADD CONSTRAINT "PaperHighlight_userId_fkey"
FOREIGN KEY ("userId")
REFERENCES "User"("id")
ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "PaperHighlight"
ADD CONSTRAINT "PaperHighlight_paperId_fkey"
FOREIGN KEY ("paperId")
REFERENCES "Paper"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
