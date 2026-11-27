// text.lk REST API v3 client (https://text.lk/docs/send-sms/).
// POST https://app.text.lk/api/v3/sms/send with a Bearer token. The published
// docs show two response shapes ({status: "success"} and {status: true}), so
// both are accepted as success.

const SEND_URL = "https://app.text.lk/api/v3/sms/send";
const TIMEOUT_MS = 15_000;

export type SendResult = { ok: true; uid: string | null } | { ok: false; error: string };

export interface SmsTransport {
  send(opts: {
    apiToken: string;
    senderId: string;
    recipient: string;
    message: string;
  }): Promise<SendResult>;
}

const textlkTransport: SmsTransport = {
  async send({ apiToken, senderId, recipient, message }) {
    let res: Response;
    try {
      res = await fetch(SEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiToken}`,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({ recipient, sender_id: senderId, type: "plain", message }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (err) {
      return { ok: false, error: `text.lk unreachable: ${(err as Error).message}` };
    }

    const body = (await res.json().catch(() => null)) as {
      status?: unknown;
      message?: unknown;
      data?: { uid?: unknown; sms_id?: unknown };
    } | null;

    const succeeded = res.ok && (body?.status === "success" || body?.status === true);
    if (!succeeded) {
      const msg = typeof body?.message === "string" && body.message ? body.message : null;
      return { ok: false, error: msg ?? `text.lk returned HTTP ${res.status}` };
    }
    const uid = body?.data?.uid ?? body?.data?.sms_id;
    return { ok: true, uid: uid == null ? null : String(uid) };
  },
};

let transport: SmsTransport = textlkTransport;

/** Test seam: replace the network transport. Pass null to restore text.lk. */
export function setSmsTransport(next: SmsTransport | null): void {
  transport = next ?? textlkTransport;
}

export function getSmsTransport(): SmsTransport {
  return transport;
}

/**
 * Normalise a phone number to the digits-only international form text.lk
 * expects (e.g. 94771234567). Local Sri Lankan forms ("077 123 4567",
 * "771234567") get the 94 country code; numbers written with "+" or "00" are
 * taken as international. Returns null when the result cannot be a phone
 * number.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  let digits = trimmed.replace(/\D/g, "");
  if (!digits) return null;

  if (trimmed.startsWith("+")) {
    // "+94 (0)77 ..." keeps a trunk zero after the country code.
    if (digits.startsWith("940") && digits.length === 12) digits = `94${digits.slice(3)}`;
  } else if (digits.startsWith("00")) {
    digits = digits.slice(2);
  } else if (digits.length === 10 && digits.startsWith("0")) {
    digits = `94${digits.slice(1)}`;
  } else if (digits.length === 9) {
    digits = `94${digits}`;
  }

  return digits.length >= 10 && digits.length <= 15 ? digits : null;
}
