CREATE TABLE "moka_durable_node_record" (
	"criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"inputs" jsonb,
	"node_id" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"result" jsonb NOT NULL,
	"run_id" text NOT NULL,
	"status" text NOT NULL,
	CONSTRAINT "moka_durable_node_record_run_id_node_id_pk" PRIMARY KEY("run_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "moka_durable_run" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "moka_durable_node_record" ADD CONSTRAINT "moka_durable_node_record_run_id_moka_durable_run_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."moka_durable_run"("run_id") ON DELETE no action ON UPDATE no action;