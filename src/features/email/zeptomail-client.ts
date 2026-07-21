import "server-only";

export class ZeptoMailError extends Error {
  constructor(public readonly code: "ZEPTOMAIL_UNAVAILABLE" | "ZEPTOMAIL_INVALID_RESPONSE") {
    super(code);
    this.name = "ZeptoMailError";
  }
}

export function createZeptoMailClient(options: {
  token: string;
  senderAddress: string;
  senderName: string;
  fetchImpl?: typeof fetch;
  endpoint?: string;
}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  return {
    async send(message: { to: string; subject: string; htmlBody: string; textBody: string }) {
      let response: Response;
      try {
        response = await fetchImpl(options.endpoint ?? "https://api.zeptomail.in/v1.1/email", {
          method: "POST",
          headers: {
            Authorization: `Zoho-enczapikey ${options.token}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from: { address: options.senderAddress, name: options.senderName },
            to: [{ email_address: { address: message.to } }],
            subject: message.subject,
            htmlbody: message.htmlBody,
            textbody: message.textBody,
          }),
          signal: AbortSignal.timeout(8_000),
        });
      } catch {
        throw new ZeptoMailError("ZEPTOMAIL_UNAVAILABLE");
      }
      if (!response.ok) throw new ZeptoMailError("ZEPTOMAIL_UNAVAILABLE");
      let body: unknown;
      try {
        body = await response.json() as unknown;
      } catch {
        throw new ZeptoMailError("ZEPTOMAIL_INVALID_RESPONSE");
      }
      const requestId = body && typeof body === "object" ? (body as { request_id?: unknown }).request_id : null;
      if (typeof requestId !== "string" || !requestId) throw new ZeptoMailError("ZEPTOMAIL_INVALID_RESPONSE");
      return { providerMessageId: requestId };
    },
  };
}

export type ZeptoMailClient = ReturnType<typeof createZeptoMailClient>;
