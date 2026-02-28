DO $$
BEGIN
  IF to_regclass('public.paper_search') IS NOT NULL AND to_regclass('public.user_search') IS NULL THEN
    ALTER TABLE "paper_search" RENAME TO "user_search";
  END IF;

  IF to_regclass('public.paper_search_result') IS NOT NULL AND to_regclass('public.user_search_result') IS NULL THEN
    ALTER TABLE "paper_search_result" RENAME TO "user_search_result";
  END IF;
END $$;
