// What the server says about updating Notion after a vehicle/status change (`notion` in the
// response of link-vehicle, start, complete, reopen, sync-notion and Vehicle Planning's assign):
// { state: 'ok' | 'retrying' | 'skipped' | 'failed', message }.
//
// Only one toast shows at a time (use-toast's limit is 1), so a second toast for Notion would
// replace the "Saved" one — this folds the Notion note into the same toast instead.
export type NotionSyncNotice = { state: "ok" | "retrying" | "skipped" | "failed"; message: string };

type ToastProps = { title: string; description?: string; variant?: "default" | "destructive"; className?: string };

export function withNotionNotice(base: ToastProps, data: unknown): ToastProps {
  const notion = (data as { notion?: NotionSyncNotice } | null | undefined)?.notion;
  if (!notion || notion.state === "ok") return base;
  const note = `Notion: ${notion.message}`;
  const bad = notion.state === "retrying" || notion.state === "failed";
  return {
    ...base,
    description: base.description ? `${base.description} — ${note}` : note,
    variant: bad ? "destructive" : base.variant,
  };
}
