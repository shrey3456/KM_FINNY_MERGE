import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { RefreshCw, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { apiRequest, queryClient } from '@/lib/queryClient';

// Settings > Data Management > Daily Notion sync. Once a day at the set time (India time), when switched on: Product Master is synced and applied, and
// 5 minutes later tomorrow's Proforma Slips are synced and applied. Separate from the 5-hour Proforma sync (server/services/dailyNotionSync.ts).
type View = {
  enabled: boolean; runTime: string; nextRunAt: string | null; running: boolean;
  lastRunAt: string | null; lastRunStatus: string | null; lastRunSummary: string | null; phase: string | null;
};
const KEY = ['/api/settings/daily-notion-sync'];
const fmt = (v: string | null) => (v ? new Date(v).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) : '—');

export default function DailyNotionSyncCard({ isAdmin }: { isAdmin: boolean }) {
  const { toast } = useToast();
  const { data } = useQuery<View>({
    queryKey: KEY,
    queryFn: () => apiRequest('GET', '/api/settings/daily-notion-sync', undefined, false, true),
    // Polls only while a run is going on (to show its progress); idle otherwise.
    refetchInterval: (q) => (q.state.data?.running || q.state.data?.phase ? 5000 : false),
  });
  const [time, setTime] = useState('06:00');
  useEffect(() => { if (data?.runTime) setTime(data.runTime); }, [data?.runTime]);

  const save = useMutation({
    mutationFn: (patch: { enabled?: boolean; runTime?: string }) => apiRequest('PUT', '/api/settings/daily-notion-sync', patch, false, true),
    onSuccess: (v: View, patch) => {
      queryClient.setQueryData(KEY, v);
      toast({ title: patch.enabled !== undefined ? (v.enabled ? 'Daily Notion sync is on' : 'Daily Notion sync is off') : 'Time saved', description: v.enabled ? `Next run ${fmt(v.nextRunAt)} IST` : undefined });
    },
    onError: (e: any) => toast({ title: 'Could not save', description: e?.message ?? 'Try again', variant: 'destructive' }),
  });
  const runNow = useMutation({
    mutationFn: () => apiRequest('POST', '/api/settings/daily-notion-sync/run-now', {}, false, true),
    onSuccess: () => { toast({ title: 'Sync started', description: 'Products first, then tomorrow\'s proforma slips. The result shows here when it finishes.' }); queryClient.invalidateQueries({ queryKey: KEY }); },
    onError: (e: any) => toast({ title: 'Could not start', description: e?.message ?? 'Try again', variant: 'destructive' }),
  });

  const busy = !!data?.running || !!data?.phase;
  return (
    <div className="p-4 border rounded-lg bg-gray-50">
      <h4 className="font-medium flex items-center"><RefreshCw className="h-4 w-4 mr-2" /> Daily Notion Sync</h4>
      <p className="text-sm text-gray-600 mt-1 mb-3">
        Once a day at the time you set (India time): Product Master is synced from Notion and applied, then 5 minutes later <strong>tomorrow's</strong> Proforma Slips are
        synced from Notion and applied. It is separate from the 5-hour Proforma sync, which keeps running as before.
      </p>
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <Switch id="daily-notion-sync" checked={!!data?.enabled} disabled={!isAdmin || save.isPending || !data} onCheckedChange={(v) => save.mutate({ enabled: v })} />
          <label htmlFor="daily-notion-sync" className="text-sm font-medium">{data?.enabled ? 'On' : 'Off'}</label>
        </div>
        <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} disabled={!isAdmin} className="w-auto" />
        <span className="text-xs text-gray-500">IST</span>
        <Button size="sm" onClick={() => save.mutate({ runTime: time })} disabled={!isAdmin || save.isPending || !time || time === data?.runTime}>
          {save.isPending ? 'Saving...' : 'Save time'}
        </Button>
        <Button variant="outline" size="sm" onClick={() => runNow.mutate()} disabled={!isAdmin || busy || runNow.isPending} title="Runs both steps once, back to back (no 5-minute wait)">
          {busy || runNow.isPending ? <><Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Running…</> : 'Run now'}
        </Button>
      </div>
      <div className="mt-3 space-y-0.5 text-xs text-gray-500">
        <div>Next run: <span className="text-gray-700">{data?.enabled ? `${fmt(data.nextRunAt)} IST` : 'off — nothing is scheduled'}</span></div>
        <div>Last run: <span className="text-gray-700">{fmt(data?.lastRunAt ?? null)}{data?.lastRunStatus ? ` · ${data.lastRunStatus}` : ''}</span></div>
        {data?.lastRunSummary && <div className="break-words text-gray-600">{data.lastRunSummary}</div>}
      </div>
    </div>
  );
}
