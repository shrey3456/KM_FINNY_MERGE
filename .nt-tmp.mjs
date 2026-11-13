import dotenv from "dotenv"; dotenv.config();
import { Client } from "@notionhq/client";
const n = new Client({ auth: process.env.NOTION_INTEGRATION_SECRET.trim() });
const db = process.env.NOTION_AUTO_EXPENSES_DATABASE_ID.trim();
const count = async (filter) => { let c = 0, cur; do { const q = await n.databases.query({ database_id: db, filter, start_cursor: cur, page_size: 100 }); c += q.results.length; cur = q.has_more ? q.next_cursor : undefined; } while (cur); return c; };
console.log("KM2627-TV-  :", await count({ property: "Voucher No. :", title: { starts_with: "KM2627-TV-" } }));
console.log("KM2627-AEV- :", await count({ property: "Voucher No. :", title: { starts_with: "KM2627-AEV-" } }));
console.log("with Toll: > 0 :", await count({ property: "Toll:", number: { greater_than: 0 } }).catch(e => "n/a (" + e.code + ")"));
