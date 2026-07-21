import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export type InternalSignatureInput = {
  method: string;
  pathAndQuery: string;
  timestamp: string;
  nonce: string;
  rawBody: string;
};

function canonicalPathAndQuery(pathAndQuery: string) {
  const url = new URL(pathAndQuery, "https://noirhaus.internal");
  const query = [...url.searchParams.entries()]
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => (
      (leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0)
      || (leftValue < rightValue ? -1 : leftValue > rightValue ? 1 : 0)
    ))
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return `${url.pathname}${query ? `?${query}` : ""}`;
}

export function canonicalRequest(input: InternalSignatureInput) {
  const bodyHash = createHash("sha256").update(input.rawBody, "utf8").digest("hex");
  return [
    input.method.toUpperCase(),
    canonicalPathAndQuery(input.pathAndQuery),
    input.timestamp,
    input.nonce,
    bodyHash,
  ].join("\n");
}

export function signInternalRequest(input: InternalSignatureInput, secret: string) {
  return createHmac("sha256", secret).update(canonicalRequest(input), "utf8").digest("hex");
}

export function verifyInternalSignature(
  input: InternalSignatureInput,
  secret: string,
  signature: string,
  options: { now?: Date; maxSkewSeconds?: number } = {},
) {
  if (!/^\d+$/.test(input.timestamp) || !/^[a-f0-9]{64}$/i.test(signature)) return false;
  const timestampMilliseconds = Number(input.timestamp) * 1000;
  const now = options.now ?? new Date();
  const maxSkewMilliseconds = (options.maxSkewSeconds ?? 300) * 1000;
  if (!Number.isSafeInteger(timestampMilliseconds) || Math.abs(now.getTime() - timestampMilliseconds) > maxSkewMilliseconds) {
    return false;
  }
  const expected = Buffer.from(signInternalRequest(input, secret), "hex");
  const provided = Buffer.from(signature, "hex");
  return expected.length === provided.length && timingSafeEqual(expected, provided);
}
