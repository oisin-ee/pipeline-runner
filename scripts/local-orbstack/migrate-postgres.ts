import { migratePostgresSubstrate } from "../../src/runtime/durable-store/postgres/migrate-substrate";

const [dbUrl] = process.argv.slice(2);
if (!dbUrl) {
  process.stderr.write(
    "usage: nub scripts/local-orbstack/migrate-postgres.ts <postgres-url>\n"
  );
  process.exit(1);
}

await migratePostgresSubstrate(dbUrl);
process.stdout.write("migrated\n");
