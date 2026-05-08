"use client";

import React, {
    createContext,
    useContext,
    useEffect,
    useState,
    ReactNode,
    useCallback,
} from "react";
import { supabase } from "@/lib/supabase";
import { useAuth } from "@/contexts/AuthContext";

interface UserProfile {
    displayName: string | null;
    organisation: string | null;
    messageCreditsUsed: number;
    creditsResetDate: string;
    creditsRemaining: number;
    tier: string;
    tabularModel: string;
    claudeApiKey: string | null;
    geminiApiKey: string | null;
}

interface UserProfileContextType {
    profile: UserProfile | null;
    loading: boolean;
    updateDisplayName: (name: string) => Promise<boolean>;
    updateOrganisation: (organisation: string) => Promise<boolean>;
    updateModelPreference: (
        field: "tabularModel",
        value: string,
    ) => Promise<boolean>;
    updateApiKey: (
        provider: "claude" | "gemini",
        value: string | null,
    ) => Promise<boolean>;
    reloadProfile: () => Promise<void>;
    incrementMessageCredits: () => Promise<boolean>;
}

const UserProfileContext = createContext<UserProfileContextType | undefined>(
    undefined,
);

const API_BASE =
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://localhost:3001";
const MONTHLY_CREDIT_LIMIT = 999999; // temporarily unlimited

async function getAccessToken(): Promise<string | null> {
    const {
        data: { session },
    } = await supabase.auth.getSession();
    return session?.access_token ?? null;
}

async function apiFetch(
    path: string,
    method: string,
    body?: Record<string, unknown>,
): Promise<{ ok: boolean; data?: Record<string, unknown> }> {
    const token = await getAccessToken();
    if (!token) return { ok: false };
    const res = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
            Authorization: `Bearer ${token}`,
            ...(body ? { "Content-Type": "application/json" } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!res.ok) return { ok: false };
    const data = await res.json();
    return { ok: true, data };
}

function mapProfileRow(data: Record<string, unknown>): UserProfile {
    let creditsUsed = (data.message_credits_used as number) ?? 0;
    let resetDate = (data.credits_reset_date as string) ?? "";
    let creditsRemaining = MONTHLY_CREDIT_LIMIT - creditsUsed;

    if (resetDate && new Date() > new Date(resetDate)) {
        const newResetDate = new Date();
        newResetDate.setDate(newResetDate.getDate() + 30);
        resetDate = newResetDate.toISOString();
        creditsUsed = 0;
        creditsRemaining = MONTHLY_CREDIT_LIMIT;
    }

    return {
        displayName: (data.display_name as string) ?? null,
        organisation: (data.organisation as string) ?? null,
        messageCreditsUsed: creditsUsed,
        creditsResetDate: resetDate,
        creditsRemaining,
        tier: (data.tier as string) || "Free",
        tabularModel:
            (data.tabular_model as string) || "gemini-3-flash-preview",
        claudeApiKey: (data.claude_api_key as string) ?? null,
        geminiApiKey: (data.gemini_api_key as string) ?? null,
    };
}

function fallbackProfile(): UserProfile {
    const futureResetDate = new Date();
    futureResetDate.setDate(futureResetDate.getDate() + 30);
    return {
        displayName: null,
        organisation: null,
        messageCreditsUsed: 0,
        creditsResetDate: futureResetDate.toISOString(),
        creditsRemaining: MONTHLY_CREDIT_LIMIT,
        tier: "Free",
        tabularModel: "gemini-3-flash-preview",
        claudeApiKey: null,
        geminiApiKey: null,
    };
}

export function UserProfileProvider({ children }: { children: ReactNode }) {
    const { user, isAuthenticated } = useAuth();
    const [profile, setProfile] = useState<UserProfile | null>(null);
    const [loading, setLoading] = useState(true);

    const loadProfile = useCallback(async () => {
        try {
            const result = await apiFetch("/user/profile", "GET");
            if (result.ok && result.data) {
                const mapped = mapProfileRow(result.data);

                // Reset credits in background if expired
                if (
                    mapped.messageCreditsUsed === 0 &&
                    result.data.message_credits_used !== 0
                ) {
                    apiFetch("/user/profile", "PATCH", {
                        message_credits_used: 0,
                        credits_reset_date: mapped.creditsResetDate,
                    }).catch(() => {});
                }

                setProfile(mapped);
            } else {
                setProfile(fallbackProfile());
            }
        } catch {
            setProfile(fallbackProfile());
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => {
        if (isAuthenticated && user) {
            setLoading(true);
            loadProfile();
        } else {
            setProfile(null);
            setLoading(false);
        }
    }, [isAuthenticated, user, loadProfile]);

    const patchProfile = useCallback(
        async (
            dbFields: Record<string, unknown>,
            stateUpdate: Partial<UserProfile>,
        ): Promise<boolean> => {
            try {
                const result = await apiFetch(
                    "/user/profile",
                    "PATCH",
                    dbFields,
                );
                if (!result.ok) return false;
                setProfile((prev) =>
                    prev ? { ...prev, ...stateUpdate } : null,
                );
                return true;
            } catch {
                return false;
            }
        },
        [],
    );

    const updateDisplayName = useCallback(
        async (displayName: string): Promise<boolean> => {
            return patchProfile({ display_name: displayName }, { displayName });
        },
        [patchProfile],
    );

    const updateOrganisation = useCallback(
        async (organisation: string): Promise<boolean> => {
            return patchProfile({ organisation }, { organisation });
        },
        [patchProfile],
    );

    const updateModelPreference = useCallback(
        async (
            field: "tabularModel",
            value: string,
        ): Promise<boolean> => {
            const dbField = field === "tabularModel" ? "tabular_model" : "";
            if (!dbField) return false;
            return patchProfile({ [dbField]: value }, { [field]: value });
        },
        [patchProfile],
    );

    const updateApiKey = useCallback(
        async (
            provider: "claude" | "gemini",
            value: string | null,
        ): Promise<boolean> => {
            const dbField =
                provider === "claude" ? "claude_api_key" : "gemini_api_key";
            const stateField =
                provider === "claude" ? "claudeApiKey" : "geminiApiKey";
            const normalized = value?.trim() ? value.trim() : null;
            return patchProfile(
                { [dbField]: normalized },
                { [stateField]: normalized },
            );
        },
        [patchProfile],
    );

    const reloadProfile = useCallback(async () => {
        await loadProfile();
    }, [loadProfile]);

    const incrementMessageCredits = useCallback(async (): Promise<boolean> => {
        if (!profile || profile.creditsRemaining <= 0) return false;
        const newCreditsUsed = profile.messageCreditsUsed + 1;
        return patchProfile(
            { message_credits_used: newCreditsUsed },
            {
                messageCreditsUsed: newCreditsUsed,
                creditsRemaining: MONTHLY_CREDIT_LIMIT - newCreditsUsed,
            },
        );
    }, [profile, patchProfile]);

    return (
        <UserProfileContext.Provider
            value={{
                profile,
                loading,
                updateDisplayName,
                updateOrganisation,
                updateModelPreference,
                updateApiKey,
                reloadProfile,
                incrementMessageCredits,
            }}
        >
            {children}
        </UserProfileContext.Provider>
    );
}

export function useUserProfile() {
    const context = useContext(UserProfileContext);
    if (context === undefined) {
        throw new Error(
            "useUserProfile must be used within a UserProfileProvider",
        );
    }
    return context;
}
