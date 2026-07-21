import "server-only";
import postgres from "postgres";

let client: ReturnType<typeof postgres> | undefined;

export function getDb() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not configured");
  client ??= postgres(url, {
    max: 8,
    idle_timeout: 20,
    connect_timeout: 10,
    prepare: false,
  });
  return client;
}
