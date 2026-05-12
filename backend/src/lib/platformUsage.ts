/**
 * Platform-sponsored message budget.
 *
 * Users who haven't added their own Anthropic API key get a fixed number of
 * free messages per calendar month, funded by the platform key.
 *
 * Env vars:
 *   ANTHROPIC_API_KEY        — platform Anthropic key (already used by default)
 *   PLATFORM_MESSAGE_LIMIT   — messages per user per month (default: 30)
 */

import type { SupabaseClient } from "@supabase/supabase-js";

export const PLATFORM_LIMIT = parseInt(
    process.env.PLATFORM_MESSAGE_LIMIT ?? "30",
    10,
);

/** Current month as 'YYYY-MM'. */
export function currentMonth(): string {
    return new Date().toISOString().slice(0, 7);
}

/** How many platform messages this user has used this month (0 if none). */
export async function getPlatformUsage(
    userId: string,
    db: SupabaseClient,
): Promise<number> {
    const { data, error } = await db
        .from("platform_usage")
        .select("message_count")
        .eq("user_id", userId)
        .eq("month", currentMonth())
        .maybeSingle();

    if (error) {
        console.error("[platformUsage] read error:", error.message);
        return 0;
    }
    return (data as { message_count: number } | null)?.message_count ?? 0;
}

/**
 * Atomically increment the counter for this user/month.
 * Returns the new count after increment.
 */
export async function incrementPlatformUsage(
    userId: string,
    db: SupabaseClient,
): Promise<number> {
    const { data, error } = await db.rpc("increment_platform_usage", {
        p_user_id: userId,
        p_month: currentMonth(),
    });

    if (error) {
        console.error("[platformUsage] increment error:", error.message);
        return 0;
    }
    return (data as number) ?? 0;
}

/**
 * Returns an effective claude API key for this request.
 *
 * `userHasOwnKey` must be true only when the user has a Claude key stored in
 * their own account (sources.claude === "user" from getUserApiKeyStatus).
 * Do NOT pass the env/platform key here — getUserApiKeys seeds every slot with
 * the env value, so apiKeys.claude is always truthy even for free-tier users.
 *
 *  - userHasOwnKey=true  → use apiKeys.claude as-is, no budget tracking.
 *  - userHasOwnKey=false → inject platform ANTHROPIC_API_KEY, check monthly limit.
 *  - returns null         → over limit / platform key not configured → caller sends 402.
 */
export async function resolveClaudeKey(
    userHasOwnKey: boolean,
    userId: string,
    db: SupabaseClient,
    userKey: string | null | undefined,
): Promise<{ key: string; usingPlatform: boolean } | null> {
    if (userHasOwnKey && userKey) {
        return { key: userKey, usingPlatform: false };
    }

    const platformKey = process.env.ANTHROPIC_API_KEY;
    if (!platformKey) {
        return null;
    }

    const used = await getPlatformUsage(userId, db);
    if (used >= PLATFORM_LIMIT) {
        return null; // over limit
    }

    return { key: platformKey, usingPlatform: true };
}
