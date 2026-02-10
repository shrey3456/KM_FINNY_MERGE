ALTER TABLE "orders" ALTER COLUMN "order_date" SET DEFAULT '2026-02-08';--> statement-breakpoint
ALTER TABLE "plants" ADD COLUMN "is_split_pages_enabled" boolean DEFAULT false;