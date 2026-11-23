import { Client } from '@notionhq/client';
import { pool } from '../db';
import { extractText } from '../lib/notionProperties';

// Festival greetings over WhatsApp.
//
// The Notion attachment database (NOTION_ATTACHMENT_STORAGE_PATH) has "Festival" rows (INF1, INF2 …)
// with a Date, a "Files & media" picture and a Text. On a row's Date, every Finny user who has a
// contact number gets that row's greeting once:
//   - picture attached  → the image template (picture in the header, Text as the body)
//   - no picture        → the text template (Text as the body)
// Business-initiated WhatsApp messages must use a Meta-approved template, so both templates are
// created in WhatsApp Manager first; their names go in the env vars below. Each template has TWO
// body variables: {{1}} = the user's name, {{2}} = the festival (the row's Text, or its Title if Text is empty).
//
// Safety: nothing is sent unless WHATSAPP_FESTIVAL_ENABLED=true. While it is off, the job only logs
// who it WOULD message. Each (festival row, user) pair is written to whatsapp_festival_log, which
// is also a unique key, so a restart or a second tick can never message anyone twice.

const GRAPH_VERSION = 'v21.0';
const DATABASE_ID = (process.env.NOTION_ATTACHMENT_STORAGE_PATH ?? '').trim();
const CATEGORY_FESTIVAL = 'Festival';

const notion = new Client({
  auth: (process.env.NOTION_INTEGRATION_SECRET ?? process.env.NOTION_API_KEY ?? '').trim(),
});

const env = (name: string, fallback = '') => (process.env[name] ?? fallback).trim();

