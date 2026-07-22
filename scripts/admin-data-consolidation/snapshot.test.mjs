import assert from "node:assert/strict";
import test from "node:test";
import { decryptSnapshot, encryptSnapshot } from "./snapshot.mjs";

test("encrypted migration snapshots round-trip without exposing plaintext", () => {
  const payload = { database: "destination", rows: [{ secret: "private-value" }] };
  const encrypted = encryptSnapshot(payload, "a-long-local-backup-passphrase");
  assert.doesNotMatch(encrypted, /private-value/);
  assert.deepEqual(decryptSnapshot(encrypted, "a-long-local-backup-passphrase"), payload);
});

test("snapshot authentication rejects the wrong passphrase", () => {
  const encrypted = encryptSnapshot({ safe: true }, "correct-passphrase-value");
  assert.throws(() => decryptSnapshot(encrypted, "incorrect-passphrase"));
});
