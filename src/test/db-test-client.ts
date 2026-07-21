import postgres from "postgres";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
if (!testDatabaseUrl) {
  throw new Error("TEST_DATABASE_URL is required for database tests");
}

export const testSql = postgres(testDatabaseUrl, {
  max: 10,
  onnotice: () => undefined,
});

export async function resetDb() {
  const tables = await testSql<{ schemaname: string; tablename: string }[]>`
    select schemaname, tablename
    from pg_tables
    where schemaname in ('public', 'auth')
    order by schemaname, tablename
  `;

  if (tables.length === 0) return;

  const qualifiedTables = tables
    .map(({ schemaname, tablename }) => {
      const schema = schemaname.replaceAll('"', '""');
      const table = tablename.replaceAll('"', '""');
      return `"${schema}"."${table}"`;
    })
    .join(", ");

  await testSql.unsafe(`truncate table ${qualifiedTables} restart identity cascade`);
}
