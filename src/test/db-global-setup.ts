import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import postgres from "postgres";

function requireTestDatabaseUrl() {
  const url = process.env.TEST_DATABASE_URL;
  if (!url) {
    throw new Error("TEST_DATABASE_URL is required for database tests");
  }
  if (!/\b(noirhaus_test|localhost|127\.0\.0\.1)\b/.test(url)) {
    throw new Error("TEST_DATABASE_URL must target the isolated noirhaus_test database");
  }
  return url;
}

export default async function setupDatabase() {
  const sql = postgres(requireTestDatabaseUrl(), { max: 1, onnotice: () => undefined });
  const migrationsDir = path.join(process.cwd(), "supabase/migrations");

  try {
    await sql.unsafe("drop schema if exists public cascade");
    await sql.unsafe("drop schema if exists auth cascade");
    await sql.unsafe("create schema public");
    await sql.unsafe("create schema auth");

    const authFixture = await readFile(path.join(process.cwd(), "src/test/auth-fixture.sql"), "utf8");
    await sql.unsafe(authFixture);

    const migrations = (await readdir(migrationsDir))
      .filter((name) => /^\d+.*\.sql$/.test(name) && !name.endsWith(".down.sql"))
      .sort();

    for (const migration of migrations) {
      let source = await readFile(path.join(migrationsDir, migration), "utf8");
      if (process.env.TEST_SKIP_PGCRYPTO_EXTENSION === "1") {
        source = source.replace(/create extension if not exists pgcrypto;\s*/i, "");
      }
      await sql.begin(async (transaction) => {
        await transaction.unsafe(source);
      });
    }
  } finally {
    await sql.end();
  }
}
