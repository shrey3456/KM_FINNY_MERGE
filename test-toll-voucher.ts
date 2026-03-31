import { Client } from '@notionhq/client';
import dotenv from 'dotenv';
dotenv.config();

const notion = new Client({
  auth: process.env.NOTION_INTEGRATION_SECRET,
});

async function run() {
  const EXPENSE_VOUCHER_DATABASE_ID = '173604c4adf080f7853dc9a41a8a69a9';
  console.log("Testing Toll Notion Query with filter...");
  try {
    const res = await notion.databases.query({
      database_id: EXPENSE_VOUCHER_DATABASE_ID,
      filter: { property: 'Voucher No. :', title: { equals: 'TEST1234' } },
      page_size: 1
    });
    console.log("Success! Found:", res.results.length);
  } catch (err: any) {
    console.error("Error:", err.message);
  }
}
run();
