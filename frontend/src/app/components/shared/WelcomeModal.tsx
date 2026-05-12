"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X, Gift } from "lucide-react";

const STORAGE_KEY_PREFIX = "mike_welcomed_";

interface Props {
    userId: string;
    freeMessages: number;
}

export function WelcomeModal({ userId, freeMessages }: Props) {
    const [open, setOpen] = useState(false);

    useEffect(() => {
        if (!userId) return;
        const key = `${STORAGE_KEY_PREFIX}${userId}`;
        if (!localStorage.getItem(key)) {
            setOpen(true);
        }
    }, [userId]);

    const dismiss = () => {
        localStorage.setItem(`${STORAGE_KEY_PREFIX}${userId}`, "1");
        setOpen(false);
    };

    if (!open) return null;

    return createPortal(
        <div
            className="fixed inset-0 z-[200] flex items-center justify-center bg-black/20 backdrop-blur-xs"
            onClick={dismiss}
        >
            <div
                className="w-full max-w-sm rounded-2xl bg-white shadow-2xl flex flex-col mx-4"
                onClick={(e) => e.stopPropagation()}
            >
                {/* Header */}
                <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
                    <div className="flex items-center gap-2">
                        <Gift className="h-4 w-4 text-gray-700 flex-shrink-0" />
                        <h2 className="text-base font-medium text-gray-900">
                            Velkommen til Danish Mike
                        </h2>
                    </div>
                    <button
                        onClick={dismiss}
                        className="rounded-lg p-1.5 text-gray-400 hover:bg-gray-100 hover:text-gray-600 flex-shrink-0"
                    >
                        <X className="h-4 w-4" />
                    </button>
                </div>

                {/* Body */}
                <div className="px-5 pb-5">
                    <p className="text-sm text-gray-600 leading-relaxed">
                        Du får{" "}
                        <span className="font-semibold text-gray-900">
                            {freeMessages} gratis beskeder
                        </span>{" "}
                        i velkomstgave. Derefter skal du tilføje din egen API
                        nøgle under{" "}
                        <span className="font-medium text-gray-800">
                            Settings
                        </span>
                        .
                    </p>
                </div>

                {/* Footer */}
                <div className="px-5 pb-5 pt-1">
                    <button
                        onClick={dismiss}
                        className="w-full rounded-lg bg-gray-900 px-4 py-2 text-sm font-medium text-white hover:bg-gray-700 transition-colors"
                    >
                        Kom i gang
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
}
