import { migratePostgresSubstrate } from "../../src/runtime/durable-store/postgres/migrate-substrate";

const dbUrl = process.argv[2];
if (!dbUrl) {
  console.error(
    "usage: nub scripts/local-orbstack/migrate-postgres.ts <postgres-url>"
  );
  process.exit(1);
}

await migratePostgresSubstrate(dbUrl);
console.log("migrated");
