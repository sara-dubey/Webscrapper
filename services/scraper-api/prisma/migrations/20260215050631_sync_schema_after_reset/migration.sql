/*
  Warnings:

  - The `authors` column on the `Paper` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - The primary key for the `PaperRedditLink` table will be changed. If it partially fails, the table could be left without primary key constraint.
  - The `createdUtc` column on the `RedditPost` table would be dropped and recreated. This will lead to data loss if there is data in the column.
  - You are about to drop the column `redditPostId` on the `SearchResult` table. All the data in the column will be lost.
  - You are about to drop the column `ip` on the `Session` table. All the data in the column will be lost.
  - You are about to drop the column `refreshTokenHash` on the `Session` table. All the data in the column will be lost.
  - You are about to drop the column `userAgent` on the `Session` table. All the data in the column will be lost.
  - You are about to drop the column `name` on the `User` table. All the data in the column will be lost.
  - You are about to drop the column `passwordHash` on the `User` table. All the data in the column will be lost.
  - A unique constraint covering the columns `[searchId,redditPostId]` on the table `PaperRedditLink` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[searchId,paperId]` on the table `SearchResult` will be added. If there are existing duplicate values, this will fail.
  - A unique constraint covering the columns `[accessToken]` on the table `Session` will be added. If there are existing duplicate values, this will fail.
  - Made the column `url` on table `Paper` required. This step will fail if there are existing NULL values in that column.
  - The required column `id` was added to the `PaperRedditLink` table with a prisma-level default value. This is not possible if the table is not empty. Please add this column as optional, then populate it before making it required.
  - Added the required column `searchId` to the `PaperRedditLink` table without a default value. This is not possible if the table is not empty.
  - Made the column `subreddit` on table `RedditPost` required. This step will fail if there are existing NULL values in that column.
  - Made the column `paperId` on table `SearchResult` required. This step will fail if there are existing NULL values in that column.
  - Added the required column `accessToken` to the `Session` table without a default value. This is not possible if the table is not empty.
  - Added the required column `password` to the `User` table without a default value. This is not possible if the table is not empty.

*/
-- DropForeignKey
ALTER TABLE "SearchResult" DROP CONSTRAINT "SearchResult_paperId_fkey";

-- DropForeignKey
ALTER TABLE "SearchResult" DROP CONSTRAINT "SearchResult_redditPostId_fkey";

-- DropIndex
DROP INDEX "PaperNote_userId_paperId_key";

-- DropIndex
DROP INDEX "SearchResult_searchId_rank_key";

-- AlterTable
ALTER TABLE "Paper" ALTER COLUMN "url" SET NOT NULL,
DROP COLUMN "authors",
ADD COLUMN     "authors" TEXT[];

-- AlterTable
ALTER TABLE "PaperRedditLink" DROP CONSTRAINT "PaperRedditLink_pkey",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ADD COLUMN     "id" TEXT NOT NULL,
ADD COLUMN     "searchId" TEXT NOT NULL,
ADD CONSTRAINT "PaperRedditLink_pkey" PRIMARY KEY ("id");

-- AlterTable
ALTER TABLE "PaperSummary" ALTER COLUMN "summaryMd" DROP NOT NULL;

-- AlterTable
ALTER TABLE "RedditPost" ALTER COLUMN "subreddit" SET NOT NULL,
DROP COLUMN "createdUtc",
ADD COLUMN     "createdUtc" INTEGER;

-- AlterTable
ALTER TABLE "SearchResult" DROP COLUMN "redditPostId",
ADD COLUMN     "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "rank" DROP NOT NULL,
ALTER COLUMN "paperId" SET NOT NULL;

-- AlterTable
ALTER TABLE "Session" DROP COLUMN "ip",
DROP COLUMN "refreshTokenHash",
DROP COLUMN "userAgent",
ADD COLUMN     "accessToken" TEXT NOT NULL,
ALTER COLUMN "expiresAt" DROP NOT NULL;

-- AlterTable
ALTER TABLE "User" DROP COLUMN "name",
DROP COLUMN "passwordHash",
ADD COLUMN     "password" TEXT NOT NULL;

-- CreateIndex
CREATE INDEX "Paper_externalId_idx" ON "Paper"("externalId");

-- CreateIndex
CREATE INDEX "PaperNote_paperId_idx" ON "PaperNote"("paperId");

-- CreateIndex
CREATE INDEX "PaperNote_userId_idx" ON "PaperNote"("userId");

-- CreateIndex
CREATE INDEX "PaperRedditLink_searchId_idx" ON "PaperRedditLink"("searchId");

-- CreateIndex
CREATE INDEX "PaperRedditLink_paperId_idx" ON "PaperRedditLink"("paperId");

-- CreateIndex
CREATE INDEX "PaperRedditLink_redditPostId_idx" ON "PaperRedditLink"("redditPostId");

-- CreateIndex
CREATE UNIQUE INDEX "PaperRedditLink_searchId_redditPostId_key" ON "PaperRedditLink"("searchId", "redditPostId");

-- CreateIndex
CREATE INDEX "PaperSummary_paperId_idx" ON "PaperSummary"("paperId");

-- CreateIndex
CREATE INDEX "Search_userId_idx" ON "Search"("userId");

-- CreateIndex
CREATE INDEX "Search_query_idx" ON "Search"("query");

-- CreateIndex
CREATE INDEX "SearchResult_searchId_idx" ON "SearchResult"("searchId");

-- CreateIndex
CREATE INDEX "SearchResult_paperId_idx" ON "SearchResult"("paperId");

-- CreateIndex
CREATE UNIQUE INDEX "SearchResult_searchId_paperId_key" ON "SearchResult"("searchId", "paperId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_accessToken_key" ON "Session"("accessToken");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- AddForeignKey
ALTER TABLE "SearchResult" ADD CONSTRAINT "SearchResult_paperId_fkey" FOREIGN KEY ("paperId") REFERENCES "Paper"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PaperRedditLink" ADD CONSTRAINT "PaperRedditLink_searchId_fkey" FOREIGN KEY ("searchId") REFERENCES "Search"("id") ON DELETE CASCADE ON UPDATE CASCADE;
