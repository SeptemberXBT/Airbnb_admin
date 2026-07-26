import "server-only";

import { getDb } from "@/lib/db/client";
import {
  createPaymentReconciliationService,
  PaymentReconciliationService,
  ReconciliationTrigger,
} from "@/features/payments/payment-reconciliation";
import { createRazorpayClient } from "@/features/payments/razorpay-client";
import { createBookingResumeService } from "./booking-resume-service";

type ResumeTokens = ReturnType<typeof createBookingResumeService>;
type Reconciliation = Pick<
  PaymentReconciliationService,
  "reconcileBooking"
>;

export function createBookingRecoveryService(dependencies: {
  resumeTokens: ResumeTokens;
  reconciliation: Reconciliation;
}) {
  async function reconcile(
    reference: string,
    rawToken: string,
    trigger: ReconciliationTrigger,
  ) {
    await dependencies.resumeTokens.authorize(reference, rawToken);
    return dependencies.reconciliation.reconcileBooking(reference, trigger);
  }

  return {
    async resume(reference: string, rawToken: string) {
      const authorization = await dependencies.resumeTokens.authorize(
        reference,
        rawToken,
      );
      const state = await dependencies.reconciliation.reconcileBooking(
        reference,
        "resume",
      );
      if (["processing", "held"].includes(state.status)) {
        return {
          kind: "resumable" as const,
          bookingReference: authorization.publicReference,
          orderId: authorization.razorpayOrderId,
          razorpayKeyId: authorization.razorpayKeyId,
          holdExpiresAt: authorization.holdExpiresAt.toISOString(),
        };
      }
      return state;
    },

    cancel(reference: string, rawToken: string) {
      return reconcile(reference, rawToken, "checkout_dismissed");
    },

    reconcile(
      reference: string,
      rawToken: string,
      trigger: Extract<ReconciliationTrigger, "client_callback" | "checkout_dismissed">,
    ) {
      return reconcile(reference, rawToken, trigger);
    },
  };
}

function requiredRecoveryEnvironment(name: string) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error("BOOKING_RECOVERY_NOT_CONFIGURED");
  return value;
}

export function configuredBookingRecoveryService() {
  const sql = getDb();
  const keyId = requiredRecoveryEnvironment("RAZORPAY_KEY_ID");
  const keySecret = requiredRecoveryEnvironment("RAZORPAY_KEY_SECRET");
  const resumeEncryptionKey = requiredRecoveryEnvironment(
    "BOOKING_RESUME_ENCRYPTION_KEY",
  );
  const razorpay = createRazorpayClient({ keyId, keySecret });
  return createBookingRecoveryService({
    resumeTokens: createBookingResumeService(sql, {
      encryptionKey: resumeEncryptionKey,
    }),
    reconciliation: createPaymentReconciliationService(sql, { razorpay }),
  });
}
