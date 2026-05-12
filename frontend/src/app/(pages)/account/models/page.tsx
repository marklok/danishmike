"use client";

import { useEffect, useState } from "react";
import { AlertCircle, Check, ChevronDown, Eye, EyeOff } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuLabel,
    DropdownMenuSeparator,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useUserProfile } from "@/contexts/UserProfileContext";
import type { ApiKeyState } from "@/app/lib/mikeApi";
import { getPlatformUsage, type PlatformUsage } from "@/app/lib/mikeApi";
import { MODELS } from "@/app/components/assistant/ModelToggle";
import {
    isModelAvailable,
    modelGroupToProvider,
    providerLabel,
} from "@/app/lib/modelAvailability";

export default function ModelsAndApiKeysPage() {
    const { profile, updateModelPreference, updateApiKey } = useUserProfile();
    const [platformUsage, setPlatformUsage] = useState<PlatformUsage | null>(null);

    useEffect(() => {
        getPlatformUsage().then(setPlatformUsage).catch(() => {});
    }, []);

    const claudeSource = profile?.apiKeys["claude"]?.source;
    const hasOwnClaudeKey = claudeSource === "user";
    const usingPlatformKey = claudeSource === "env" && !hasOwnClaudeKey;
    const creditsRemaining = platformUsage?.remaining ?? null;
    const creditsExhausted = creditsRemaining !== null && creditsRemaining <= 0;

    return (
        <div className="space-y-4">
            {/* API Keys */}
            <div className="pb-6">
                <div className="flex items-center gap-2 mb-2">
                    <h2 className="text-2xl font-medium font-serif">
                        API-nøgle
                    </h2>
                </div>
                <p className="text-sm text-gray-500 mb-6 max-w-xl">
                    Mike bruger Anthropic's Claude til at analysere dokumenter
                    og besvare juridiske spørgsmål.
                </p>

                <div className="max-w-xl">
                    <ApiKeyField
                        label="Anthropic (Claude) API-nøgle"
                        placeholder="sk-ant-…"
                        hasSavedKey={!!profile?.apiKeys["claude"]?.configured}
                        locked={usingPlatformKey && !creditsExhausted}
                        lockedMessage={
                            creditsRemaining !== null
                                ? `Du har ${creditsRemaining} gratis ${creditsRemaining === 1 ? "besked" : "beskeder"} tilbage denne måned. Du kan tilføje din egen API-nøgle her, når de er brugt.`
                                : "Du har gratis beskeder inkluderet. Du kan tilføje din egen API-nøgle her, når de er brugt."
                        }
                        unlockedMessage={
                            creditsExhausted
                                ? "Dine gratis beskeder er brugt op. Tilføj din Anthropic API-nøgle nedenfor for at fortsætte."
                                : undefined
                        }
                        onSave={(value) =>
                            updateApiKey("claude", value.trim() || null)
                        }
                        onRemove={() => updateApiKey("claude", null)}
                    />
                </div>
            </div>

            {/* Advanced — only show when user has own key or is a power user */}
            {hasOwnClaudeKey && (
                <div className="py-6 border-t border-gray-100 space-y-6">
                    <div>
                        <h2 className="text-2xl font-medium font-serif mb-2">
                            Avancerede indstillinger
                        </h2>
                        <p className="text-sm text-gray-500 mb-6 max-w-xl">
                            Tilføj nøgler til andre AI-udbydere og tilpas
                            modelvalg.
                        </p>
                    </div>

                    {/* Other providers */}
                    <div className="space-y-4 max-w-xl">
                        <ApiKeyField
                            label="Google (Gemini) API-nøgle"
                            placeholder="AI…"
                            hasSavedKey={!!profile?.apiKeys["gemini"]?.configured}
                            locked={profile?.apiKeys["gemini"]?.source === "env"}
                            onSave={(value) =>
                                updateApiKey("gemini", value.trim() || null)
                            }
                            onRemove={() => updateApiKey("gemini", null)}
                        />
                        <ApiKeyField
                            label="OpenAI API-nøgle"
                            placeholder="sk-…"
                            hasSavedKey={!!profile?.apiKeys["openai"]?.configured}
                            locked={profile?.apiKeys["openai"]?.source === "env"}
                            onSave={(value) =>
                                updateApiKey("openai", value.trim() || null)
                            }
                            onRemove={() => updateApiKey("openai", null)}
                        />
                    </div>

                    {/* Model preferences */}
                    <div className="max-w-md">
                        <label className="text-sm text-gray-600 block mb-1">
                            Model til tabelgennemgang
                        </label>
                        <p className="text-xs text-gray-400 mb-2">
                            Vi anbefaler en mindre model til tabelgennemgang for
                            at reducere omkostninger.
                        </p>
                        <TabularModelDropdown
                            value={
                                profile?.tabularModel ?? "claude-sonnet-4-6"
                            }
                            apiKeys={profile?.apiKeys}
                            onChange={(id) =>
                                updateModelPreference("tabularModel", id)
                            }
                        />
                    </div>
                </div>
            )}
        </div>
    );
}