export async function ensureFestivalWhatsappSchema() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS whatsapp_festival_log (
      id SERIAL PRIMARY KEY,
      page_id TEXT NOT NULL,
      festival_date TEXT NOT NULL,
      title TEXT,
      user_code TEXT NOT NULL,
      phone TEXT,
      status TEXT NOT NULL,            -- 'sent' | 'failed'
      wa_message_id TEXT,
      error TEXT,
      sent_at TIMESTAMP DEFAULT NOW(),
      UNIQUE (page_id, user_code)
    )
  `);
  // The Festival cards, as last told to us by Notion (webhook, plus one read at boot). The
  // scheduler only ever reads THIS table, so the minute-by-minute check makes no Notion calls.
  await pool.query(`
    CREATE TABLE IF NOT EXISTS festival_schedule (
      page_id TEXT PRIMARY KEY,
      title TEXT,
      text TEXT,
      festival_date TEXT NOT NULL,
      minute INTEGER,
      updated_at TIMESTAMP DEFAULT NOW()
    )
  `);
}

type Festival = { pageId: string; title: string; text: string; date: string; minute: number | null; fileUrl: string | null };

/** Today's date in India (YYYY-MM-DD) — festival dates are written as local calendar days. */
function todayIST(): string {
  return new Date(Date.now() + 5.5 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

/**
 * The Date column's value in India time: the calendar day, and the minute of that day when the
 * value carries a time (null for a plain date). A value with an offset/Z is converted to IST; one
 * without is read as already being IST (Notion stores the zone separately in time_zone).
 */
function istParts(start: string): { date: string; minute: number | null } {
  if (!start.includes('T')) return { date: start.slice(0, 10), minute: null };
  if (/(Z|[+-]\d{2}:?\d{2})$/.test(start)) {
    const d = new Date(new Date(start).getTime() + 5.5 * 60 * 60 * 1000);
    return { date: d.toISOString().slice(0, 10), minute: d.getUTCHours() * 60 + d.getUTCMinutes() };
  }
  return { date: start.slice(0, 10), minute: Number(start.slice(11, 13)) * 60 + Number(start.slice(14, 16)) };
}

/** Reads one Notion page (as returned by pages.retrieve / databases.query) into the schedule table. */
export async function applyFestivalPage(page: any): Promise<string> {
  const props = page?.properties ?? {};
  const pageId = String(page?.id ?? '').replace(/-/g, '');
  const start = props['Date']?.date?.start;
  const isFestival = extractText(props['Category']) === CATEGORY_FESTIVAL && !!start && !page?.archived && !page?.in_trash;
  if (!isFestival) {
    await pool.query(`DELETE FROM festival_schedule WHERE page_id = $1`, [pageId]);
    return 'not a dated Festival card';
  }
  const { date, minute } = istParts(start);
  await pool.query(
    `INSERT INTO festival_schedule (page_id, title, text, festival_date, minute, updated_at)
     VALUES ($1,$2,$3,$4,$5,NOW())
     ON CONFLICT (page_id) DO UPDATE SET title = EXCLUDED.title, text = EXCLUDED.text,
       festival_date = EXCLUDED.festival_date, minute = EXCLUDED.minute, updated_at = NOW()`,
    [pageId, extractText(props['Title']).trim(), extractText(props['Text']).trim(), date, minute],
  );
  return `festival "${extractText(props['Title']).trim()}" on ${date}${minute == null ? '' : ` at ${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`}`;
}

/** A card trashed in Notion must stop being sent. */
export async function removeFestivalPage(pageId: string): Promise<void> {
  await pool.query(`DELETE FROM festival_schedule WHERE page_id = $1`, [pageId.replace(/-/g, '')]);
}

/**
 * The one Notion read: at server start, to catch cards changed while the server was down (a deploy,
 * a sleeping host). After this, changes arrive by webhook only.
 */
export async function syncFestivalsFromNotion(): Promise<string> {
  if (!DATABASE_ID) return 'skipped (NOTION_ATTACHMENT_STORAGE_PATH is not set)';
  try {
    const seen = new Set<string>();
    let cursor: string | undefined;
    do {
      const res: any = await notion.databases.query({
        database_id: DATABASE_ID, start_cursor: cursor, page_size: 100,
        filter: { property: 'Category', select: { equals: CATEGORY_FESTIVAL } },
      });
      for (const page of res.results) {
        await applyFestivalPage(page);
        seen.add(String(page.id).replace(/-/g, ''));
      }
      cursor = res.has_more ? res.next_cursor : undefined;
    } while (cursor);
    const { rows } = await pool.query(`SELECT page_id FROM festival_schedule`);
    for (const r of rows) if (!seen.has(r.page_id)) await removeFestivalPage(r.page_id);
    return `${seen.size} festival card(s)`;
  } catch (error) {
    return `error (${error instanceof Error ? error.message : String(error)})`;
  }
}

async function festivalsOn(date: string): Promise<Festival[]> {
  const { rows } = await pool.query(
    `SELECT page_id, title, text, festival_date, minute FROM festival_schedule WHERE festival_date = $1`, [date]);
  return rows.map((r: any): Festival => ({
    pageId: r.page_id, title: r.title ?? '', text: r.text ?? '', date: r.festival_date, minute: r.minute,
    fileUrl: null, // pictures are not used (text template only); Notion file links expire within the hour anyway
  }));
}

/**
 * The number exactly as the user saved it, reduced to digits (E.164 without "+"). No country code
 * is ever added: a number saved without one (e.g. a bare 10 digits) is rejected rather than guessed.
 */
export function normalizePhone(raw: string | null | undefined): string | null {
  let d = String(raw ?? '').replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2); // 00 91 … international prefix
  return d.length >= 11 && d.length <= 15 ? d : null;
}

// Template variables cannot contain new lines, tabs or runs of 4+ spaces.
const asParam = (s: string) => s.replace(/[\r\n\t]+/g, ' ').replace(/ {4,}/g, '   ').trim();

async function sendTemplate(to: string, f: Festival, recipientName: string): Promise<string> {
  const festivalName = asParam(f.text || f.title);
  const withImage = useImage(f);
  const components: any[] = [];
  if (withImage) components.push({ type: 'header', parameters: [{ type: 'image', image: { link: f.fileUrl } }] });
  components.push({ type: 'body', parameters: [{ type: 'text', text: asParam(recipientName) || 'Team Member' }, { type: 'text', text: festivalName }] });

  const res = await fetch(`https://graph.facebook.com/${GRAPH_VERSION}/${env('WHATSAPP_PHONE_NUMBER_ID')}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('WHATSAPP_ACCESS_TOKEN')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messaging_product: 'whatsapp',
      to,
      type: 'template',
      template: {
        name: withImage ? env('WHATSAPP_FESTIVAL_TEMPLATE_IMAGE') : env('WHATSAPP_FESTIVAL_TEMPLATE_TEXT'),
        language: { code: env('WHATSAPP_TEMPLATE_LANG', 'en') },
        components,
      },
    }),
  });
  const json: any = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message ?? `WhatsApp API ${res.status}`);
  return json?.messages?.[0]?.id ?? '';
}

// The picture is only used when an image template is configured; with WHATSAPP_FESTIVAL_TEMPLATE_IMAGE
// unset, every row goes out as plain text and its file is ignored.
const useImage = (f: Festival) => !!f.fileUrl && !!env('WHATSAPP_FESTIVAL_TEMPLATE_IMAGE');

const dryRunLogged = new Set<string>();
const lastFailedAt = new Map<string, number>();
const RETRY_AFTER_MS = 15 * 60 * 1000;
let running: Promise<string> | null = null;

/** Sends today's festival greeting(s). Safe to call as often as you like. */
export function runFestivalWhatsapp(): Promise<string> {
  if (!running) running = run().finally(() => { running = null; });
  return running;
}

