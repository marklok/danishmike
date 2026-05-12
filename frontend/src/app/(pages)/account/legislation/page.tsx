"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Loader2, Search } from "lucide-react";
import { Input } from "@/components/ui/input";
import { getAvailableLegislation, type LegislationEntry } from "@/app/lib/mikeApi";

export default function LegislationPage() {
    const [laws, setLaws] = useState<LegislationEntry[]>([]);
    const [loading, setLoading] = useState(true);
    const [query, setQuery] = useState("");

    useEffect(() => {
        getAvailableLegislation()
            .then(setLaws)
            .catch(() => {})
            .finally(() => setLoading(false));
    }, []);

    const filtered = query.trim()
        ? laws.filter(
              (l) =>
                  l.law_title.toLowerCase().includes(query.toLowerCase()) ||
                  l.law_id.toLowerCase().includes(query.toLowerCase()) ||
                  l.canonical_citation.toLowerCase().includes(query.toLowerCase()),
          )
        : laws;

    return (
        <div className="space-y-4">
            <div className="pb-4">
                <h2 className="text-2xl font-medium font-serif mb-2">
                    Tilgængelig lovgivning
                </h2>
                <p className="text-sm text-gray-500 max-w-xl">
                    Mike har adgang til den fulde tekst af følgende danske love
                    direkte fra Retsinformation. Stil spørgsmål om specifikke
                    paragraffer, og Mike finder de relevante bestemmelser for dig.
                </p>
            </div>

            {loading ? (
                <div className="flex items-center gap-2 text-sm text-gray-400 py-8">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Henter lovgivning…
                </div>
            ) : (
                <>
                    {laws.length > 6 && (
                        <div className="relative max-w-sm mb-4">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400 pointer-events-none" />
                            <Input
                                value={query}
                                onChange={(e) => setQuery(e.target.value)}
                                placeholder="Søg i lovgivning…"
                                className="pl-9"
                            />
                        </div>
                    )}

                    {filtered.length === 0 ? (
                        <p className="text-sm text-gray-400 py-4">
                            {query ? "Ingen love matcher din søgning." : "Ingen love er indlæst endnu."}
                        </p>
                    ) : (
                        <div className="divide-y divide-gray-100 rounded-lg border border-gray-200 overflow-hidden">
                            {filtered.map((law) => (
                                <LawRow key={law.law_id} law={law} />
                            ))}
                        </div>
                    )}

                    {!loading && laws.length > 0 && (
                        <p className="text-xs text-gray-400 pt-2">
                            {laws.length} {laws.length === 1 ? "lov" : "love"} tilgængelige
                        </p>
                    )}
                </>
            )}
        </div>
    );
}

function LawRow({ law }: { law: LegislationEntry }) {
    const retsinformationUrl = `https://www.retsinformation.dk/eli/lta/${law.year}/${law.number}`;

    const syncedDate = law.synced_at
        ? new Date(law.synced_at).toLocaleDateString("da-DK", {
              day: "numeric",
              month: "short",
              year: "numeric",
          })
        : null;

    return (
        <div className="flex items-start justify-between gap-4 px-4 py-3 bg-white hover:bg-gray-50 transition-colors">
            <div className="min-w-0">
                <p className="text-sm font-medium text-gray-900 leading-snug">
                    {law.law_title}
                </p>
                <p className="text-xs text-gray-400 mt-0.5">
                    {law.canonical_citation}
                    {syncedDate && (
                        <span className="ml-2 text-gray-300">· opdateret {syncedDate}</span>
                    )}
                </p>
            </div>
            <a
                href={retsinformationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 flex items-center gap-1 text-xs text-gray-400 hover:text-gray-700 transition-colors mt-0.5"
                title="Åbn på retsinformation.dk"
            >
                <ExternalLink className="h-3.5 w-3.5" />
            </a>
        </div>
    );
}
