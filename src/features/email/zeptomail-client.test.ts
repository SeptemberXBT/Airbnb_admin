import { describe, expect, it, vi } from "vitest";
import { createZeptoMailClient } from "./zeptomail-client";

describe("Zoho ZeptoMail client", () => {
  it("sends verified HTML/text mail with the Zoho authorization scheme", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response(JSON.stringify({ request_id: "zepto-request-1" }), {
      status: 200, headers: { "content-type": "application/json" },
    }));
    const client = createZeptoMailClient({
      token: "zepto-token", senderAddress: "stay@noirhaus.example", senderName: "Noir Haus", fetchImpl,
    });
    expect(await client.send({
      to: "guest@example.test", subject: "Booking", htmlBody: "<p>Confirmed</p>", textBody: "Confirmed",
    })).toEqual({ providerMessageId: "zepto-request-1" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.zeptomail.in/v1.1/email");
    expect((init?.headers as Record<string, string>).Authorization).toBe("Zoho-enczapikey zepto-token");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      from: { address: "stay@noirhaus.example", name: "Noir Haus" },
      subject: "Booking",
      htmlbody: "<p>Confirmed</p>",
      textbody: "Confirmed",
    });
  });

  it("returns a redacted retryable error", async () => {
    const client = createZeptoMailClient({
      token: "zepto-token", senderAddress: "stay@noirhaus.example", senderName: "Noir Haus",
      fetchImpl: vi.fn<typeof fetch>(async () => new Response("provider secret detail", { status: 500 })),
    });
    await expect(client.send({ to: "guest@example.test", subject: "x", htmlBody: "x", textBody: "x" }))
      .rejects.toMatchObject({ code: "ZEPTOMAIL_UNAVAILABLE", message: "ZEPTOMAIL_UNAVAILABLE" });
  });
});
