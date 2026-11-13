import { useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { RefreshCw } from 'lucide-react';
import { Switch } from '@/components/ui/switch';
import { useToast } from '@/hooks/use-toast';
import { apiRequest, queryClient } from '@/lib/queryClient';

// Settings > Data Management > Proforma status sync (every 5 hours). The background job re-reads the latest order date's EXISTING slips from Notion (Plant,
// Status, Quantity only; it never creates a slip) and writes the changes only when this switch is on - with it off, a run just logs what it would have
// changed. Server-persisted (proforma_sync_config), the same switch the Proforma Slips page used to hold in its Sync dialog.
const KEY = ['/api/proforma-notion-sync/auto-apply-config'];

export default function ProformaAutoSyncCard({ isAdmin }: { isAdmin: boolean }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const { data } = useQuery<{ enabled: boolean }>({
    queryKey: KEY,
    queryFn: async () => (await apiRequest('GET', '/api/proforma-notion-sync/auto-apply-config')).json(),
    staleTime: 60 * 1000,
    enabled: isAdmin,
  });
  const save = useMutation({
    mutationFn: async (enabled: boolean) => (await apiRequest('POST', '/api/proforma-notion-sync/auto-apply-config', { enabled })).json(),
    onMutate: () => setBusy(true),
    onSuccess: async (v: { enabled: boolean }) => {
      await queryClient.invalidateQueries({ queryKey: KEY });
      toast({ title: v.enabled ? 'Proforma status sync will apply changes' : 'Proforma status sync will only report', description: v.enabled ? 'Every 5 hours the latest day\'s slips get their Plant, Status and Quantity updated from Notion.' : 'Every 5 hours it only logs what it would change; nothing is written.' });
    },
    onError: (e: any) => toast({ title: 'Could not save', description: e?.message ?? 'Try again', variant: 'destructive' }),
    onSettled: () => setBusy(false),
  });
  return (
    <div className="p-4 border rounded-lg bg-gray-50">
      <h4 className="font-medium flex items-center"><RefreshCw className="h-4 w-4 mr-2" /> Proforma Status Sync (every 5 hours)</h4>
      <p className="text-sm text-gray-600 mt-1 mb-3">
        Every 5 hours the app reads the latest order date's proforma slips from Notion and brings their <strong>Plant, Status and Quantity</strong> in line. It never creates
        a slip and never touches items, vehicle or party. Switch this on to let it write the changes; with it off it only records what would change in Activities.
      </p>
      <div className="flex items-center gap-2">
        <Switch id="proforma-auto-sync" checked={!!data?.enabled} disabled={!isAdmin || busy || !data} onCheckedChange={(v) => save.mutate(v)} />
        <label htmlFor="proforma-auto-sync" className="text-sm font-medium">{data?.enabled ? 'Apply changes' : 'Report only'}</label>
      </div>
    </div>
  );
}
