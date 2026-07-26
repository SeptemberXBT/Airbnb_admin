# Checkout Abandonment Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Release a room within seconds after a provider-verified Razorpay modal cancellation, while allowing the originating browser to resume the same held booking and Razorpay order after closing the entire tab.

**Architecture:** The authoritative admin service issues a short-lived opaque resume token whose lookup hash and AES-256-GCM ciphertext are stored with the booking. The public site stores only that token plus non-sensitive stay metadata, uses signed proxy endpoints to resume or cancel the original attempt, and never releases inventory from a client-only close signal. Existing captured-payment reconciliation, amount-integrity checks, webhooks, and the ten-minute expiry worker remain authoritative.

**Tech Stack:** Next.js 16 route handlers, TypeScript, PostgreSQL/Supabase migrations, Node `crypto`, Zod, Vitest, database-backed Vitest, static browser JavaScript, Playwright, Razorpay Orders API, Vercel.

---

## File Structure

### Admin repository: `airbnb-operations-calendar`

- Create `supabase/migrations/0010_booking_resume_tokens.sql` — add the token table, constraints, indexes, RLS, and grants.
- Create `supabase/migrations/0010_booking_resume_tokens.down.sql` — remove the token table.
- Create `src/features/bookings/booking-resume-token.ts` — generate, hash, encrypt, and decrypt opaque tokens.
- Create `src/features/bookings/booking-resume-token.test.ts` — pure cryptographic contract tests.
- Create `src/features/bookings/booking-resume-service.ts` — issue, reveal, validate, revoke, and resume booking attempts.
- Create `src/features/bookings/booking-resume-service.db.test.ts` — token lifecycle, same-order resume, release, and retry tests.
- Modify `src/features/bookings/booking-service.ts` — attach the resume token to initial and idempotent Checkout responses without storing plaintext in `terminal_response`.
- Modify `src/features/bookings/booking-service.db.test.ts` — prove one token/order/booking across retries.
- Modify `src/features/payments/payment-reconciliation.ts` — support non-mutating resume checks and revoke tokens on terminal transitions.
- Modify `src/features/payments/payment-reconciliation.db.test.ts` — verify token revocation and provider-state behavior.
- Create `src/app/api/internal/v1/bookings/[reference]/resume/route.ts` — signed internal resume endpoint.
- Create `src/app/api/internal/v1/bookings/[reference]/resume/route.test.ts` — route authentication and response tests.
- Modify `src/app/api/internal/v1/bookings/[reference]/reconcile/route.ts` — require and validate a resume token for public callback/dismissal.
- Modify `src/app/api/internal/v1/bookings/[reference]/reconcile/route.test.ts` — reject missing/invalid tokens and accept valid tokens.
- Modify `src/lib/db/migration.test.ts` — include migration 0010 security assertions.

### Public repository: `noirhaus-public`

- Modify `src/features/booking-api/schemas.ts` — add resume-token, resumable-Checkout, and token-bearing reconciliation contracts.
- Modify `src/features/booking-api/schemas.test.ts` — validate strict token and response schemas.
- Create `src/app/api/booking/resume/[reference]/route.ts` — signed public-to-admin resume proxy.
- Modify `src/app/api/booking/reconcile/[reference]/route.ts` — proxy the required resume token.
- Create `src/app/api/booking/resume/[reference]/route.test.ts` — proxy validation and error mapping tests.
- Create `public/noir-haus-site/assets/booking-recovery.js` — versioned local-storage recovery record and safe DOM helpers.
- Create `scripts/public-site-assets/booking-recovery.js` — canonical mirrored source for deployment rebuilds.
- Modify `public/noir-haus-site/assets/booking.js` — save, resume, cancel, and clear attempts; render verified cancellation.
- Modify `scripts/public-site-assets/booking.js` — keep the canonical mirrored source identical.
- Modify `public/noir-haus-site/assets/runtime.css` — recovery banner and action styles.
- Modify `scripts/public-site-assets/runtime.css` — keep the canonical mirrored source identical.
- Modify the eleven tracked booking-enabled `index.html` files — load `booking-recovery.js` before `booking.js`.
- Modify `e2e/public-booking.spec.ts` — cover modal cancellation, tab return, same-order resume, and ambiguous-state retention.