function TabularModelDropdown({
    value,
    onChange,
    apiKeys,
}: {
    value: string;
    onChange: (id: string) => void;
    apiKeys?: ApiKeyState;
}) {
    const [isOpen, setIsOpen] = useState(false);
    const selected = MODELS.find((m) => m.id === value);
    const selectedAvailable = apiKeys ? isModelAvailable(value, apiKeys) : true;
    const groups: ("Anthropic" | "Google" | "OpenAI")[] = [
        "Anthropic",
        "Google",
        "OpenAI",
    ];

    return (
        <DropdownMenu onOpenChange={setIsOpen}>
            <DropdownMenuTrigger asChild>
                <button
                    type="button"
                    className="w-full h-9 rounded-md border border-gray-300 bg-white px-3 text-sm shadow-sm flex items-center justify-between gap-2 hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-black/10"
                >
                    <span className="flex items-center gap-2 min-w-0">
                        {!selectedAvailable && (
                            <AlertCircle className="h-3.5 w-3.5 shrink-0 text-red-500" />
                        )}
                        <span className="truncate text-gray-900">
                            {selected?.label ?? "Select a model"}
                        </span>
                    </span>
                    <ChevronDown
                        className={`h-3.5 w-3.5 shrink-0 text-gray-500 transition-transform duration-200 ${isOpen ? "rotate-180" : ""}`}
                    />
                </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
                className="z-50"
                style={{ width: "var(--radix-dropdown-menu-trigger-width)" }}
                align="start"
            >
                {groups.map((group, gi) => {
                    const items = MODELS.filter((m) => m.group === group);
                    if (items.length === 0) return null;
                    return (
                        <div key={group}>
                            {gi > 0 && <DropdownMenuSeparator />}
                            <DropdownMenuLabel className="text-[10px] uppercase tracking-wider text-gray-400">
                                {group}
                            </DropdownMenuLabel>
                            {items.map((m) => {
                                const provider = modelGroupToProvider(m.group);
                                const available = apiKeys
                                    ? isModelAvailable(m.id, apiKeys)
                                    : true;
                                return (
                                    <DropdownMenuItem
                                        key={m.id}
                                        className="cursor-pointer"
                                        onSelect={() => onChange(m.id)}
                                        title={
                                            !available
                                                ? `Add a ${providerLabel(provider)} API key to use this model`
                                                : undefined
                                        }
                                    >
                                        <span
                                            className={`flex-1 ${available ? "" : "text-gray-400"}`}
                                        >
                                            {m.label}
                                        </span>
                                        {!available && (
                                            <AlertCircle className="h-3.5 w-3.5 text-red-500 ml-1" />
                                        )}
                                        {m.id === value && available && (
                                            <Check className="h-3.5 w-3.5 text-gray-600 ml-1" />
                                        )}
                                    </DropdownMenuItem>
                                );
                            })}
                        </div>
                    );
                })}
            </DropdownMenuContent>
        </DropdownMenu>
    );
}

