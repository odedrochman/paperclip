CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"guild_id" uuid NOT NULL,
	"company_id" uuid NOT NULL,
	"name" text NOT NULL,
	"body" text NOT NULL,
	"provenance" text DEFAULT 'provisional' NOT NULL,
	"created_by_run_id" uuid,
	"success_count" integer DEFAULT 0 NOT NULL,
	"fail_count" integer DEFAULT 0 NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agents" ADD COLUMN "kind" text DEFAULT 'agent' NOT NULL;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_guild_id_agents_id_fk" FOREIGN KEY ("guild_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_company_id_companies_id_fk" FOREIGN KEY ("company_id") REFERENCES "public"."companies"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skills" ADD CONSTRAINT "skills_created_by_run_id_heartbeat_runs_id_fk" FOREIGN KEY ("created_by_run_id") REFERENCES "public"."heartbeat_runs"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "skills_guild_idx" ON "skills" USING btree ("guild_id");--> statement-breakpoint
CREATE INDEX "skills_company_idx" ON "skills" USING btree ("company_id");--> statement-breakpoint
CREATE INDEX "skills_guild_provenance_idx" ON "skills" USING btree ("guild_id","provenance");--> statement-breakpoint
CREATE INDEX "skills_guild_name_idx" ON "skills" USING btree ("guild_id","name");