### Deployment configuration

- Add `BOOKING_RESUME_ENCRYPTION_KEY` to the admin Vercel Preview and Production environments.
- Do not add the key to the public project or any `NEXT_PUBLIC_*` variable.

---

### Task 1: Add Token Cryptography and Database Storage

**Files:**
- Create: `supabase/migrations/0010_booking_resume_tokens.sql`
- Create: `supabase/migrations/0010_booking_resume_tokens.down.sql`
- Create: `src/features/bookings/booking-resume-token.ts`
- Create: `src/features/bookings/booking-resume-token.test.ts`
- Modify: `src/lib/db/migration.test.ts`

- [ ] **Step 1: Write failing cryptography tests**

Add tests with this contract:

```ts
const key = Buffer.alloc(32, 7).toString("base64url");
const first = createResumeTokenCipher(key);
const token = first.generate();

expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
expect(first.hash(token)).toMatch(/^[a-f0-9]{64}$/);
expect(first.decrypt(first.encrypt(token))).toBe(token);
expect(() => createResumeTokenCipher(Buffer.alloc(31).toString("base64url"))).toThrow("INVALID_BOOKING_RESUME_ENCRYPTION_KEY");
expect(() => createResumeTokenCipher(Buffer.alloc(32, 8).toString("base64url"))
  .decrypt(first.encrypt(token))).toThrow("INVALID_BOOKING_RESUME_TOKEN_CIPHERTEXT");
```

- [ ] **Step 2: Run the cryptography test and verify RED**

Run:

```bash
npm test -- --run src/features/bookings/booking-resume-token.test.ts
```

Expected: FAIL because `booking-resume-token.ts` does not exist.

- [ ] **Step 3: Implement the cryptographic boundary**

Implement `createResumeTokenCipher(encodedKey)` with:

```ts
generate(): string
hash(token: string): string
encrypt(token: string): string
decrypt(ciphertext: string): string
```

Use `randomBytes(32).toString("base64url")`, SHA-256 hex hashes, and AES-256-GCM with a fresh 12-byte IV. Encode `iv || authTag || ciphertext` as base64url. Require exactly 32 decoded key bytes and collapse all decryption/authentication failures to `INVALID_BOOKING_RESUME_TOKEN_CIPHERTEXT`.

- [ ] **Step 4: Add migration 0010**

Create:

```sql
create table public.booking_resume_tokens (
  booking_id uuid primary key references public.bookings(id) on delete cascade,
  token_hash text not null unique check (token_hash ~ '^[a-f0-9]{64}$'),
  token_ciphertext text not null check (char_length(token_ciphertext) between 40 and 512),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (expires_at > created_at),
  check (revoked_at is null or revoked_at >= created_at)
);

create index booking_resume_tokens_expiry_idx
  on public.booking_resume_tokens (expires_at)
  where revoked_at is null;

alter table public.booking_resume_tokens enable row level security;
revoke all on public.booking_resume_tokens from anon;
revoke all on public.booking_resume_tokens from authenticated;
```

The down migration contains only:

```sql
drop table if exists public.booking_resume_tokens;
```

Extend the migration test to require the table, RLS, and revoked partial index.

- [ ] **Step 5: Run unit and migration tests**

Run:

```bash
npm test -- --run src/features/bookings/booking-resume-token.test.ts src/lib/db/migration.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit Task 1**

```bash
git add supabase/migrations/0010_booking_resume_tokens.sql supabase/migrations/0010_booking_resume_tokens.down.sql src/features/bookings/booking-resume-token.ts src/features/bookings/booking-resume-token.test.ts src/lib/db/migration.test.ts
git commit -m "feat: add encrypted booking resume tokens"
```

### Task 2: Add the Resume-Token Lifecycle Service

**Files:**
- Create: `src/features/bookings/booking-resume-service.ts`
- Create: `src/features/bookings/booking-resume-service.db.test.ts`

- [ ] **Step 1: Write failing database tests**

Cover these exact assertions:

```ts
const issued = await service.issue(booking.id, holdExpiresAt);
expect(issued).toMatch(/^[A-Za-z0-9_-]{43}$/);

