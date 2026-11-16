-- 0002_drop_ocr_pages_per_job.sql — remove a plan limit nothing ever read.
--
-- `plans.ocr_pages_per_job` was declared here, mirrored in `@pdftools/contracts/plans` and seeded, and no code read
-- it: not the API, not the worker. It was not needed either. `15-OCR.md` §6 bounds OCR by the plan's own page limit
-- — 500 for Free, 2 000 for Pro — and that is `plans.max_pages` from `16-ACCOUNTS-QUOTA-AND-HISTORY.md` §3, which
-- job creation already enforces.
--
-- Worse than redundant, it was misleading: the anonymous row said `0`, which reads as "anonymous gets no OCR"
-- while behaving as "unlimited", and a second page ceiling for one tool is a policy that can silently disagree
-- with the first.
--
-- Added as a new migration rather than by editing 0001: the runner only ever appends, so an already-migrated
-- database keeps an honest ledger and still loses the column.

ALTER TABLE plans DROP COLUMN IF EXISTS ocr_pages_per_job;
