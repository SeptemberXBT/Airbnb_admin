# Razorpay Amount Integrity Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove browser-controlled Checkout amounts and require independent four-way captured-payment amount verification before booking confirmation.

**Architecture:** Razorpay order and payment evidence will be fetched server-side for every captured attempt. The reconciliation service will combine that evidence with a locked booking row and immutable nightly-price sum; failures will be persisted and alerted without changing the booking.

**Tech Stack:** Next.js 16, TypeScript, Razorpay Standard Checkout/API, PostgreSQL/Supabase, Vitest, Playwright.

---

### Task 1: Browser Checkout contract

**Files:**
- Modify: `/Users/retyush/noirhaus-public/e2e/public-booking.spec.ts`
- Modify: `/Users/retyush/noirhaus-public/public/noir-haus-site/assets/booking.js`

- [ ] Change the Playwright assertion to require `key` and `order_id` while asserting that `amount` and `currency` are absent.
- [ ] Run the test and confirm it fails because the current Checkout object contains both forbidden fields.
- [ ] Remove `amount` and `currency` from the Checkout options object.
- [ ] Re-run the public booking test and confirm it passes.

### Task 2: Razorpay order retrieval

**Files:**
- Modify: `src/features/payments/razorpay-client.test.ts`
- Modify: `src/features/payments/razorpay-client.ts`

- [ ] Add a failing adapter test requiring `fetchOrder("order_match")` to request `/v1/orders/order_match` and parse a complete INR order.
- [ ] Run the adapter test and confirm `fetchOrder` is missing.
- [ ] Add `fetchOrder(orderId)` using the existing authenticated request and `parseOrder`.
- [ ] Re-run the adapter test and confirm it passes.

### Task 3: Captured-payment integrity regression

**Files:**
- Modify: `src/features/payments/payment-reconciliation.db.test.ts`
- Modify: `src/features/payments/razorpay-webhook.test.ts`
- Modify: `src/features/email/templates.ts`
- Modify: `src/features/payments/payment-reconciliation.ts`
- Modify: `src/features/bookings/job-runner.ts`

- [ ] Extend reconciliation fixtures with immutable nightly-price rows and complete Razorpay order/payment test doubles.
- [ ] Add a correctly signed captured-webhook regression where payment, order, and booking are one paise but nightly rows have a higher total.
- [ ] Assert the test leaves the booking held, preserves inventory, records `AMOUNT_INTEGRITY_FAILURE`, queues one admin alert, marks the webhook ignored, and calls provider order/payment lookup for each captured attempt.
- [ ] Run the DB test against isolated PostgreSQL and confirm it fails by reaching confirmation.
- [ ] Add the admin integrity-alert email template.
- [ ] Add centralized captured-evidence verification and remove the key-ID conditional provider shortcut.
- [ ] Persist terminal integrity failures outside the confirmation transaction and prevent worker retry conversion.
- [ ] Re-run the regression and existing payment DB tests until all pass.

### Task 4: Full verification

**Files:**
- Verify all modified files in both repositories.

- [ ] Start an isolated PostgreSQL instance on port 55432 with database `noirhaus_test`.
- [ ] Run `npm test` for payment, webhook, quote, schema, and email tests.
- [ ] Run `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:55432/noirhaus_test TEST_SKIP_PGCRYPTO_EXTENSION=1 npm run test:db`.
- [ ] Run the public unit suite and `npm run test:e2e -- e2e/public-booking.spec.ts`.
- [ ] Run typecheck, lint, and `git diff --check` in both repositories.
- [ ] Review the final diff against every requested invariant and report exact commands, counts, and failures.

