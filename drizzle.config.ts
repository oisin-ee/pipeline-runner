import { defineConfig } from "drizzle-kit";

// PIPE-91.4 / PIPE-91.11: drizzle-kit config for the Postgres stores. Generates
// the SQL migrations from the declarative schemas into one shared folder, so a
// single migrator run (drizzle-orm/postgres-js, idempotent + content-hash
// tracked) provisions both the durable store and the run-control store inside
// the dedicated moka schema.
export default defineConfig({
  dialect: "postgresql",
  out: "./src/runtime/durable-store/postgres/migrations",
  schema: [
    "./src/runtime/durable-store/postgres/schema.ts",
    "./src/run-control/postgres/schema.ts",
  ],
  schemaFilter: ["moka"],
});
