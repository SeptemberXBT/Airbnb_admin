import { afterEach, describe, expect, it, vi } from "vitest";

const postgres = vi.hoisted(() => vi.fn(() => ({ connected: true })));

vi.mock("postgres", () => ({ default: postgres }));

import { getDb } from "./client";

describe("database client", () => {
  const originalDatabaseUrl = process.env.DATABASE_URL;

  afterEach(() => {
    postgres.mockClear();
    if (originalDatabaseUrl === undefined) delete process.env.DATABASE_URL;
    else process.env.DATABASE_URL = originalDatabaseUrl;
  });

  it("disables prepared statements for Supabase transaction pooling", () => {
    process.env.DATABASE_URL = "postgres://preview.example/postgres";

    getDb();

    expect(postgres).toHaveBeenCalledWith(
      process.env.DATABASE_URL,
      expect.objectContaining({ prepare: false }),
    );
  });
});