const [stored] = await testSql`
  select token_hash, token_ciphertext, revoked_at
  from public.booking_resume_tokens where booking_id = ${booking.id}
`;
expect(JSON.stringify(stored)).not.toContain(issued);
expect(await service.authorize(booking.public_reference, issued, NOW)).toMatchObject({
  bookingId: booking.id,
  publicReference: booking.public_reference,
});
await expect(service.authorize(booking.public_reference, `${issued}x`, NOW))
  .rejects.toMatchObject({ code: "BOOKING_RESUME_TOKEN_INVALID" });

await service.revoke(testSql, booking.id, NOW);
await expect(service.authorize(booking.public_reference, issued, NOW))
  .rejects.toMatchObject({ code: "BOOKING_RESUME_TOKEN_REVOKED" });
```

Also assert that `reveal(booking.id)` decrypts the original token and never rotates it, while an expired token is rejected.

- [ ] **Step 2: Run the database test and verify RED**

Run:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/noirhaus_test \
TEST_SKIP_PGCRYPTO_EXTENSION=1 \
npm run test:db -- src/features/bookings/booking-resume-service.db.test.ts
```

Expected: FAIL because the lifecycle service does not exist.

- [ ] **Step 3: Implement the lifecycle service**

Expose:

```ts
export type BookingResumeAuthorization = {
  bookingId: string;
  propertyId: string;
  publicReference: string;
  status: string;
  holdExpiresAt: Date;
  razorpayOrderId: string;
  razorpayKeyId: string;
};

export function createBookingResumeService(
  sql: postgres.Sql,
  options: { encryptionKey: string; clock?: () => Date },
) {
  return {
    issue(bookingId: string, expiresAt: Date): Promise<string>,
    reveal(bookingId: string): Promise<string>,
    authorize(reference: string, rawToken: string, now?: Date): Promise<BookingResumeAuthorization>,
    revoke(tx: postgres.Sql, bookingId: string, at?: Date): Promise<void>,
  };
}
```

`issue` inserts once with `on conflict (booking_id) do nothing`, then decrypts and returns the existing ciphertext. `authorize` loads by `public_reference`, hashes the supplied token, requires the stored hash to match, requires `revoked_at is null`, and requires both token and booking hold expiry to be in the future.

- [ ] **Step 4: Run the lifecycle database test**

