ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "role" TEXT NOT NULL DEFAULT 'user';

ALTER TABLE "User"
  ADD COLUMN IF NOT EXISTS "disabled" BOOLEAN NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS "audit_log" (
  "id" TEXT NOT NULL,
  "ts" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "actor_user_id" TEXT,
  "actor_email" TEXT,
  "action" TEXT NOT NULL,
  "target_type" TEXT,
  "target_id" TEXT,
  "payload_json" JSONB,
  "result" TEXT NOT NULL,
  "ip" TEXT,
  CONSTRAINT "audit_log_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "audit_log_actor_user_id_idx" ON "audit_log"("actor_user_id");
CREATE INDEX IF NOT EXISTS "audit_log_action_idx" ON "audit_log"("action");
CREATE INDEX IF NOT EXISTS "audit_log_ts_idx" ON "audit_log"("ts");

CREATE TABLE IF NOT EXISTS "admin_config" (
  "key" TEXT NOT NULL,
  "value_json" JSONB NOT NULL,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_by" TEXT,
  CONSTRAINT "admin_config_pkey" PRIMARY KEY ("key")
);

CREATE INDEX IF NOT EXISTS "admin_config_updated_at_idx" ON "admin_config"("updated_at");
