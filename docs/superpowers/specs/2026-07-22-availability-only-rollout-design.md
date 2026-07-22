# Availability-only public rollout design

## Context

The public Noir Haus website reaches the signed internal API on
`noirhausadmin-booking-preview.vercel.app`. Property-level pricing and website
booking are configured for `Emeraude 603` under the fixed public slug
`emerald-suite`, but availability requests currently return
`503 {"error":"booking_disabled"}` before the property or iCal inventory is
queried. Razorpay, ZeptoMail, and the one-minute booking worker are not ready for
end-to-end booking tests.

## Goal

Allow the production public website to display authoritative availability and
nightly prices from the booking-preview admin while keeping booking creation and
payments disabled.

The existing public experience remains unchanged: a successful quote can show
an available room and price, the guest can open the normal booking form, and a
submission fails safely with the existing no-charge error until full Test Mode
booking is enabled.

## Non-goals

- Do not enable Razorpay or create payment orders.
- Do not create website holds or booking records during the availability test.
- Do not enable `PUBLIC_BOOKING_ENABLED`.
- Do not change public room slugs, prices, iCal parsing, or inventory rules.
- Do not change the public response contract or redeploy the public project.

## Design

Add an admin-only environment gate named `PUBLIC_AVAILABILITY_ENABLED`.

The internal availability route is enabled when either condition is true:

1. `PUBLIC_AVAILABILITY_ENABLED === "true"`; or
2. `PUBLIC_BOOKING_ENABLED === "true"`.

This makes the availability-only state explicit while ensuring that a future
full booking rollout automatically keeps availability enabled. When both flags
are false or absent, the route preserves the current fail-closed
`booking_disabled` response.

The internal booking-creation route continues to require
`PUBLIC_BOOKING_ENABLED === "true"`. With availability enabled and booking
disabled, guest submission is rejected before authentication, database writes,
holds, Razorpay calls, or email work.

The successful availability response remains unchanged, so the existing public
proxy and browser code require no modification.

## Configuration and deployment

Document `PUBLIC_AVAILABILITY_ENABLED=false` in `.env.example` and the Test Mode
runbook. Configure the Production environment of
`noirhausadmin-booking-preview` as follows:

```text
PUBLIC_AVAILABILITY_ENABLED=true
PUBLIC_BOOKING_ENABLED=false
```

Deploy only the booking-preview admin. The public project continues to use its
existing signed connection and production deployment.

## Error handling and safety

- Invalid or missing availability flag values fail closed.
- Missing property mapping, disabled property rates, capacity violations, and
  occupied inventory continue to use the existing admin error behavior.
- Booking creation remains disabled even when availability succeeds.
- Provider credentials and worker readiness are not prerequisites for quoting,
  because quoting performs no payment, email, or booking mutation.

## Verification

Automated tests must prove:

1. availability is rejected when both flags are false;
2. availability reaches the quote service when only
   `PUBLIC_AVAILABILITY_ENABLED` is true;
3. full booking enablement also enables availability;
4. booking creation remains rejected when only availability is enabled; and
5. existing authentication, schema, pricing, and inventory tests still pass.

Deployment verification must confirm:

- the admin production deployment is ready;
- an August 5–6, 2026 quote for `emerald-suite` no longer returns
  `booking_disabled`;
- the response contains the authoritative price and availability result; and
- a booking-create request still returns `booking_disabled` without creating a
  hold or payment.
