ALTER TABLE "orders" ALTER COLUMN "order_date" SET DEFAULT '2026-02-07';--> statement-breakpoint
ALTER TABLE "plants" ADD COLUMN "is_locking_enabled" boolean DEFAULT true;