const fs = require("fs");
const crypto = require("crypto");
const { Client } = require("pg");

async function baselineMigrations() {
  const journalPath = "migrations/meta/_journal.json";
  if (!fs.existsSync(journalPath)) {
    throw new Error("Missing migrations/meta/_journal.json");
  }

  const journal = JSON.parse(fs.readFileSync(journalPath, "utf8"));

  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  await client.query('CREATE SCHEMA IF NOT EXISTS "drizzle"');
  await client.query(
    'CREATE TABLE IF NOT EXISTS "drizzle"."__drizzle_migrations" (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at numeric)'
  );

  const existing = await client.query(
    'SELECT hash FROM "drizzle"."__drizzle_migrations"'
  );
  const existingSet = new Set(existing.rows.map((row) => row.hash));

  for (const entry of journal.entries) {
    const sqlPath = `migrations/${entry.tag}.sql`;
    const sql = fs.readFileSync(sqlPath, "utf8");
    const hash = crypto.createHash("sha256").update(sql).digest("hex");

    if (!existingSet.has(hash)) {
      await client.query(
        'INSERT INTO "drizzle"."__drizzle_migrations" (hash, created_at) VALUES ($1, $2)',
        [hash, entry.when]
      );
      console.log(`Inserted ${entry.tag}`);
    } else {
      console.log(`Skipped ${entry.tag}`);
    }
  }

  await client.end();
}

baselineMigrations().catch((error) => {
  console.error(error);
  process.exit(1);
});
