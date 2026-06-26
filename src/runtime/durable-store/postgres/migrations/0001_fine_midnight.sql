CREATE TABLE "moka_run_control_event" (
	"event" jsonb NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" text NOT NULL,
	"seq" bigserial PRIMARY KEY NOT NULL
);
--> statement-breakpoint
CREATE TABLE "moka_run_control_node_artifact" (
	"content" text NOT NULL,
	"content_type" text,
	"name" text NOT NULL,
	"node_id" text NOT NULL,
	"recorded_at" timestamp with time zone DEFAULT now() NOT NULL,
	"run_id" text NOT NULL,
	CONSTRAINT "moka_run_control_node_artifact_run_id_node_id_name_pk" PRIMARY KEY("run_id","node_id","name")
);
--> statement-breakpoint
CREATE TABLE "moka_run_control_node_session" (
	"node_id" text NOT NULL,
	"run_id" text NOT NULL,
	"session_id" text NOT NULL,
	CONSTRAINT "moka_run_control_node_session_run_id_node_id_pk" PRIMARY KEY("run_id","node_id")
);
--> statement-breakpoint
CREATE TABLE "moka_run_control_run" (
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"manifest" jsonb NOT NULL,
	"run_id" text PRIMARY KEY NOT NULL
);
--> statement-breakpoint
ALTER TABLE "moka_run_control_event" ADD CONSTRAINT "moka_run_control_event_run_id_moka_run_control_run_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."moka_run_control_run"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moka_run_control_node_artifact" ADD CONSTRAINT "moka_run_control_node_artifact_run_id_moka_run_control_run_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."moka_run_control_run"("run_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "moka_run_control_node_session" ADD CONSTRAINT "moka_run_control_node_session_run_id_moka_run_control_run_run_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."moka_run_control_run"("run_id") ON DELETE no action ON UPDATE no action;