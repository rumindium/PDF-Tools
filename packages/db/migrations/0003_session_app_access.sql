-- 0003_session_app_access.sql — remember what the platform says a linked session may do.
--
-- Why these live on `sessions` rather than in a new table: an app role grant is a property of *this browser's link*
-- (the session row) and not of the account in the abstract. One person may be an admin in the session they are using
-- and hold nothing in another one, and the row that already names the account and expires is the row that has to stop
-- answering once it is gone. A second table keyed on `user_id` would outlive the sign-out.
--
-- Why a snapshot at all rather than asking per request: the only credential this app holds for the platform is the
-- shared-session cookie the browser sends (`services/app-access.ts`), and reading it on every request would put a
-- platform round trip in front of every job. The snapshot is refreshed on a TTL and, when the refresh fails, the last
-- known answer is kept — the same rule the anonymous switch mirror follows, for the same reason.
--
-- Nullable on purpose: `NULL` is "no snapshot yet" and is different from `'{}'`, which would mean "the platform
-- answered that this account holds nothing". The resolver treats only the first as a reason to ask.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS app_roles text[];
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS app_permissions text[];
ALTER TABLE sessions ADD COLUMN IF NOT EXISTS app_access_at timestamp with time zone;
