import crypto from "crypto";
import { createServerSupabase } from "./supabase";
import type { UserApiKeys } from "./llm";

type Db = ReturnType<typeof createServerSupabase>;
export type ApiKeyProvider = "claude" | "gemini" | "openai" | "openai_embeddings";
export type ApiKeySource = "user" | "env" | null;
export type ApiKeyStatus = Record<ApiKeyProvider, boolean> & {
    sources: Record<ApiKeyProvider, ApiKeySource>;
};

type EncryptedKeyRow = {
    provider: ApiKeyProvider;
    encrypted_key: string;
    iv: string;
    auth_tag: string;
};

// Chat providers — used for model selection and chat completions.
const PROVIDERS: ApiKeyProvider[] = ["claude", "gemini", "openai"];
// All storable providers including non-chat ones.
const ALL_PROVIDERS: ApiKeyProvider[] = ["claude", "gemini", "openai", "openai_embeddings"];

function envApiKey(provider: ApiKeyProvider): string | null {
    if (provider === "claude") {
        return (
            process.env.ANTHROPIC_API_KEY?.trim() ||
            process.env.CLAUDE_API_KEY?.trim() ||
            null
        );
    }
    if (provider === "openai") {
        return process.env.OPENAI_API_KEY?.trim() || null;
    }
    return process.env.GEMINI_API_KEY?.trim() || null;
}

export function hasEnvApiKey(provider: ApiKeyProvider): boolean {
    return !!envApiKey(provider);
}

function encryptionKey(): Buffer {
    const secret =
        process.env.USER_API_KEYS_ENCRYPTION_SECRET ||
        process.env.API_KEYS_ENCRYPTION_SECRET ||
        process.env.SUPABASE_SECRET_KEY;
    if (!secret) {
        throw new Error("API key encryption secret is not configured");
    }
    return crypto.createHash("sha256").update(secret).digest();
}

function encrypt(value: string): Omit<EncryptedKeyRow, "provider"> {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
    const encrypted = Buffer.concat([
        cipher.update(value, "utf8"),
        cipher.final(),
    ]);
    return {
        encrypted_key: encrypted.toString("base64"),
        iv: iv.toString("base64"),
        auth_tag: cipher.getAuthTag().toString("base64"),
    };
}

function decrypt(row: EncryptedKeyRow): string | null {
    try {
        const decipher = crypto.createDecipheriv(
            "aes-256-gcm",
            encryptionKey(),
            Buffer.from(row.iv, "base64"),
        );
        decipher.setAuthTag(Buffer.from(row.auth_tag, "base64"));
        const decrypted = Buffer.concat([
            decipher.update(Buffer.from(row.encrypted_key, "base64")),
            decipher.final(),
        ]);
        return decrypted.toString("utf8");
    } catch (err) {
        console.error("[user-api-keys] failed to decrypt stored key", {
            provider: row.provider,
            error: err instanceof Error ? err.message : String(err),
        });
        return null;
    }
}

function isProvider(value: string): value is ApiKeyProvider {
    return (ALL_PROVIDERS as string[]).includes(value);
}

export function normalizeApiKeyProvider(value: string): ApiKeyProvider | null {
    return isProvider(value) ? value : null;
}

export async function getUserApiKeyStatus(
    userId: string,
    db: Db = createServerSupabase(),
): Promise<ApiKeyStatus> {
    const status: ApiKeyStatus = {
        claude: false,
        gemini: false,
        openai: false,
        openai_embeddings: false,
        sources: {
            claude: null,
            gemini: null,
            openai: null,
            openai_embeddings: null,
        },
    };

    for (const provider of PROVIDERS) {
        if (hasEnvApiKey(provider)) {
            status[provider] = true;
            status.sources[provider] = "env";
        }
    }

    // openai_embeddings can also fall back to the server OPENAI_API_KEY
    if (process.env.OPENAI_API_KEY?.trim()) {
        status.openai_embeddings = true;
        status.sources.openai_embeddings = "env";
    }

    const { data, error } = await db
        .from("user_api_keys")
        .select("provider")
        .eq("user_id", userId);
    if (error) throw error;

    for (const row of data ?? []) {
        const provider = normalizeApiKeyProvider(String(row.provider));
        if (provider && !status[provider]) {
            status[provider] = true;
            status.sources[provider] = "user";
        }
    }

    return status;
}

export async function getUserEmbeddingsKey(
    userId: string,
    db: Db = createServerSupabase(),
): Promise<string | null> {
    // Prefer user-stored key, fall back to server env var.
    const { data, error } = await db
        .from("user_api_keys")
        .select("provider, encrypted_key, iv, auth_tag")
        .eq("user_id", userId)
        .eq("provider", "openai_embeddings")
        .maybeSingle();
    if (!error && data) {
        return decrypt(data as EncryptedKeyRow);
    }
    return process.env.OPENAI_API_KEY?.trim() || null;
}

export async function getUserApiKeys(
    userId: string,
    db: Db = createServerSupabase(),
): Promise<UserApiKeys> {
    const apiKeys: UserApiKeys = {
        claude: envApiKey("claude"),
        gemini: envApiKey("gemini"),
        openai: envApiKey("openai"),
    };

    const { data, error } = await db
        .from("user_api_keys")
        .select("provider, encrypted_key, iv, auth_tag")
        .eq("user_id", userId);
    if (error) throw error;

    for (const row of (data ?? []) as EncryptedKeyRow[]) {
        const provider = normalizeApiKeyProvider(row.provider);
        // Only populate chat providers — openai_embeddings is not a chat key.
        if (!provider || !(PROVIDERS as string[]).includes(provider)) continue;
        if (apiKeys[provider as keyof UserApiKeys]?.trim()) continue;
        apiKeys[provider as keyof UserApiKeys] = decrypt(row);
    }

    return apiKeys;
}

export async function saveUserApiKey(
    userId: string,
    provider: ApiKeyProvider,
    value: string | null,
    db: Db = createServerSupabase(),
): Promise<void> {
    const normalized = value?.trim() || null;
    if (!normalized) {
        const { error } = await db
            .from("user_api_keys")
            .delete()
            .eq("user_id", userId)
            .eq("provider", provider);
        if (error) throw error;
        return;
    }

    const { error } = await db.from("user_api_keys").upsert(
        {
            user_id: userId,
            provider,
            ...encrypt(normalized),
            updated_at: new Date().toISOString(),
        },
        { onConflict: "user_id,provider" },
    );
    if (error) throw error;
}
