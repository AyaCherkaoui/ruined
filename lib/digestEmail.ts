import type { Digest } from "./contract";
import { displayDrugName } from "./display";
import { MissingApiKeyError } from "./http";
import { ResendClient } from "./resend";

// Renders the Digest as a clean HTML email for the doctor. Every figure comes straight from the
// already-computed Digest/PatientAlert fields -- no formatting choice here invents a number.

const esc = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const money = (n: number | null): string => (n === null ? "—" : `$${n.toFixed(2)}`);

export function digestSubject(digest: Digest): string {
  return `${digest.totalAtRisk} of your patients are affected by upcoming plan changes`;
}

export function digestHtml(digest: Digest): string {
  const rows = digest.alerts
    .map(
      (a) => `
      <tr>
        <td style="padding:8px;border-bottom:1px solid #e5e5e5">${esc(a.patientName)}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e5e5">${esc(a.displayName)}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e5e5;text-align:right">${money(a.oldMonthlyCost)}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e5e5;text-align:right">${money(a.newMonthlyCost)}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e5e5">${a.bestAlternative ? esc(displayDrugName(a.bestAlternative.drugName)) : "—"}</td>
        <td style="padding:8px;border-bottom:1px solid #e5e5e5;text-align:right">${a.bestAlternative ? money(a.bestAlternative.monthlySavings) : "—"}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html>
  <body style="font-family:-apple-system,Helvetica,Arial,sans-serif;color:#1a1a1a;max-width:680px;margin:0 auto;padding:24px">
    <h2 style="margin:0 0 8px">${esc(digestSubject(digest))}</h2>
    <p style="color:#555;margin:0 0 20px">
      Estimated added cost: <strong>${money(digest.totalMonthlyIncrease)}/mo</strong>.
      Potential savings if switched: <strong>${money(digest.totalMonthlySavingsIfSwitched)}/mo</strong>.
    </p>
    <table style="width:100%;border-collapse:collapse;font-size:14px">
      <thead>
        <tr style="text-align:left;border-bottom:2px solid #1a1a1a">
          <th style="padding:8px">Patient</th>
          <th style="padding:8px">Drug</th>
          <th style="padding:8px;text-align:right">Cost before</th>
          <th style="padding:8px;text-align:right">Cost after</th>
          <th style="padding:8px">Suggested switch</th>
          <th style="padding:8px;text-align:right">Savings</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>
    <p style="color:#999;font-size:12px;margin-top:24px">
      Generated ${esc(digest.generatedAt)}. Every dollar figure is an estimate, not a bill.
    </p>
  </body>
</html>`;
}

export interface SendDigestEmailOptions {
  resend?: ResendClient;
  /** Recipient override for testing; defaults to env DOCTOR_EMAIL. */
  to?: string;
}

/** POST /api/digest/email: send the digest to the doctor. Throws MissingApiKeyError if DOCTOR_EMAIL / RESEND_API_KEY aren't set. */
export async function sendDigestEmail(digest: Digest, opts: SendDigestEmailOptions = {}): Promise<{ sent: true; id: string }> {
  const to = opts.to ?? process.env.DOCTOR_EMAIL;
  if (!to) throw new MissingApiKeyError("DOCTOR_EMAIL");

  const resend = opts.resend ?? new ResendClient();
  const { id } = await resend.send({ to, subject: digestSubject(digest), html: digestHtml(digest) });
  return { sent: true, id };
}