function ApiKeyField({
    label,
    placeholder,
    hasSavedKey,
    locked = false,
    lockedMessage,
    unlockedMessage,
    onSave,
    onRemove,
}: {
    label: string;
    placeholder: string;
    hasSavedKey: boolean;
    /** When true, the input is disabled and lockedMessage is shown. */
    locked?: boolean;
    /** Message shown in the info box while locked. */
    lockedMessage?: string;
    /** Message shown above the input when unlocked (e.g. credits exhausted). */
    unlockedMessage?: string;
    onSave: (value: string) => Promise<boolean>;
    onRemove: () => Promise<boolean>;
}) {
    const [value, setValue] = useState("");
    const [reveal, setReveal] = useState(false);
    const [isSaving, setIsSaving] = useState(false);
    const [saved, setSaved] = useState(false);

    useEffect(() => {
        setValue("");
    }, [hasSavedKey]);

    const dirty = value.trim().length > 0;

    const handleSave = async () => {
        setIsSaving(true);
        const ok = await onSave(value);
        setIsSaving(false);
        if (ok) {
            setValue("");
            setSaved(true);
            setTimeout(() => setSaved(false), 2000);
        } else {
            alert(`Kunne ikke gemme ${label}.`);
        }
    };

    const handleRemove = async () => {
        setIsSaving(true);
        const ok = await onRemove();
        setIsSaving(false);
        if (!ok) alert(`Kunne ikke fjerne ${label}.`);
    };

    return (
        <div>
            <label className="text-sm text-gray-600 block mb-2">{label}</label>

            {/* Locked state: show info message, hide input */}
            {locked && lockedMessage && (
                <div className="rounded-md border border-gray-100 bg-gray-50 px-3 py-2.5">
                    <p className="text-sm text-gray-600">{lockedMessage}</p>
                </div>
            )}

            {/* Unlocked with a notice (e.g. credits exhausted) */}
            {!locked && unlockedMessage && (
                <div className="mb-3 rounded-md border border-amber-100 bg-amber-50 px-3 py-2.5">
                    <p className="text-sm text-amber-800">{unlockedMessage}</p>
                </div>
            )}

            {/* Input — only shown when not locked */}
            {!locked && (
                <>
                    {hasSavedKey && (
                        <p className="text-xs text-gray-500 mb-2">
                            En nøgle er gemt. Indsæt en ny for at erstatte den.
                        </p>
                    )}
                    <div className="flex gap-2">
                        <div className="relative flex-1">
                            <Input
                                type={reveal ? "text" : "password"}
                                value={value}
                                onChange={(e) => setValue(e.target.value)}
                                placeholder={
                                    hasSavedKey ? "Gemt nøgle skjult" : placeholder
                                }
                                className="pr-10"
                                autoComplete="off"
                                spellCheck={false}
                            />
                            <button
                                type="button"
                                onClick={() => setReveal((r) => !r)}
                                className="absolute inset-y-0 right-2 flex items-center text-gray-400 hover:text-gray-600"
                                aria-label={reveal ? "Skjul nøgle" : "Vis nøgle"}
                            >
                                {reveal ? (
                                    <EyeOff className="h-4 w-4" />
                                ) : (
                                    <Eye className="h-4 w-4" />
                                )}
                            </button>
                        </div>
                        <Button
                            onClick={handleSave}
                            disabled={isSaving || !dirty || saved}
                            className="min-w-[80px] transition-all bg-black hover:bg-gray-900 text-white"
                        >
                            {isSaving ? (
                                "Gemmer..."
                            ) : saved ? (
                                <>
                                    <Check className="h-4 w-3" />
                                    Gemt
                                </>
                            ) : (
                                "Gem"
                            )}
                        </Button>
                        {hasSavedKey && (
                            <Button
                                type="button"
                                variant="outline"
                                onClick={handleRemove}
                                disabled={isSaving}
                            >
                                Fjern
                            </Button>
                        )}
                    </div>
                </>
            )}
        </div>
    );
}
