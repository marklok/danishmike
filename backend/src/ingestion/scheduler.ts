/**
 * Scheduled law sync — runs automatically inside the backend process.
 *
 * Schedule: every Sunday at 02:00 (server local time).
 *   Cron: "0 2 * * 0"
 *
 * Keeps law_chunks up to date so source_url links always point to the
 * latest consolidated version on retsinformation.dk.
 *
 * On failure: sends an email digest to SYNC_NOTIFY_EMAIL via Resend.
 */

import cron from "node-cron";
import { Resend } from "resend";
import {
  getLawsToIndex,
  fetchLaw,
  chunkLaw,
  upsertChunks,
} from "./retsinformation";
import {
  getRegulationsToIndex,
  fetchRegulationHtml,
  parseRegulationHtml,
  chunkRegulation,
  upsertEurLexChunks,
} from "./eurlex";

// ---------------------------------------------------------------------------
// Email notification
// ---------------------------------------------------------------------------

interface SyncFailure {
  label: string;
  error: string;
}

async function sendFailureAlert(failures: SyncFailure[], startedAt: string): Promise<void> {
  const apiKey     = process.env.RESEND_API_KEY;
  const notifyEmail = process.env.SYNC_NOTIFY_EMAIL;

  if (!apiKey || apiKey === "your-resend-key" || !notifyEmail) {
    console.warn("[scheduler] SYNC_NOTIFY_EMAIL or RESEND_API_KEY not configured — skipping email alert");
    return;
  }

  const resend = new Resend(apiKey);

  const rows = failures
    .map((f) => `<tr><td style="padding:4px 12px 4px 0;font-weight:bold">${f.label}</td><td style="padding:4px 0;color:#c0392b;font-family:monospace;font-size:13px">${f.error}</td></tr>`)
    .join("\n");

  const html = `
<p>The weekly law sync that started at <strong>${startedAt}</strong> completed with <strong>${failures.length} failure(s)</strong>.</p>
<table style="border-collapse:collapse;font-size:14px;margin-top:8px">
  <thead>
    <tr>
      <th style="text-align:left;padding:4px 12px 4px 0;border-bottom:1px solid #ddd">Law / Regulation</th>
      <th style="text-align:left;padding:4px 0;border-bottom:1px solid #ddd">Error</th>
    </tr>
  </thead>
  <tbody>
    ${rows}
  </tbody>
</table>
<p style="margin-top:16px;color:#555;font-size:13px">
  Check the server logs for full stack traces.<br>
  Laws that failed will retain their previous version in the database until the next successful sync.
</p>`;

  try {
    const from = process.env.SYNC_NOTIFY_FROM ?? "Mike Sync <noreply@markus.legal>";
    await resend.emails.send({
      from,
      to:      notifyEmail,
      subject: `⚠️ Mike sync: ${failures.length} law(s) failed — ${new Date().toLocaleDateString("da-DK")}`,
      html,
    });
    console.log(`[scheduler] Failure alert sent to ${notifyEmail}`);
  } catch (err) {
    console.error("[scheduler] Failed to send alert email:", err);
  }
}

// ---------------------------------------------------------------------------
// Main sync
// ---------------------------------------------------------------------------

let syncRunning = false;

export async function runFullSync(): Promise<void> {
  if (syncRunning) {
    console.log("[scheduler] Sync already in progress — skipping");
    return;
  }
  syncRunning = true;
  const startedAt = new Date().toISOString();
  const failures: SyncFailure[] = [];
  console.log(`\n[scheduler] === Full law sync started at ${startedAt} ===`);

  // ── Retsinformation ────────────────────────────────────────────────────────
  try {
    const laws = await getLawsToIndex();
    console.log(`[scheduler] Retsinformation: ${laws.length} laws`);
    let inserted = 0, updated = 0, skipped = 0;

    for (const law of laws) {
      try {
        const doc = await fetchLaw(law.year, law.number);
        const chunks = chunkLaw(doc, law.label);
        const result = await upsertChunks(chunks);
        inserted += result.inserted;
        updated  += result.updated;
        skipped  += result.skipped;
        if (result.inserted + result.updated > 0) {
          console.log(
            `[scheduler]   ${law.label}: +${result.inserted} inserted, ~${result.updated} updated`,
          );
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler]   ${law.label} FAILED: ${message}`);
        failures.push({ label: law.label, error: message });
      }
    }
    console.log(
      `[scheduler] Retsinformation done — inserted:${inserted} updated:${updated} skipped:${skipped} failed:${failures.length}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[scheduler] Retsinformation sync error:", message);
    failures.push({ label: "retsinformation (getLawsToIndex)", error: message });
  }

  // ── EUR-Lex ────────────────────────────────────────────────────────────────
  const eurlexFailuresBefore = failures.length;
  try {
    const regulations = getRegulationsToIndex();
    console.log(`[scheduler] EUR-Lex: ${regulations.length} regulations`);
    let inserted = 0, skipped = 0;

    for (const reg of regulations) {
      const label = reg.label ?? reg.celex;
      try {
        const html    = await fetchRegulationHtml(reg.celex);
        const parsed  = parseRegulationHtml(html, reg.celex);
        const chunks  = chunkRegulation(parsed);
        const result  = await upsertEurLexChunks(chunks);
        inserted += result.inserted;
        skipped  += result.skipped;
        if (result.inserted > 0) {
          console.log(`[scheduler]   ${label}: +${result.inserted} inserted`);
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[scheduler]   ${label} FAILED: ${message}`);
        failures.push({ label: `eurlex/${label}`, error: message });
      }
    }
    console.log(
      `[scheduler] EUR-Lex done — inserted:${inserted} skipped:${skipped} failed:${failures.length - eurlexFailuresBefore}`,
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error("[scheduler] EUR-Lex sync error:", message);
    failures.push({ label: "eurlex (getRegulationsToIndex)", error: message });
  }

  // ── Summary + alert ────────────────────────────────────────────────────────
  const finishedAt = new Date().toISOString();
  console.log(`[scheduler] === Full sync finished at ${finishedAt} — ${failures.length} failure(s) ===\n`);

  if (failures.length > 0) {
    await sendFailureAlert(failures, startedAt);
  }

  syncRunning = false;
}

// ---------------------------------------------------------------------------
// Cron scheduler
// ---------------------------------------------------------------------------

/**
 * Start the weekly cron job.
 * Call once at server startup from index.ts.
 */
export function startSyncScheduler(): void {
  // Every Sunday at 02:00
  cron.schedule("0 2 * * 0", () => {
    console.log("[scheduler] Weekly sync triggered by cron");
    runFullSync().catch((err) =>
      console.error("[scheduler] Unhandled sync error:", err),
    );
  });
  console.log("[scheduler] Weekly law sync scheduled (Sundays 02:00)");
}