Run the same command as Step 2.

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add src/features/bookings/booking-resume-service.ts src/features/bookings/booking-resume-service.db.test.ts
git commit -m "feat: add booking resume token lifecycle"
```

### Task 3: Attach One Resume Token to Create and Idempotent Replay

**Files:**
- Modify: `src/features/bookings/booking-service.ts`
- Modify: `src/features/bookings/booking-service.db.test.ts`
- Modify: `src/features/payments/order-recovery.ts`
- Modify: `src/features/payments/order-recovery.db.test.ts`

- [ ] **Step 1: Write failing create/replay tests**

Extend the completed-attempt test:

```ts
expect(first.resumeToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
expect(second.resumeToken).toBe(first.resumeToken);
expect(razorpay.createOrder).toHaveBeenCalledOnce();
expect(await testSql`select id from public.bookings`).toHaveLength(1);
expect(await testSql`select booking_id from public.booking_resume_tokens`).toHaveLength(1);
const [attempt] = await testSql`select terminal_response from public.booking_attempts`;
expect(attempt.terminal_response).not.toHaveProperty("resumeToken");
```

Add the same invariant to order recovery: when a retry finds the provider order by receipt, the returned Checkout response contains one decryptable resume token and the persisted terminal response does not.

- [ ] **Step 2: Run targeted database tests and verify RED**

Run:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/noirhaus_test \
TEST_SKIP_PGCRYPTO_EXTENSION=1 \
npm run test:db -- src/features/bookings/booking-service.db.test.ts src/features/payments/order-recovery.db.test.ts
```

Expected: FAIL because `resumeToken` is absent.

- [ ] **Step 3: Integrate token issuance**

Change the public response type to:

```ts
export type CheckoutResponse = CheckoutResponseWithoutToken & {
  resumeToken: string;
};
```

Keep `CheckoutResponseWithoutToken` as the only value persisted to `booking_attempts.terminal_response`. After the Razorpay order is attached, call `resumeTokens.issue(booking.id, booking.hold_expires_at)`, persist the token-free response, and append the decrypted token only when returning.

On idempotent replay, validate the token-free response, resolve its booking by `bookingReference`, call `resumeTokens.reveal(booking.id)`, and append the same token.

Inject the resume service into tests. In production configuration, construct it from `BOOKING_RESUME_ENCRYPTION_KEY`; if missing, fail closed with `BOOKING_RESUME_NOT_CONFIGURED`.

- [ ] **Step 4: Update order recovery**

When order recovery completes an attempt asynchronously, issue the booking token before marking the attempt succeeded and keep the stored `terminal_response` token-free. The subsequent idempotent client retry reveals the same token through `booking-service`.

- [ ] **Step 5: Run targeted database tests**

Run the same command as Step 2.

Expected: PASS.

- [ ] **Step 6: Commit Task 3**

```bash
git add src/features/bookings/booking-service.ts src/features/bookings/booking-service.db.test.ts src/features/payments/order-recovery.ts src/features/payments/order-recovery.db.test.ts
git commit -m "feat: return resumable checkout attempts"
```

### Task 4: Add Provider-Verified Resume and Token-Scoped Dismissal

**Files:**
- Modify: `src/features/payments/payment-reconciliation.ts`
- Modify: `src/features/payments/payment-reconciliation.db.test.ts`
- Modify: `src/features/bookings/booking-resume-service.ts`
- Modify: `src/features/bookings/booking-resume-service.db.test.ts`
- Create: `src/app/api/internal/v1/bookings/[reference]/resume/route.ts`
- Create: `src/app/api/internal/v1/bookings/[reference]/resume/route.test.ts`
- Modify: `src/app/api/internal/v1/bookings/[reference]/reconcile/route.ts`
- Modify: `src/app/api/internal/v1/bookings/[reference]/reconcile/route.test.ts`

- [ ] **Step 1: Write failing payment-state tests**

Add database tests proving:

```ts
expect(await service.resume(reference, token)).toMatchObject({
  kind: "resumable",
  bookingReference: reference,
  orderId: originalOrderId,
});
expect(razorpay.createOrder).not.toHaveBeenCalled();

await expect(service.cancel(reference, token)).resolves.toMatchObject({ status: "expired" });
expect(await activeInventory()).toEqual([]);
await expect(createFreshBookingForSameStay()).resolves.toMatchObject({ kind: "created" });
```

Add separate cases for failed, authorised, captured, and provider-unavailable states. Authorised and unavailable states must retain active inventory. Captured must pass through the existing amount-integrity confirmation path. Terminal states must set `revoked_at`; uncertain states must not.

- [ ] **Step 2: Run the tests and verify RED**

Run:

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/noirhaus_test \
TEST_SKIP_PGCRYPTO_EXTENSION=1 \
npm run test:db -- src/features/bookings/booking-resume-service.db.test.ts src/features/payments/payment-reconciliation.db.test.ts
```

Expected: FAIL because resume/cancel behavior is absent.

- [ ] **Step 3: Extend reconciliation safely**

Add `"resume"` to `ReconciliationTrigger`. When provider payments are empty and trigger is `resume`, return the current held state without releasing or scheduling a retry. Preserve current behavior for:

- `checkout_dismissed` + empty → expired and released.
- all failed → payment_failed and released.
- authorised → payment_pending and retained.
- captured → amount-integrity confirmation.
- unknown/unavailable → retryable and retained.

Call a transaction-scoped `revokeBookingResumeToken(tx, bookingId, clock())` whenever status becomes confirmed, payment_failed, expired, or cancelled.

- [ ] **Step 4: Implement resume and cancel orchestration**

Add to `booking-resume-service`:

```ts
resume(reference: string, rawToken: string): Promise<
  | { kind: "resumable"; bookingReference: string; orderId: string; razorpayKeyId: string; holdExpiresAt: string }
  | PublicBookingStatus
>

cancel(reference: string, rawToken: string): Promise<PublicBookingStatus>
```

Both methods authorize the token first. `resume` invokes reconciliation with `resume`; it returns original Checkout data only for an active held booking with no provider attempt. `cancel` invokes `checkout_dismissed`. Neither method creates inventory or orders.

- [ ] **Step 5: Add and secure internal routes**

The resume route parses:

```ts
z.object({ resumeToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict()
```

The reconcile route changes to:

```ts
z.object({
  trigger: z.enum(["client_callback", "checkout_dismissed"]),
  resumeToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
}).strict()
```

Authenticate the internal HMAC before token authorization. Map invalid/missing/expired/revoked tokens to non-enumerating `401/409` responses. Keep webhook and worker routes unchanged.

- [ ] **Step 6: Run route and database tests**

Run:

```bash
npm test -- --run \
  'src/app/api/internal/v1/bookings/[reference]/resume/route.test.ts' \
  'src/app/api/internal/v1/bookings/[reference]/reconcile/route.test.ts'

TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/noirhaus_test \
TEST_SKIP_PGCRYPTO_EXTENSION=1 \
npm run test:db -- src/features/bookings/booking-resume-service.db.test.ts src/features/payments/payment-reconciliation.db.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit Task 4**

```bash
git add src/features/payments/payment-reconciliation.ts src/features/payments/payment-reconciliation.db.test.ts src/features/bookings/booking-resume-service.ts src/features/bookings/booking-resume-service.db.test.ts 'src/app/api/internal/v1/bookings/[reference]/resume/route.ts' 'src/app/api/internal/v1/bookings/[reference]/resume/route.test.ts' 'src/app/api/internal/v1/bookings/[reference]/reconcile/route.ts' 'src/app/api/internal/v1/bookings/[reference]/reconcile/route.test.ts'
git commit -m "feat: verify and resume abandoned checkout"
```

### Task 5: Add Strict Public Resume Proxies

**Files:**
- Modify: `src/features/booking-api/schemas.ts`
- Modify: `src/features/booking-api/schemas.test.ts`
- Create: `src/app/api/booking/resume/[reference]/route.ts`
- Create: `src/app/api/booking/resume/[reference]/route.test.ts`
- Modify: `src/app/api/booking/reconcile/[reference]/route.ts`

- [ ] **Step 1: Write failing schema and route tests**

Require:

```ts
expect(checkoutResponseSchema.parse({
  ...checkout,
  resumeToken: "A".repeat(43),
}).resumeToken).toHaveLength(43);

expect(() => reconcileRequestSchema.parse({
  trigger: "checkout_dismissed",
})).toThrow();

expect(resumeResponseSchema.parse({
  kind: "resumable",
  bookingReference: "NH-RESUME1234567",
  orderId: "order_resume",
  razorpayKeyId: "rzp_test_resume",
  holdExpiresAt: futureIso,
})).toMatchObject({ kind: "resumable" });
```

The route test must assert that the resume token is validated before proxying, the internal path is booking-scoped, and upstream 409/503 responses are mapped without leaking details.

- [ ] **Step 2: Run tests and verify RED**

Run:

```bash
npm test -- --run src/features/booking-api/schemas.test.ts 'src/app/api/booking/resume/[reference]/route.test.ts'
```

Expected: FAIL because the schemas and route are absent.

- [ ] **Step 3: Implement strict contracts and proxies**

Export:

```ts
export const resumeTokenSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const resumeRequestSchema = z.object({ resumeToken: resumeTokenSchema }).strict();
export const reconcileRequestSchema = z.object({
  trigger: z.enum(["client_callback", "checkout_dismissed"]),
  resumeToken: resumeTokenSchema,
}).strict();
```

Add `resumeToken` to `checkoutResponseSchema`. Add a strict discriminated `resumeResponseSchema` for resumable Checkout data or a public booking status. The new route uses `configuredAdminBookingApiClient()` and `/api/internal/v1/bookings/{reference}/resume`.

- [ ] **Step 4: Run public unit tests**

Run the same command as Step 2.

Expected: PASS.

- [ ] **Step 5: Commit Task 5 in `noirhaus-public`**

```bash
git add src/features/booking-api/schemas.ts src/features/booking-api/schemas.test.ts 'src/app/api/booking/resume/[reference]/route.ts' 'src/app/api/booking/resume/[reference]/route.test.ts' 'src/app/api/booking/reconcile/[reference]/route.ts'
git commit -m "feat: proxy resumable booking attempts"
```

### Task 6: Add Browser Recovery and Verified Cancellation UI

**Files:**
- Create: `public/noir-haus-site/assets/booking-recovery.js`
- Create: `scripts/public-site-assets/booking-recovery.js`
- Modify: `public/noir-haus-site/assets/booking.js`
- Modify: `scripts/public-site-assets/booking.js`
- Modify: `public/noir-haus-site/assets/runtime.css`
- Modify: `scripts/public-site-assets/runtime.css`
- Modify: eleven booking-enabled `public/noir-haus-site/**/index.html` files
- Modify: `e2e/public-booking.spec.ts`

- [ ] **Step 1: Write failing Playwright scenarios**

Add scenarios for desktop plus responsive smoke assertions:

1. Created Checkout stores one versioned recovery record containing token/reference/order/stay metadata and no guest PII.
2. Razorpay `ondismiss` posts `{ trigger: "checkout_dismissed", resumeToken }`; an expired result clears storage and renders “Payment cancelled”.
3. Simulated tab return loads the record, calls `/api/booking/resume/{reference}`, and opens the original order without `/api/booking/create`.
4. Resume with `payment_pending` shows verification copy and does not open Checkout.
5. Cancel from the recovery banner releases only after an expired/payment_failed response.
6. A 503 resume/cancel response preserves the record and shows uncertain-payment copy.

The critical assertion is:

```ts
expect(createCalls).toBe(1);
expect(resumeCalls).toBe(1);
expect(openedOrderIds).toEqual(["order_original", "order_original"]);
expect(JSON.stringify(await page.evaluate(() => localStorage))).not.toContain("guest@example.com");
```

- [ ] **Step 2: Run the focused E2E tests and verify RED**

Run:

```bash
npm run test:e2e -- --project=desktop --grep "recovery|dismissal|resume"
```

Expected: FAIL because recovery storage and resume UI do not exist.

- [ ] **Step 3: Implement the isolated storage helper**

Expose:

```js
window.NoirBookingRecovery = {
  load(),
  save(created, stay),
  clear(reference),
  isActive(record, now = Date.now()),
};
```

Use the key `noirhaus.booking-recovery.v1`. Parse defensively, enforce the exact record shape, reject expired records, and catch local-storage exceptions. Store no form payload or PII.

- [ ] **Step 4: Persist and authenticate Checkout lifecycle calls**

In `booking.js`:

- Save recovery immediately after a successful create response and before opening Checkout.
- Include `created.resumeToken` in callback and dismissal reconciliation.
- Clear only on confirmed, payment_failed, expired, or cancelled.
- Redirect verified dismissal to `/booking-confirmed/?reference=...`; render expired as “Payment cancelled” with the approved copy.
- Preserve the record on 503, timeout, authorised, or payment_pending.

- [ ] **Step 5: Add same-browser resume UI**

On every booking-enabled page, load the active record and render one accessible banner:

```html
<aside class="noir-booking-recovery" role="status">
  <strong>Your room is still on hold</strong>
  <span>Resume secure payment before the hold expires, or cancel this attempt to release the room.</span>
  <button data-resume-booking>Resume secure payment</button>
  <button data-cancel-booking>Cancel this attempt</button>
</aside>
```

Resume calls the new proxy and opens the returned original order. Cancel calls token-bearing reconciliation. Disable both actions while a request is pending and use a live status region for errors. Remove the banner only after a terminal response.

- [ ] **Step 6: Load and style the helper**

Add `booking-recovery.js` before `booking.js` on:

- eight accommodation pages
- `book-now`
- `booking-confirmation`
- `booking-confirmed`

Add fixed-bottom desktop styling and full-width mobile styling to `runtime.css`. Preserve a single action set and WCAG-visible focus states.

- [ ] **Step 7: Keep canonical and deployed assets identical**

Run:

```bash
cmp scripts/public-site-assets/booking.js public/noir-haus-site/assets/booking.js
cmp scripts/public-site-assets/booking-recovery.js public/noir-haus-site/assets/booking-recovery.js
cmp scripts/public-site-assets/runtime.css public/noir-haus-site/assets/runtime.css
```

Expected: all commands exit 0.

- [ ] **Step 8: Run public tests**

Run:

```bash
npm test
npm run test:e2e
```

Expected: all unit tests and all mobile/tablet/desktop Playwright tests pass.

- [ ] **Step 9: Commit Task 6 in `noirhaus-public`**

```bash
git add src public/noir-haus-site scripts/public-site-assets e2e/public-booking.spec.ts
git commit -m "feat: resume abandoned Razorpay checkout"
```

### Task 7: Full Security and Regression Verification

**Files:**
- Test-only changes from Tasks 1–6

- [ ] **Step 1: Run full admin static verification**

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

Expected: all commands exit 0.

- [ ] **Step 2: Run full admin database verification**

```bash
TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/noirhaus_test \
TEST_SKIP_PGCRYPTO_EXTENSION=1 \
npm run test:db
```

Expected: all database-backed tests pass, including:

- modal dismissal → immediate release → same-date fresh booking
- tab return → same order and no second hold
- authorised/ambiguous → retained hold
- captured → amount-integrity confirmation
- late capture → one refund job

- [ ] **Step 3: Run full public verification**

```bash
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

Expected: all commands exit 0 and browser tests pass on mobile, tablet, and desktop.

- [ ] **Step 4: Inspect for secret or PII leakage**

Run:

```bash
rg -n "BOOKING_RESUME_ENCRYPTION_KEY|guestEmail|guestPhone|resumeToken" public src e2e
```

Verify manually:

- encryption key appears only in server-side admin code/tests/configuration
- resume token never appears in URLs, logs, analytics payloads, or static HTML
- local recovery record contains no guest PII

- [ ] **Step 5: Commit any verification-only corrections**

If verification required corrections, inspect `git status --short` and `git diff`,
stage only the files changed for those corrections, and commit them with:

```bash
git commit -m "test: verify checkout recovery lifecycle"
```

Skip this step when verification produced no further edits.

### Task 8: Preview Rollout, Production Promotion, and Live Verification

**Files:**
- No source changes unless verification reveals a defect.

- [ ] **Step 1: Generate and configure the encryption key**

Generate one 32-byte base64url secret without printing it into chat or logs. Add the same secret to admin Preview and Production as `BOOKING_RESUME_ENCRYPTION_KEY`. Do not configure it on the public project.

- [ ] **Step 2: Push both branches**

Push the admin branch, then the public branch. Record both commit SHAs.

- [ ] **Step 3: Deploy admin Preview first**

Allow the admin prebuild migration runner to apply migration 0010. Verify `/api/health` reports:

```json
{
  "status": "ok",
  "database": "ready",
  "bookingWorker": "fresh"
}
```

- [ ] **Step 4: Deploy public Preview**

Verify the public project talks to the Preview admin API with matching HMAC credentials and that create responses include a resume token.

- [ ] **Step 5: Run Razorpay Test Mode acceptance**

Use a future available Emraude date and verify:

1. X/Cancel → “Payment cancelled” → immediate rebooking available.
2. Close entire tab → reopen site → recovery banner → original order resumes.
3. Cancel recovered attempt → verified release → fresh booking allowed.
4. Successful captured test payment → booking confirmed, date blocked, email queued.
5. Provider-error simulation → hold retained and no second booking created.

- [ ] **Step 6: Promote in dependency order**

Promote the admin deployment to Production first. After it is Ready and healthy, promote the public deployment.

- [ ] **Step 7: Verify production without charging**

Create a future hold, close the Razorpay modal before entering payment details, and confirm:

- internal reconciliation returns 200
- booking becomes expired/payment_failed
- inventory releases within seconds
- recovery record clears
- same dates quote as available

Then create a second hold, close the whole tab, reopen, and confirm the original order resumes. Cancel it through the verified action so no test hold remains.

- [ ] **Step 8: Final evidence**

Report:

- admin and public commit SHAs
- production deployment URLs and Ready status
- migration 0010 applied
- admin health response
- unit, DB, build, and E2E pass counts
- live modal-cancel release result
- live tab-return same-order result
- confirmation that no active test hold remains