async function run(): Promise<string> {
  try {
    const date = todayIST();
    const nowMin = new Date(Date.now() + 5.5 * 60 * 60 * 1000);
    const minutesNow = nowMin.getUTCHours() * 60 + nowMin.getUTCMinutes();
    // A row with a time in its Date goes out at that time; a plain date goes out at the default time.
    const festivals = (await festivalsOn(date)).filter((f) => (f.minute ?? sendMinute()) <= minutesNow);
    if (festivals.length === 0) return `nothing due on ${date}`;

    const enabled = env('WHATSAPP_FESTIVAL_ENABLED').toLowerCase() === 'true';
    // WHATSAPP_NOTIFY_SINCE is the account-wide go-live moment: no WhatsApp goes out before it.
    // Festivals due earlier are not sent late afterwards either (only today's festivals are ever sent).
    const since = Date.parse(env('WHATSAPP_NOTIFY_SINCE'));
    if (enabled && Number.isFinite(since) && Date.now() < since) {
      return `waiting for WHATSAPP_NOTIFY_SINCE (${env('WHATSAPP_NOTIFY_SINCE')})`;
    }
    const { rows: users } = await pool.query(
      `SELECT user_code, name, username, contact_number FROM users WHERE COALESCE(TRIM(contact_number), '') <> '' ORDER BY user_code`,
    );
    const summary: string[] = [];

    for (const f of festivals) {
      const needTemplate = useImage(f) ? 'WHATSAPP_FESTIVAL_TEMPLATE_IMAGE' : 'WHATSAPP_FESTIVAL_TEMPLATE_TEXT';
      if (enabled && !env(needTemplate)) {
        console.warn(`[Festival WhatsApp] "${f.title}" needs ${needTemplate} to be set — skipped`);
        summary.push(`${f.title}: ${needTemplate} not set`);
        continue;
      }
      const { rows: done } = await pool.query(`SELECT user_code FROM whatsapp_festival_log WHERE page_id = $1`, [f.pageId]);
      const already = new Set(done.map((r: any) => r.user_code));
      const todo = users.filter((u: any) => !already.has(u.user_code));
      if (todo.length === 0) continue; // everyone already handled

      if (!enabled) {
        if (dryRunLogged.has(f.pageId)) continue;
        dryRunLogged.add(f.pageId);
        console.log(`[Festival WhatsApp] DRY RUN — "${f.title}" (${f.text || 'no text'}, ${useImage(f) ? 'image' : 'text only'}) would go to ${todo.length} of ${users.length} user(s). Set WHATSAPP_FESTIVAL_ENABLED=true to send.`);
        summary.push(`${f.title}: dry run, ${todo.length} pending`);
        continue;
      }

      let sent = 0, failed = 0;
      for (const u of todo) {
        const phone = normalizePhone(u.contact_number);
        const retryKey = `${f.pageId}:${u.user_code}`;
        // A send that WhatsApp refused (template still in review, paused, network trouble…) is not
        // recorded, so it is tried again — but not more than once every 15 minutes per person.
        if (phone && Date.now() - (lastFailedAt.get(retryKey) ?? 0) < RETRY_AFTER_MS) continue;
        let status = 'sent', waId = '', error: string | null = null;
        try {
          if (!phone) throw new Error(`contact number "${u.contact_number}" has no country code or is not a valid number`);
          waId = await sendTemplate(phone, f, u.name || u.username || '');
          sent++;
        } catch (err) {
          error = err instanceof Error ? err.message : String(err);
          failed++;
          if (phone) {
            lastFailedAt.set(retryKey, Date.now());
            console.warn(`[Festival WhatsApp] "${f.title}" to ${u.user_code} failed, will retry: ${error}`);
            continue;
          }
          status = 'failed'; // an unusable number can never succeed — record it once and move on
        }
        await pool.query(
          `INSERT INTO whatsapp_festival_log (page_id, festival_date, title, user_code, phone, status, wa_message_id, error)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (page_id, user_code) DO NOTHING`,
          [f.pageId, date, f.title, u.user_code, phone, status, waId || null, error],
        );
        await new Promise((r) => setTimeout(r, 250)); // gentle pacing
      }
      console.log(`[Festival WhatsApp] "${f.title}": ${sent} sent, ${failed} failed`);
      summary.push(`${f.title}: ${sent} sent, ${failed} failed`);
    }
    return summary.join('; ');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Festival WhatsApp] failed: ${message}`);
    return `error (${message})`;
  }
}

/** "HH:MM" (IST) → minutes after midnight; falls back to 06:00 if unset or malformed. */
function sendMinute(): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(env('WHATSAPP_FESTIVAL_SEND_TIME', '06:00'));
  const mins = m ? Number(m[1]) * 60 + Number(m[2]) : 6 * 60;
  return mins >= 0 && mins < 24 * 60 ? mins : 6 * 60;
}

/**
 * A row whose Date includes a time goes out at that time (IST); a plain date goes out at
 * WHATSAPP_FESTIVAL_SEND_TIME (default 06:00 — around sunrise, right after Brahma Muhurta). The
 * check runs every minute against the database only (Notion changes arrive by webhook); if the server was down at the time it
 * sends as soon as it is back the same day. The log guarantees nobody gets it twice.
 */
export function startFestivalWhatsappScheduler() {
  // One Notion read at boot, then a database-only check every minute; changes come in by webhook.
  void syncFestivalsFromNotion().then((r) => console.log(`[Festival WhatsApp] boot sync: ${r}`));
  setInterval(() => { void runFestivalWhatsapp(); }, 60 * 1000);
  setTimeout(() => { void runFestivalWhatsapp(); }, 30 * 1000);
}
