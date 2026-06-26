import { defineConfig } from "drizzle-kit";

// PIPE-91.4: drizzle-kit config for the Postgres DurableRunStore. Generates the
// SQL migrations from the declarative schema; the runtime applies them via the
// drizzle-orm/postgres-js migrator (idempotent, content-hash tracked).
export default defineConfig({
  dialect: "postgresql",
  out: "./src/runtime/durable-store/postgres/migrations",
  schema: "./src/runtime/durable-store/postgres/schema.ts",
});
