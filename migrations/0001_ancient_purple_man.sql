CREATE TABLE "plants" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"bg_color" text NOT NULL,
	"text_color" text NOT NULL,
	"border_color" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "orders" ALTER COLUMN "order_date" SET DEFAULT '2026-02-04';