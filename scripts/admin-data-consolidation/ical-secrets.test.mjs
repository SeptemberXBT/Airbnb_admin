import assert from "node:assert/strict";
import test from "node:test";
import { openIcalUrl, sealIcalUrl } from "./ical-secrets.mjs";

test("iCal URLs are re-encrypted for the destination key", () => {
  const oldKey = Buffer.alloc(32, 1).toString("base64");
  const newKey = Buffer.alloc(32, 2).toString("base64");
  const url = "https://calendar.example/private-feed.ics";
  const oldCiphertext = sealIcalUrl(url, oldKey);
  const newCiphertext = sealIcalUrl(openIcalUrl(oldCiphertext, oldKey), newKey);
  assert.equal(openIcalUrl(newCiphertext, newKey), url);
  assert.throws(() => openIcalUrl(newCiphertext, oldKey));
});
