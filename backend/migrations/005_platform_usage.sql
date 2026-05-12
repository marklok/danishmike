-- Platform-sponsored message budget.
-- Tracks how many messages each user has consumed using the platform Anthropic key
-- (i.e. when they have no API key of their own).
--
-- Row per (user, month). month is stored as 'YYYY-MM' (7 chars).

CREATE TABLE IF NOT EXISTS platform_usage (
    user_id     uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
    month       char(7)     NOT NULL,  -- 'YYYY-MM'
    message_count integer   NOT NULL DEFAULT 0,
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, month)
);

-- Row-level security: users can only read their own row (writes go through the
-- service-role RPC below, which bypasses RLS).
ALTER TABLE platform_usage ENABLE ROW LEVEL SECURITY;

CREATE POLICY "users_read_own_usage" ON platform_usage
    FOR SELECT USING (auth.uid() = user_id);

-- RPC used by the backend (service role) to atomically upsert the counter.
-- Returns the NEW message_count after the increment.
CREATE OR REPLACE FUNCTION increment_platform_usage(
    p_user_id uuid,
    p_month   char(7)
)
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    new_count integer;
BEGIN
    INSERT INTO platform_usage (user_id, month, message_count, updated_at)
    VALUES (p_user_id, p_month, 1, now())
    ON CONFLICT (user_id, month) DO UPDATE
        SET message_count = platform_usage.message_count + 1,
            updated_at    = now()
    RETURNING message_count INTO new_count;

    RETURN new_count;
END;
$$;
