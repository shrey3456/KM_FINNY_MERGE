CREATE TABLE "activities" (
	"id" serial PRIMARY KEY NOT NULL,
	"page_name" text NOT NULL,
	"action" text NOT NULL,
	"entity_type" text NOT NULL,
	"entity_id" text,
	"details" text,
	"user_code" text,
	"user_name" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "backup_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"last_backup_date" timestamp DEFAULT now(),
	"auto_backup_enabled" boolean DEFAULT true,
	"backup_frequency_hours" integer DEFAULT 24,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "load_operations_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"load_operations_id" integer,
	"product_id" integer,
	"quantity" integer DEFAULT 0,
	"original_quantity" integer,
	"extra_quantity" integer DEFAULT 0,
	"loaded_quantity" integer DEFAULT 0,
	"loaded" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"sr_no" text,
	"barcode" text,
	"item_name" text,
	"sr_no_display" text
);
--> statement-breakpoint
CREATE TABLE "load_operations_items_backup" (
	"id" serial PRIMARY KEY NOT NULL,
	"original_id" integer,
	"load_operations_id" integer,
	"product_id" integer,
	"quantity" integer DEFAULT 0,
	"original_quantity" integer,
	"extra_quantity" integer DEFAULT 0,
	"loaded_quantity" integer DEFAULT 0,
	"loaded" boolean DEFAULT false,
	"sr_no" text,
	"barcode" text,
	"item_name" text,
	"created_at" timestamp,
	"backup_date" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "load_operations" (
	"id" serial PRIMARY KEY NOT NULL,
	"status" text DEFAULT 'in progress',
	"reference_number" text,
	"party_name" text,
	"plant" text,
	"vehicle_number" text,
	"driver_name" text,
	"created_by_code" text,
	"created_at" timestamp DEFAULT now(),
	"completed_at" timestamp,
	"notes" text,
	"order_date" timestamp,
	"is_backed_up" boolean DEFAULT false
);
--> statement-breakpoint
CREATE TABLE "load_operations_backup" (
	"id" serial PRIMARY KEY NOT NULL,
	"original_id" integer,
	"status" text,
	"reference_number" text,
	"party_name" text,
	"plant" text,
	"vehicle_number" text,
	"driver_name" text,
	"created_by_id" integer,
	"created_at" timestamp,
	"completed_at" timestamp,
	"notes" text,
	"order_date" timestamp,
	"backup_date" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"sender_code" text NOT NULL,
	"recipient_code" text,
	"content" text NOT NULL,
	"is_read" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now(),
	"broadcast_to_all" boolean DEFAULT false,
	"broadcast_to_designation" text,
	"broadcast_to_department" text
);
--> statement-breakpoint
CREATE TABLE "order_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_id" integer NOT NULL,
	"product_id" integer,
	"sr_no" text,
	"name" text NOT NULL,
	"barcode" text,
	"quantity" integer DEFAULT 0 NOT NULL,
	"unit_price" text DEFAULT '0',
	"total_price" text,
	"category" text,
	"hsn" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_number" text NOT NULL,
	"dealer" text NOT NULL,
	"plant" text,
	"vehicle_number" text,
	"order_date" text DEFAULT '2026-02-03',
	"status" text DEFAULT 'DRAFT',
	"created_by_code" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	"notes" text,
	"sent_to_proforma" boolean DEFAULT false,
	"proforma_id" integer
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" serial PRIMARY KEY NOT NULL,
	"sr_no" text,
	"item_no" text,
	"barcode" text NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"volume_in_cu_ft" text,
	"hsn_code" text,
	"sap_code" text,
	"purchased" integer DEFAULT 0,
	"sold" integer DEFAULT 0,
	"in_stock" integer DEFAULT 0,
	"items_per_pallet" integer DEFAULT 0,
	"pallets" integer DEFAULT 0,
	"purchase_price" text,
	"selling_price" text,
	"last_updated" timestamp,
	"description" text,
	"status" text DEFAULT 'in stock',
	"created_by_code" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "products_barcode_unique" UNIQUE("barcode")
);
--> statement-breakpoint
CREATE TABLE "proforma_slip_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"proforma_slip_id" integer,
	"product_id" integer,
	"quantity" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now(),
	"sr_no" text,
	"item_no" text,
	"barcode" text,
	"item_name" text,
	"category" text,
	"volume_in_cu_ft" text,
	"hsn_code" text,
	"sap_code" text,
	"description" text,
	"purchase_price" text,
	"selling_price" text
);
--> statement-breakpoint
CREATE TABLE "proforma_slip_items_backup" (
	"id" serial PRIMARY KEY NOT NULL,
	"original_id" integer,
	"proforma_slip_id" integer,
	"proforma_slip_backup_id" integer,
	"product_id" integer,
	"quantity" integer,
	"sr_no" text,
	"barcode" text,
	"item_name" text,
	"created_at" timestamp,
	"backup_date" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "proforma_slips" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_date" date DEFAULT now(),
	"order_number" text NOT NULL,
	"party_name" text NOT NULL,
	"plant" text,
	"total_quantity" integer DEFAULT 0,
	"total_volume" text,
	"vehicle_number" text,
	"driver_name" text,
	"created_by_code" text,
	"created_at" timestamp DEFAULT now(),
	"notes" text,
	"is_backed_up" boolean DEFAULT false,
	"is_print_locked" boolean DEFAULT false,
	"printed_by_code" text,
	"printed_by_name" text,
	"printed_at" timestamp,
	"print_count" integer DEFAULT 0
);
--> statement-breakpoint
CREATE TABLE "proforma_slips_backup" (
	"id" serial PRIMARY KEY NOT NULL,
	"original_id" integer,
	"order_date" date,
	"order_number" text,
	"party_name" text,
	"plant" text,
	"total_quantity" integer,
	"total_volume" text,
	"vehicle_number" text,
	"driver_name" text,
	"created_by_id" integer,
	"created_at" timestamp,
	"notes" text,
	"backup_date" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "purchase_order_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"purchase_order_id" integer,
	"dealer_name" text NOT NULL,
	"vehicle_number" text,
	"driver_name" text,
	"product_id" integer,
	"product_code" text,
	"product_name" text,
	"barcode" text,
	"quantity" integer DEFAULT 0,
	"unit_price" text,
	"total_price" text,
	"notes" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_date" date NOT NULL,
	"delivery_date" date,
	"status" text DEFAULT 'pending',
	"total_items" integer DEFAULT 0,
	"total_dealers" integer DEFAULT 0,
	"notes" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	"created_by_code" text
);
--> statement-breakpoint
CREATE TABLE "purchases" (
	"id" serial PRIMARY KEY NOT NULL,
	"date" date DEFAULT now(),
	"item" text NOT NULL,
	"quantity" integer DEFAULT 0,
	"price_details" text,
	"notes" text,
	"user_code" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "scan_history" (
	"id" serial PRIMARY KEY NOT NULL,
	"barcode" text NOT NULL,
	"product_id" integer,
	"scanned_by_code" text,
	"scanned_at" timestamp DEFAULT now(),
	"action" text NOT NULL,
	"quantity" integer DEFAULT 1,
	"notes" text,
	"product_sku" text,
	"scanner_name" text,
	"scanner_department" text,
	"product_name" text,
	"is_backed_up" boolean DEFAULT false,
	"order_number" text
);
--> statement-breakpoint
CREATE TABLE "scan_history_backup" (
	"id" serial PRIMARY KEY NOT NULL,
	"original_id" integer,
	"barcode" text NOT NULL,
	"product_id" integer,
	"product_name" text,
	"product_sku" text,
	"scanned_by_code" text,
	"scanner_name" text,
	"scanner_department" text,
	"scanned_at" timestamp,
	"action" text,
	"quantity" integer,
	"notes" text,
	"backup_date" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "session" (
	"sid" text PRIMARY KEY NOT NULL,
	"sess" text NOT NULL,
	"expire" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"user_code" text PRIMARY KEY NOT NULL,
	"username" text NOT NULL,
	"pin" text NOT NULL,
	"name" text,
	"designation" text,
	"department" text,
	"role" text DEFAULT 'user',
	"profile_image" text,
	CONSTRAINT "users_username_unique" UNIQUE("username")
);
--> statement-breakpoint
CREATE TABLE "vehicle_info" (
	"id" serial PRIMARY KEY NOT NULL,
	"sr_no" integer NOT NULL,
	"rto_number" text NOT NULL,
	"vehicle_number" text NOT NULL,
	"last_edited_by_code" text,
	"last_edited_at" timestamp DEFAULT now(),
	"created_by_code" text,
	"created_at" timestamp DEFAULT now(),
	CONSTRAINT "vehicle_info_vehicle_number_unique" UNIQUE("vehicle_number")
);
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_user_code_users_user_code_fk" FOREIGN KEY ("user_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_operations_items" ADD CONSTRAINT "load_operations_items_load_operations_id_load_operations_id_fk" FOREIGN KEY ("load_operations_id") REFERENCES "public"."load_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_operations_items" ADD CONSTRAINT "load_operations_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_operations" ADD CONSTRAINT "load_operations_created_by_code_users_user_code_fk" FOREIGN KEY ("created_by_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_code_users_user_code_fk" FOREIGN KEY ("created_by_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_created_by_code_users_user_code_fk" FOREIGN KEY ("created_by_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proforma_slip_items" ADD CONSTRAINT "proforma_slip_items_proforma_slip_id_proforma_slips_id_fk" FOREIGN KEY ("proforma_slip_id") REFERENCES "public"."proforma_slips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proforma_slips" ADD CONSTRAINT "proforma_slips_created_by_code_users_user_code_fk" FOREIGN KEY ("created_by_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_code_users_user_code_fk" FOREIGN KEY ("created_by_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_user_code_users_user_code_fk" FOREIGN KEY ("user_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_history" ADD CONSTRAINT "scan_history_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_history" ADD CONSTRAINT "scan_history_scanned_by_code_users_user_code_fk" FOREIGN KEY ("scanned_by_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_info" ADD CONSTRAINT "vehicle_info_last_edited_by_code_users_user_code_fk" FOREIGN KEY ("last_edited_by_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_info" ADD CONSTRAINT "vehicle_info_created_by_code_users_user_code_fk" FOREIGN KEY ("created_by_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;