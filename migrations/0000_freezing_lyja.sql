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
CREATE TABLE "order_import_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"barcode" text,
	"item_name" text,
	"sap_code" text,
	"quantity" integer DEFAULT 0,
	"expected_pallets" real,
	"date" text,
	"plant" text,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "order_import_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"plant" text NOT NULL,
	"csv_file_name" text NOT NULL,
	"row_count" integer DEFAULT 0,
	"imported_by_code" text,
	"created_at" timestamp DEFAULT now(),
	"scan_status" text DEFAULT 'available',
	"scan_activated_by_code" text,
	"scan_activated_at" timestamp,
	"scan_completed_at" timestamp,
	"order_date" text,
	"receiving_session_id" integer,
	"part_index" integer,
	"stock_applied_at" timestamp,
	"is_deleted" boolean DEFAULT false NOT NULL,
	"deleted_at" timestamp,
	"deleted_by_code" text,
	"remapped_to_session_id" integer,
	"remapped_at" timestamp,
	"replaces_session_id" integer
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
CREATE TABLE "order_scan_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"scan_item_id" integer,
	"barcode" text NOT NULL,
	"item_name" text,
	"pallets" real DEFAULT 0,
	"loose_qty" integer DEFAULT 0,
	"total_qty" integer DEFAULT 0,
	"items_per_pallet" integer DEFAULT 0,
	"is_extra" boolean DEFAULT false,
	"stv" text,
	"scanned_by_code" text,
	"scanned_by_name" text,
	"scanned_at" timestamp DEFAULT now(),
	"notion_synced_at" timestamp with time zone,
	"voided" boolean DEFAULT false,
	"voided_by_code" text,
	"voided_at" timestamp,
	"void_reason" text,
	"credited_qty" integer DEFAULT 0,
	"is_credit" boolean DEFAULT false,
	"credit_source_event_id" integer
);
--> statement-breakpoint
CREATE TABLE "order_scan_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"order_import_item_id" integer,
	"barcode" text,
	"item_name" text,
	"sap_code" text,
	"expected_qty" integer DEFAULT 0,
	"items_per_pallet" integer DEFAULT 0,
	"scanned_pallets" real DEFAULT 0,
	"scanned_loose_qty" integer DEFAULT 0,
	"total_scanned_qty" integer DEFAULT 0,
	"status" text DEFAULT 'pending',
	"last_scanned_at" timestamp,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "orders" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_number" text NOT NULL,
	"dealer" text NOT NULL,
	"plant" text,
	"vehicle_number" text,
	"order_date" text DEFAULT (CURRENT_DATE)::text,
	"status" text DEFAULT 'DRAFT',
	"created_by_code" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now(),
	"notes" text,
	"sent_to_proforma" boolean DEFAULT false,
	"proforma_id" integer
);
--> statement-breakpoint
CREATE TABLE "plant_stvs" (
	"id" serial PRIMARY KEY NOT NULL,
	"plant_id" integer,
	"stv" text NOT NULL,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "plants" (
	"id" serial PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"bg_color" text NOT NULL,
	"text_color" text NOT NULL,
	"border_color" text NOT NULL,
	"is_locking_enabled" boolean DEFAULT true,
	"is_split_pages_enabled" boolean DEFAULT false,
	"is_auto_complete_enabled" boolean DEFAULT false,
	"is_auto_scan_enabled" boolean DEFAULT false,
	"created_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "product_plant_stock" (
	"id" serial PRIMARY KEY NOT NULL,
	"barcode" text NOT NULL,
	"plant" text NOT NULL,
	"in_stock" integer DEFAULT 0 NOT NULL,
	"extra_qty" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp DEFAULT now(),
	CONSTRAINT "uq_product_plant_stock_barcode_plant" UNIQUE("barcode","plant")
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" serial PRIMARY KEY NOT NULL,
	"new_sr" text,
	"item_no" text,
	"barcode" text NOT NULL,
	"name" text NOT NULL,
	"notion_wise_name" text,
	"brand" text,
	"category" text,
	"sale_category" text,
	"plant" text,
	"type" text,
	"product_image" text,
	"product_image_hash" text,
	"notion_page_id" text,
	"volume_in_cu_ft" text,
	"items_per_pallet" integer DEFAULT 0,
	"pallets" integer DEFAULT 0,
	"ind_plt" integer,
	"val_plt" integer,
	"purchased" integer DEFAULT 0,
	"sold" integer DEFAULT 0,
	"in_stock" integer DEFAULT 0,
	"gj_sr" text,
	"gj_hsn" text,
	"gj_sap" text,
	"gj_sale_rate" text,
	"gj_igst" text,
	"gj_ga_pur" text,
	"gj_mh_pur" text,
	"gj_nagar_pur" text,
	"for_gj_order_form" text,
	"mp_sr" text,
	"mp_hsn" text,
	"mp_sap" text,
	"mp_jh_pur" text,
	"mp_mh_pur" text,
	"mp_mp_pur_jabalpur" text,
	"mp_mp_pur_khargone" text,
	"mp_wb_pur" text,
	"sale_mp_jh" text,
	"sale_mp_mh" text,
	"sale_mp_mp" text,
	"mp_jh_igst" text,
	"mp_mh_igst" text,
	"mp_mp_cgst" text,
	"mp_mp_sgst" text,
	"mp_wb_igst" text,
	"mp_wb_sale" text,
	"for_mp_order_form" text,
	"up_sr" text,
	"up_hsn" text,
	"up_sap" text,
	"up_rate" text,
	"up_igst" text,
	"for_up_order_form" text,
	"hsn_code" text,
	"sap_code" text,
	"purchase_price" text,
	"selling_price" text,
	"last_updated" timestamp,
	"last_changed_by" text,
	"description" text,
	"status" text DEFAULT 'in stock',
	"created_by_code" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
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
CREATE TABLE "scan_session_extras" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"code" text NOT NULL,
	"item_name" text NOT NULL,
	"sku" text,
	"product_id" integer,
	"quantity" integer DEFAULT 0,
	"reason" text NOT NULL,
	"scanned_by_code" text,
	"scanned_by_name" text,
	"scanned_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "scan_session_items" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"sku" text NOT NULL,
	"item_name" text NOT NULL,
	"barcode" text,
	"item_no" text,
	"sap_code" text,
	"product_id" integer,
	"expected_qty" integer DEFAULT 0,
	"scanned_qty" integer DEFAULT 0,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "scan_session_pallet_scans" (
	"id" serial PRIMARY KEY NOT NULL,
	"session_id" integer NOT NULL,
	"session_item_id" integer,
	"barcode" text NOT NULL,
	"sku" text,
	"item_name" text NOT NULL,
	"product_id" integer,
	"pallet_number" integer NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"num_pallets" real,
	"is_extra" boolean DEFAULT false,
	"stv" text,
	"scanned_by_code" text,
	"scanned_by_name" text,
	"scanned_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "scan_sessions" (
	"id" serial PRIMARY KEY NOT NULL,
	"order_name" text NOT NULL,
	"csv_name" text NOT NULL,
	"plant" text,
	"stv" text,
	"mapped_column" text NOT NULL,
	"status" text DEFAULT 'scanning',
	"created_by_code" text,
	"created_by_name" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE "session" (
	"sid" text PRIMARY KEY NOT NULL,
	"sess" text NOT NULL,
	"expire" timestamp NOT NULL
);
--> statement-breakpoint
CREATE TABLE "stock_movements" (
	"id" serial PRIMARY KEY NOT NULL,
	"barcode" text NOT NULL,
	"plant" text NOT NULL,
	"qty" integer NOT NULL,
	"extra_qty" integer DEFAULT 0,
	"type" text NOT NULL,
	"reason" text,
	"session_id" integer,
	"created_by_code" text,
	"created_at" timestamp DEFAULT now()
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
	"plants" text DEFAULT '[]',
	"allowed_pages" text DEFAULT '[]',
	"page_write_access" text DEFAULT '[]',
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
CREATE TABLE "voucher_prefixes" (
	"id" serial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"prefix" text NOT NULL,
	"updated_by" text,
	"created_at" timestamp DEFAULT now(),
	"updated_at" timestamp DEFAULT now()
);
--> statement-breakpoint
ALTER TABLE "activities" ADD CONSTRAINT "activities_user_code_users_user_code_fk" FOREIGN KEY ("user_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_operations_items" ADD CONSTRAINT "load_operations_items_load_operations_id_load_operations_id_fk" FOREIGN KEY ("load_operations_id") REFERENCES "public"."load_operations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_operations_items" ADD CONSTRAINT "load_operations_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "load_operations" ADD CONSTRAINT "load_operations_created_by_code_users_user_code_fk" FOREIGN KEY ("created_by_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_import_items" ADD CONSTRAINT "order_import_items_session_id_order_import_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."order_import_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_import_sessions" ADD CONSTRAINT "order_import_sessions_imported_by_code_users_user_code_fk" FOREIGN KEY ("imported_by_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_import_sessions" ADD CONSTRAINT "order_import_sessions_scan_activated_by_code_users_user_code_fk" FOREIGN KEY ("scan_activated_by_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_import_sessions" ADD CONSTRAINT "order_import_sessions_deleted_by_code_users_user_code_fk" FOREIGN KEY ("deleted_by_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_order_id_orders_id_fk" FOREIGN KEY ("order_id") REFERENCES "public"."orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_items" ADD CONSTRAINT "order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_scan_events" ADD CONSTRAINT "order_scan_events_session_id_order_import_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."order_import_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_scan_events" ADD CONSTRAINT "order_scan_events_scan_item_id_order_scan_items_id_fk" FOREIGN KEY ("scan_item_id") REFERENCES "public"."order_scan_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_scan_events" ADD CONSTRAINT "order_scan_events_scanned_by_code_users_user_code_fk" FOREIGN KEY ("scanned_by_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_scan_events" ADD CONSTRAINT "order_scan_events_voided_by_code_users_user_code_fk" FOREIGN KEY ("voided_by_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_scan_items" ADD CONSTRAINT "order_scan_items_session_id_order_import_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."order_import_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "order_scan_items" ADD CONSTRAINT "order_scan_items_order_import_item_id_order_import_items_id_fk" FOREIGN KEY ("order_import_item_id") REFERENCES "public"."order_import_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "orders" ADD CONSTRAINT "orders_created_by_code_users_user_code_fk" FOREIGN KEY ("created_by_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "plant_stvs" ADD CONSTRAINT "plant_stvs_plant_id_plants_id_fk" FOREIGN KEY ("plant_id") REFERENCES "public"."plants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_created_by_code_users_user_code_fk" FOREIGN KEY ("created_by_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proforma_slip_items" ADD CONSTRAINT "proforma_slip_items_proforma_slip_id_proforma_slips_id_fk" FOREIGN KEY ("proforma_slip_id") REFERENCES "public"."proforma_slips"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "proforma_slips" ADD CONSTRAINT "proforma_slips_created_by_code_users_user_code_fk" FOREIGN KEY ("created_by_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_order_items" ADD CONSTRAINT "purchase_order_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_created_by_code_users_user_code_fk" FOREIGN KEY ("created_by_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchases" ADD CONSTRAINT "purchases_user_code_users_user_code_fk" FOREIGN KEY ("user_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_history" ADD CONSTRAINT "scan_history_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_history" ADD CONSTRAINT "scan_history_scanned_by_code_users_user_code_fk" FOREIGN KEY ("scanned_by_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_session_extras" ADD CONSTRAINT "scan_session_extras_session_id_scan_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."scan_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_session_extras" ADD CONSTRAINT "scan_session_extras_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_session_items" ADD CONSTRAINT "scan_session_items_session_id_scan_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."scan_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_session_items" ADD CONSTRAINT "scan_session_items_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_session_pallet_scans" ADD CONSTRAINT "scan_session_pallet_scans_session_id_scan_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."scan_sessions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_session_pallet_scans" ADD CONSTRAINT "scan_session_pallet_scans_session_item_id_scan_session_items_id_fk" FOREIGN KEY ("session_item_id") REFERENCES "public"."scan_session_items"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_session_pallet_scans" ADD CONSTRAINT "scan_session_pallet_scans_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_session_pallet_scans" ADD CONSTRAINT "scan_session_pallet_scans_scanned_by_code_users_user_code_fk" FOREIGN KEY ("scanned_by_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "scan_sessions" ADD CONSTRAINT "scan_sessions_created_by_code_users_user_code_fk" FOREIGN KEY ("created_by_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_info" ADD CONSTRAINT "vehicle_info_last_edited_by_code_users_user_code_fk" FOREIGN KEY ("last_edited_by_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "vehicle_info" ADD CONSTRAINT "vehicle_info_created_by_code_users_user_code_fk" FOREIGN KEY ("created_by_code") REFERENCES "public"."users"("user_code") ON DELETE no action ON UPDATE no action;