import "server-only";

import { timingSafeEqual } from "node:crypto";
import type postgres from "postgres";

import { createResumeTokenCipher } from "./booking-resume-token";

export type BookingResumeAuthorization = {
  bookingId: string;
  propertyId: string;
  publicReference: string;
  status: string;
  holdExpiresAt: Date;
  razorpayOrderId: string;
  razorpayKeyId: string;
};

export class BookingResumeServiceError extends Error {
  constructor(
    public readonly code: string,
    public readonly httpStatus: number,
  ) {
    super(code);
    this.name = "BookingResumeServiceError";
  }
}

type ResumeRow = {
  booking_id: string;
  property_id: string;
  public_reference: string;
  status: string;
  hold_expires_at: Date | null;
  razorpay_order_id: string | null;
  razorpay_key_id: string | null;
  token_hash: string;
  token_ciphertext: string;
  expires_at: Date;
  revoked_at: Date | null;
};

function equalHash(left: string, right: string) {
  const leftBytes = Buffer.from(left, "hex");
  const rightBytes = Buffer.from(right, "hex");
  return (
    leftBytes.length === rightBytes.length
    && timingSafeEqual(leftBytes, rightBytes)
  );
}

export function createBookingResumeService(
  sql: postgres.Sql,
  options: { encryptionKey: string; clock?: () => Date },
) {
  const clock = options.clock ?? (() => new Date());
  const cipher = createResumeTokenCipher(options.encryptionKey);

  async function loadByReference(reference: string) {
    const [row] = await sql<ResumeRow[]>`
      select
        t.booking_id,
        b.property_id,
        b.public_reference,
        b.status,
        b.hold_expires_at,
        b.razorpay_order_id,
        b.razorpay_key_id,
        t.token_hash,
        t.token_ciphertext,
        t.expires_at,
        t.revoked_at
      from public.booking_resume_tokens t
      join public.bookings b on b.id = t.booking_id
      where b.public_reference = ${reference}
    `;
    return row ?? null;
  }

  async function reveal(bookingId: string) {
    const [row] = await sql<{
      token_ciphertext: string;
      expires_at: Date;
      revoked_at: Date | null;
    }[]>`
      select token_ciphertext, expires_at, revoked_at
      from public.booking_resume_tokens
      where booking_id = ${bookingId}
    `;
    if (!row) {
      throw new BookingResumeServiceError(
        "BOOKING_RESUME_TOKEN_INVALID",
        401,
      );
    }
    if (row.revoked_at) {
      throw new BookingResumeServiceError(
        "BOOKING_RESUME_TOKEN_REVOKED",
        409,
      );
    }
    if (new Date(row.expires_at).getTime() <= clock().getTime()) {
      throw new BookingResumeServiceError(
        "BOOKING_RESUME_TOKEN_EXPIRED",
        409,
      );
    }
    return cipher.decrypt(row.token_ciphertext);
  }

  return {
    async issue(bookingId: string, expiresAt: Date) {
      const createdAt = clock();
      if (expiresAt.getTime() <= createdAt.getTime()) {
        throw new BookingResumeServiceError(
          "BOOKING_RESUME_TOKEN_EXPIRED",
          409,
        );
      }
      const token = cipher.generate();
      await sql`
        insert into public.booking_resume_tokens (
          booking_id,
          token_hash,
          token_ciphertext,
          expires_at,
          created_at,
          updated_at
        ) values (
          ${bookingId},
          ${cipher.hash(token)},
          ${cipher.encrypt(token)},
          ${expiresAt},
          ${createdAt},
          ${createdAt}
        )
        on conflict (booking_id) do nothing
      `;
      return reveal(bookingId);
    },

    reveal,

    async authorize(
      reference: string,
      rawToken: string,
      now = clock(),
    ): Promise<BookingResumeAuthorization> {
      const row = await loadByReference(reference);
      if (!row || !equalHash(row.token_hash, cipher.hash(rawToken))) {
        throw new BookingResumeServiceError(
          "BOOKING_RESUME_TOKEN_INVALID",
          401,
        );
      }
      if (row.revoked_at) {
        throw new BookingResumeServiceError(
          "BOOKING_RESUME_TOKEN_REVOKED",
          409,
        );
      }
      if (
        new Date(row.expires_at).getTime() <= now.getTime()
        || !row.hold_expires_at
        || new Date(row.hold_expires_at).getTime() <= now.getTime()
      ) {
        throw new BookingResumeServiceError(
          "BOOKING_RESUME_TOKEN_EXPIRED",
          409,
        );
      }
      if (!row.razorpay_order_id || !row.razorpay_key_id) {
        throw new BookingResumeServiceError(
          "BOOKING_RESUME_NOT_AVAILABLE",
          409,
        );
      }
      return {
        bookingId: row.booking_id,
        propertyId: row.property_id,
        publicReference: row.public_reference,
        status: row.status,
        holdExpiresAt: new Date(row.hold_expires_at),
        razorpayOrderId: row.razorpay_order_id,
        razorpayKeyId: row.razorpay_key_id,
      };
    },

    async revoke(
      tx: postgres.Sql,
      bookingId: string,
      at = clock(),
    ) {
      await tx`
        update public.booking_resume_tokens
        set revoked_at = coalesce(revoked_at, ${at}), updated_at = ${at}
        where booking_id = ${bookingId}
      `;
    },
  };
}
