DO $$
BEGIN
  IF to_regclass('public."User"') IS NOT NULL AND to_regclass('public.user_account') IS NULL THEN
    ALTER TABLE "User" RENAME TO "user_account";
  END IF;

  IF to_regclass('public."EmailVerificationCode"') IS NOT NULL AND to_regclass('public.user_email_verification_code') IS NULL THEN
    ALTER TABLE "EmailVerificationCode" RENAME TO "user_email_verification_code";
  END IF;

  IF to_regclass('public."PasswordResetToken"') IS NOT NULL AND to_regclass('public.user_password_reset_token') IS NULL THEN
    ALTER TABLE "PasswordResetToken" RENAME TO "user_password_reset_token";
  END IF;

  IF to_regclass('public."Paper"') IS NOT NULL AND to_regclass('public.paper_paper') IS NULL THEN
    ALTER TABLE "Paper" RENAME TO "paper_paper";
  END IF;

  IF to_regclass('public."OpenReviewNote"') IS NOT NULL AND to_regclass('public.paper_openreview_note') IS NULL THEN
    ALTER TABLE "OpenReviewNote" RENAME TO "paper_openreview_note";
  END IF;

  IF to_regclass('public."SemanticScholarCitation"') IS NOT NULL AND to_regclass('public.paper_semantic_scholar_citation') IS NULL THEN
    ALTER TABLE "SemanticScholarCitation" RENAME TO "paper_semantic_scholar_citation";
  END IF;

  IF to_regclass('public."PaperNote"') IS NOT NULL AND to_regclass('public.user_paper_note') IS NULL THEN
    ALTER TABLE "PaperNote" RENAME TO "user_paper_note";
  END IF;

  IF to_regclass('public."Search"') IS NOT NULL AND to_regclass('public.paper_search') IS NULL THEN
    ALTER TABLE "Search" RENAME TO "paper_search";
  END IF;

  IF to_regclass('public."SearchResult"') IS NOT NULL AND to_regclass('public.paper_search_result') IS NULL THEN
    ALTER TABLE "SearchResult" RENAME TO "paper_search_result";
  END IF;

  IF to_regclass('public."RedditPost"') IS NOT NULL AND to_regclass('public.paper_reddit_post') IS NULL THEN
    ALTER TABLE "RedditPost" RENAME TO "paper_reddit_post";
  END IF;

  IF to_regclass('public."PaperRedditLink"') IS NOT NULL AND to_regclass('public.paper_reddit_link') IS NULL THEN
    ALTER TABLE "PaperRedditLink" RENAME TO "paper_reddit_link";
  END IF;

  IF to_regclass('public."RagChunk"') IS NOT NULL AND to_regclass('public.rag_chunk') IS NULL THEN
    ALTER TABLE "RagChunk" RENAME TO "rag_chunk";
  END IF;

  IF to_regclass('public."PaperHighlight"') IS NOT NULL AND to_regclass('public.user_paper_highlight') IS NULL THEN
    ALTER TABLE "PaperHighlight" RENAME TO "user_paper_highlight";
  END IF;
END $$;
