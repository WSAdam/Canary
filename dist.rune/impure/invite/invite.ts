import { kv } from "../_kv.ts";
import { CanaryError } from "../../dto/_shared.ts";

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

export async function createInvites(
  emails: string[],
  baseUrl: string,
  fromEmail: string,
  postmarkToken: string,
): Promise<void> {
  if (!emails.length || emails.length > 10) {
    throw new CanaryError("validation-error", "Provide between 1 and 10 email addresses", 400);
  }

  await Promise.all(emails.map(async (email) => {
    const token = crypto.randomUUID();
    await kv.set(["invite", token], { email } satisfies InviteRecord, { expireIn: INVITE_TTL_MS });
    const link = `${baseUrl}/invite/accept?token=${token}`;

    const res = await fetch("https://api.postmarkapp.com/email", {
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

    if (!res.ok) {
      const body = await res.text();
      throw new CanaryError("internal-error", `Failed to send invite to ${email}: ${body}`, 500);
    }

    console.log("✅ invite sent:", email);
  }));
}

export async function consumeInvite(token: string): Promise<string> {
  const entry = await kv.get<InviteRecord>(["invite", token]);
  if (!entry.value) throw new CanaryError("not-found", "Invite link not found or expired", 404);
  const { email } = entry.value;
  await kv.delete(["invite", token]);
  return email;
}
