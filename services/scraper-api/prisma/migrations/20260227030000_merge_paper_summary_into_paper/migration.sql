ALTER TABLE "Paper"
ADD COLUMN IF NOT EXISTS "summaryModel" TEXT,
ADD COLUMN IF NOT EXISTS "summaryPromptVersion" TEXT,
ADD COLUMN IF NOT EXISTS "summaryPromptText" TEXT,
ADD COLUMN IF NOT EXISTS "summarySource" JSONB,
ADD COLUMN IF NOT EXISTS "summaryMd" TEXT,
ADD COLUMN IF NOT EXISTS "keyPoints" JSONB;

UPDATE "Paper" p
SET
  "summaryModel" = s."model",
  "summaryPromptVersion" = s."promptVersion",
  "summaryPromptText" = s."promptText",
  "summarySource" = s."summarySource",
  "summaryMd" = s."summaryMd",
  "keyPoints" = s."keyPoints"
FROM (
  SELECT DISTINCT ON ("paperId")
    "paperId",
    "model",
    "promptVersion",
    "promptText",
    "summarySource",
    "summaryMd",
    "keyPoints",
    "createdAt"
  FROM "PaperSummary"
  ORDER BY "paperId", "createdAt" DESC
) s
WHERE p."id" = s."paperId";

DROP TABLE IF EXISTS "PaperSummary";
