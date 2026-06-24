import { kv } from "../_kv.ts";
import { CanaryError } from "../../dto/_shared.ts";
import { log } from "../_log.ts";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

interface InviteRecord {
  email: string;
}

function inviteEmailHtml(link: string): string {
  return `<!DOCTYPE html><html><body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#0f0f0f;padding:48px 24px;margin:0">
<div style="max-width:480px;margin:auto;background:#1a1a1a;border:1px solid #2a2a2a;border-radius:14px;padding:44px 40px">
  <div style="margin-bottom:28px">
    <span style="font-size:32px">🐦</span>
    <h1 style="color:#e0e0e0;font-size:22px;font-weight:600;margin:12px 0 6px">You're invited to Canary</h1>
    <p style="color:#777;font-size:14px;line-height:1.6;margin:0">HTTP monitoring and alerting. You've been added as a member — click below to set your password and get started.</p>
  </div>
  <a href="${link}" style="display:inline-block;background:#FFD700;color:#000;font-weight:600;font-size:14px;padding:12px 28px;border-radius:8px;text-decoration:none">Accept Invitation</a>
  <p style="color:#555;font-size:12px;margin-top:28px;line-height:1.6">This link expires in 7 days. If you weren't expecting this, you can safely ignore it.</p>
</div>
</body></html>`;
}

export interface CreateInvitesResult {
  sent: string[];
  failed: { email: string; error: string }[];
}

export async function createInvites(
  emails: string[],
  baseUrl: string,
  fromEmail: string,
  postmarkToken: string,
): Promise<CreateInvitesResult> {
  if (!Array.isArray(emails) || !emails.length || emails.length > 10) {
    throw new CanaryError("validation-error", "Provide between 1 and 10 email addresses", 400);
  }
  // Normalize (trim) and validate up front. We persist/send the TRIMMED value so
  // the stored invite — and the username created on acceptance — never carries
  // stray surrounding whitespace (which would make a later login by the clean
  // form miss the row). A basic format check also rejects non-email strings so
  // they can't become a verbatim username.
  const normalized = emails.map((email) => {
    if (typeof email !== "string" || email.trim() === "") {
      throw new CanaryError("validation-error", "Each email must be a non-empty string", 400);
    }
    const trimmed = email.trim();
    // Pragmatic shape check: non-empty local part, "@", non-empty domain with a
    // dot, and no internal whitespace — enough to reject "admin", "<x>", etc.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      throw new CanaryError("validation-error", `"${email}" is not a valid email address`, 400);
    }
    return trimmed;
  });

  // Send each invite independently. A single failing send must not abort the
  // batch (leaving the others' tokens live but unreported) — instead we clean up
  // the failed invite's KV row and surface a per-email result so the admin knows
  // exactly which addresses went out and which to retry.
  const results = await Promise.all(normalized.map(async (email): Promise<{ email: string; ok: boolean; error?: string }> => {
    const token = crypto.randomUUID();
    await kv.set(["invite", token], { email } satisfies InviteRecord, { expireIn: INVITE_TTL_MS });
    const link = `${baseUrl}/invite/accept?token=${token}`;

    let res: Response;
    try {
      res = await fetch("https://api.postmarkapp.com/email", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Postmark-Server-Token": postmarkToken,
        },
        body: JSON.stringify({
          From: fromEmail,
          To: email,
          Subject: "You've been invited to Canary",
          HtmlBody: inviteEmailHtml(link),
          TextBody: `You've been invited to Canary, an HTTP monitoring platform.\n\nSet your password here:\n${link}\n\nThis link expires in 7 days.`,
          MessageStream: "outbound",
        }),
      });
    } catch (e) {
      // Drop the now-orphaned token so it can't be resolved by a stale link.
      await kv.delete(["invite", token]);
      log.warn(`⚠️ invite send threw for ${email} — ${(e as Error).message}`);
      return { email, ok: false, error: (e as Error).message };
    }

    if (!res.ok) {
      const body = await res.text();
      await kv.delete(["invite", token]);
      log.warn(`⚠️ invite send failed for ${email} — ${res.status}: ${body}`);
      return { email, ok: false, error: `${res.status}: ${body}` };
    }

    log.info("✅ invite sent:", email);
    return { email, ok: true };
  }));

  const failed = results.filter((r) => !r.ok);
  // Only fail the whole call when every send failed (nothing went out). A
  // partial success returns normally — the live invites stay valid.
  if (failed.length === emails.length) {
    throw new CanaryError(
      "internal-error",
      `Failed to send any invites: ${failed.map((f) => `${f.email} (${f.error})`).join("; ")}`,
      500,
    );
  }
  return { sent: results.filter((r) => r.ok).map((r) => r.email), failed: failed.map((f) => ({ email: f.email, error: f.error ?? "unknown" })) };
}

/** Resolve an invite token to its email WITHOUT consuming it. Callers must
 *  finalize a successful acceptance with `markInviteConsumed`, so a failed
 *  createUser/login doesn't permanently burn the single-use token. */
export async function peekInvite(token: string): Promise<string> {
  const entry = await kv.get<InviteRecord>(["invite", token], { consistency: "strong" });
  if (!entry.value) throw new CanaryError("not-found", "Invite link not found or expired", 404);
  return entry.value.email;
}

/** Delete a consumed invite token. Call only after the account was created. */
export async function markInviteConsumed(token: string): Promise<void> {
  await kv.delete(["invite", token]);
}

export async function consumeInvite(token: string): Promise<string> {
  const email = await peekInvite(token);
  await markInviteConsumed(token);
  return email;
}
