"use client";

import { useEffect, useRef } from "react";
import { X, ExternalLink } from "lucide-react";
import type { MikeCitationAnnotation } from "../shared/types";

interface Props {
    citation: MikeCitationAnnotation;
    onClose: () => void;
}

function isLawCitation(c: MikeCitationAnnotation): boolean {
    return c.doc_id === "retsinformation" || c.doc_id === "eurlex";
}

function lawSourceLabel(c: MikeCitationAnnotation): string {
    if (c.doc_id === "eurlex") return "EUR-Lex";
    return "Retsinformation";
}

function lawUrl(c: MikeCitationAnnotation): string | null {
    // Use the deep-link URL stored in the citation (from chunk metadata).
    // Fall back to the homepage if not available.
    if (c.url) return c.url;
    if (c.doc_id === "retsinformation") return "https://www.retsinformation.dk";
    if (c.doc_id === "eurlex") return "https://eur-lex.europa.eu";
    return null;
}

export { isLawCitation };

export function LawCitationPanel({ citation, onClose }: Props) {
    const panelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        const handleKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") onClose();
        };
        document.addEventListener("keydown", handleKeyDown);
        return () => document.removeEventListener("keydown", handleKeyDown);
    }, [onClose]);

    useEffect(() => {
        const handleClickOutside = (e: MouseEvent) => {
            if (
                panelRef.current &&
                !panelRef.current.contains(e.target as Node)
            ) {
                onClose();
            }
        };
        // Delay to avoid closing immediately from the click that opened it.
        const timer = setTimeout(() => {
            document.addEventListener("mousedown", handleClickOutside);
        }, 100);
        return () => {
            clearTimeout(timer);
            document.removeEventListener("mousedown", handleClickOutside);
        };
    }, [onClose]);

    const source = lawSourceLabel(citation);
    const url = lawUrl(citation);
    const quote = citation.quote || "";

    // Try to extract a section reference from the quote for the header.
    const sectionMatch = quote.match(
        /^(§\s*\d+[a-z]?(?:\s*,\s*[Ss]tk\.\s*\d+)?|Artikel\s+\d+)/,
    );
    const sectionLabel = sectionMatch ? sectionMatch[1] : null;

    return (
        <div className="fixed inset-0 z-50 flex justify-end">
            {/* Backdrop */}
            <div className="absolute inset-0 bg-black/20 transition-opacity" />

            {/* Panel */}
            <div
                ref={panelRef}
                className="relative w-full max-w-md bg-white shadow-xl border-l border-gray-200 flex flex-col animate-in slide-in-from-right duration-200"
            >
                {/* Header */}
                <div className="flex items-center justify-between px-5 py-4 border-b border-gray-200">
                    <div className="min-w-0">
                        <div className="flex items-center gap-2">
                            <span className="inline-flex items-center rounded-md bg-gray-100 px-2 py-0.5 text-[11px] font-medium text-gray-600 uppercase tracking-wider">
                                {source}
                            </span>
                        </div>
                        {sectionLabel && (
                            <h3 className="text-lg font-serif font-medium text-gray-900 mt-1 truncate">
                                {sectionLabel}
                            </h3>
                        )}
                    </div>
                    <button
                        onClick={onClose}
                        className="shrink-0 rounded-md p-1.5 text-gray-400 hover:text-gray-600 hover:bg-gray-100 transition-colors"
                        aria-label="Luk"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Body */}
                <div className="flex-1 overflow-y-auto px-5 py-4">
                    <p className="text-sm font-serif text-gray-800 leading-relaxed whitespace-pre-wrap">
                        {quote}
                    </p>
                </div>

                {/* Footer */}
                {url && (
                    <div className="border-t border-gray-200 px-5 py-3 flex items-center justify-between gap-4">
                        <a
                            href={url}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 text-sm text-blue-600 hover:text-blue-700 transition-colors"
                        >
                            <ExternalLink className="h-3.5 w-3.5" />
                            Åbn på {source}
                        </a>
                        {citation.synced_at && (
                            <span className="text-xs text-gray-400 shrink-0">
                                Synkroniseret{" "}
                                {new Date(citation.synced_at).toLocaleDateString("da-DK", {
                                    day: "numeric",
                                    month: "short",
                                    year: "numeric",
                                })}
                            </span>
                        )}
                    </div>
                )}
            </div>
        </div>
    );
}
