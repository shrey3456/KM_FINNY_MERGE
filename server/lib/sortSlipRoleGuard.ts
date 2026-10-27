import { pool } from '../db';
import { WRITE_ADMIN_ROLES } from './pageAccess';

// Sort Slip roles follow the designation on User Management: a Supervisor is the designation "Supervisor" with write access to the page (or an admin); a Loader is the
// designation "Loader" with view access. A user cannot be moved out of a role while they still hold open work in it - the slip would be left with someone who can no
// longer work or manage it. This returns the sentence to show (naming the orders) when a save would do that, or null when the save is fine.

type Next = { role?: string | null; designation?: string | null; allowedPages?: string | null; pageWriteAccess?: string | null };

const parse = (value: string | null | undefined): string[] => {
  try { const v = JSON.parse(value || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
};
const is = (value: unknown, wanted: string) => String(value ?? '').trim().toLowerCase() === wanted;
const isAdminRole = (role: unknown) => WRITE_ADMIN_ROLES.includes(String(role ?? '').toLowerCase());

const isLoader = (u: Next) => is(u.designation, 'loader') && parse(u.allowedPages).includes('sort-slip');
const isSupervisor = (u: Next) => isAdminRole(u.role) || (is(u.designation, 'supervisor') && parse(u.pageWriteAccess).includes('sort-slip'));

const list = (orders: string[]) => `${orders.slice(0, 5).map((o) => `#${o}`).join(', ')}${orders.length > 5 ? ', ...' : ''}`;

export async function sortSlipRoleBlock(userCode: string, current: Next, next: Next): Promise<string | null> {
  const who = userCode;

  if (isLoader(current) && !isLoader(next)) {
    const { rows } = await pool.query(
      `SELECT s.order_number FROM sort_slip_assignees a JOIN sort_slips s ON s.id = a.sort_slip_id
        WHERE a.user_code = $1 AND a.removed_at IS NULL AND s.status <> 'completed' ORDER BY s.order_number`,
      [userCode],
    );
    if (rows.length) {
      return `${who} is the loader on ${rows.length} open sort slip${rows.length > 1 ? 's' : ''} (${list(rows.map((r: any) => r.order_number))}). Transfer or complete ${rows.length > 1 ? 'them' : 'it'} first, then change the designation or the Sort Slip access.`;
    }
  }

  if (isSupervisor(current) && !isSupervisor(next)) {
    const { rows } = await pool.query(
      `SELECT order_number FROM sort_slips WHERE managed_by_code = $1 AND status <> 'completed' ORDER BY order_number`,
      [userCode],
    );
    if (rows.length) {
      return `${who} manages ${rows.length} open sort slip${rows.length > 1 ? 's' : ''} (${list(rows.map((r: any) => r.order_number))}). Transfer ${rows.length > 1 ? 'them' : 'it'} to another supervisor or complete ${rows.length > 1 ? 'them' : 'it'} first, then change the designation or the Sort Slip access.`;
    }
  }
  return null;
}
