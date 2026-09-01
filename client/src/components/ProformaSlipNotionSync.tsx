import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { AlertCircle, CheckCircle, RefreshCw, Shield, Search, XCircle } from "lucide-react";
import { apiRequest } from "@/lib/queryClient";
import { useUser } from "@/hooks/use-user";

interface FieldChange {
  field: string;
  from: string;
  to: string;
}

interface OrderDiff {
  orderNumber: string;
  partyName: string;
  isNew: boolean;
  fieldChanges: FieldChange[];
  itemChanges: string[];
}

interface SyncReport {
  totalOrders: number;
  newCount: number;
  changedCount: number;
  unchangedCount: number;
  diffs: OrderDiff[];
}

interface ProformaSlipNotionSyncProps {
  onApplySuccess: () => void;
}

export function ProformaSlipNotionSync({ onApplySuccess }: ProformaSlipNotionSyncProps) {
  const { user } = useUser();
  const canSync = user?.role === 'admin' || user?.role === 'super-admin';

  const [dateRange, setDateRange] = useState({
    startDate: new Date().toISOString().split('T')[0],
    endDate: new Date().toISOString().split('T')[0],
  });
  const [checking, setChecking] = useState(false);
  const [applying, setApplying] = useState(false);
  const [report, setReport] = useState<SyncReport | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [error, setError] = useState<string>('');
  const [applyResult, setApplyResult] = useState<string>('');

  // Default every detected change to checked, so "Apply Sync" behaves like before unless the
  // user deliberately unchecks something.
  useEffect(() => {
    setSelected(new Set(report?.diffs.map((d) => d.orderNumber) ?? []));
  }, [report]);

  const toggleOrder = (orderNumber: string, checked: boolean) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (checked) next.add(orderNumber);
      else next.delete(orderNumber);
      return next;
    });
  };

  const handleCheck = async () => {
    setChecking(true);
    setError('');
    setApplyResult('');
    setReport(null);
    try {
      const response = await apiRequest('POST', '/api/proforma-notion-sync/detect', {
        startDate: dateRange.startDate,
        endDate: dateRange.endDate,
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Failed to check for changes');
      setReport(data.report);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to check for changes');
    } finally {
      setChecking(false);
    }
  };

  const handleApply = async () => {
    if (selected.size === 0) {
      setError('Select at least one order to apply.');
      return;
    }
    setApplying(true);
    setError('');
    try {
      const response = await apiRequest('POST', '/api/proforma-notion-sync/apply', {
        orderNumbers: Array.from(selected),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || 'Failed to apply changes');
      setApplyResult(`Synced: ${data.slipsCreated} new slip(s), ${data.slipsUpdated} updated, ${data.itemsCreated} items written.`);
      // Whatever wasn't checked stays pending server-side — drop only the applied rows here too,
      // and recompute the badge counts from what's left so they don't go stale.
      setReport((prev) => {
        if (!prev) return prev;
        const remaining = prev.diffs.filter((d) => !selected.has(d.orderNumber));
        if (remaining.length === 0) return null;
        return {
          ...prev,
          diffs: remaining,
          newCount: remaining.filter((d) => d.isNew).length,
          changedCount: remaining.filter((d) => !d.isNew).length,
        };
      });
      onApplySuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to apply changes');
    } finally {
      setApplying(false);
    }
  };

  const handleDiscard = async () => {
    try {
      await apiRequest('POST', '/api/proforma-notion-sync/discard', {});
    } finally {
      setReport(null);
    }
  };

  if (!canSync) {
    return (
      <div className="space-y-4 p-4 border rounded-lg bg-gray-50">
        <div className="flex items-center space-x-2">
          <Shield className="h-5 w-5 text-gray-400" />
          <h3 className="text-lg font-semibold text-gray-600">Sync from Notion</h3>
        </div>
        <Alert>
          <Shield className="h-4 w-4" />
          <AlertTitle>Access Restricted</AlertTitle>
          <AlertDescription>
            Only administrators and super-administrators can sync data from Notion.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  const hasChanges = !!report && (report.newCount > 0 || report.changedCount > 0);

  return (
    <div className="space-y-4 p-4 border rounded-lg bg-white">
      <div className="flex items-center space-x-2">
        <Search className="h-5 w-5 text-[#001d6e]" />
        <h3 className="text-lg font-semibold text-[#001d6e]">Sync from Notion</h3>
      </div>
      <p className="text-sm text-gray-500">
        Check whether Notion has new orders or changed data for a date range, review what would
        change, then apply it — nothing is written until you confirm.
      </p>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-700">Start Date</label>
          <Input
            type="date"
            value={dateRange.startDate}
            onChange={(e) => setDateRange((prev) => ({ ...prev, startDate: e.target.value }))}
            disabled={checking || applying}
            className="w-full"
          />
        </div>
        <div className="space-y-2">
          <label className="text-sm font-medium text-gray-700">End Date</label>
          <Input
            type="date"
            value={dateRange.endDate}
            onChange={(e) => setDateRange((prev) => ({ ...prev, endDate: e.target.value }))}
            disabled={checking || applying}
            className="w-full"
          />
        </div>
      </div>

      <Button
        onClick={handleCheck}
        disabled={checking || applying}
        className="w-full bg-[#001d6e] hover:bg-blue-700"
      >
        {checking ? (
          <>
            <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
            Checking Notion...
          </>
        ) : (
          <>
            <Search className="mr-2 h-4 w-4" />
            Check for Changes
          </>
        )}
      </Button>

      {error && (
        <Alert className="border-red-200 bg-red-50" variant="destructive">
          <XCircle className="h-4 w-4" />
          <AlertTitle>Error</AlertTitle>
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      )}

      {applyResult && (
        <Alert className="border-green-200 bg-green-50">
          <CheckCircle className="h-4 w-4 text-green-600" />
          <AlertTitle className="text-green-800">Sync Applied</AlertTitle>
          <AlertDescription className="text-green-700">{applyResult}</AlertDescription>
        </Alert>
      )}

      {report && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2 text-sm">
            <Badge variant="outline">{report.totalOrders} orders in range</Badge>
            <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100">{report.newCount} new</Badge>
            <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100">{report.changedCount} changed</Badge>
            <Badge variant="outline">{report.unchangedCount} unchanged</Badge>
          </div>

          {!hasChanges ? (
            <Alert>
              <CheckCircle className="h-4 w-4" />
              <AlertTitle>Already up to date</AlertTitle>
              <AlertDescription>Nothing to sync for this date range.</AlertDescription>
            </Alert>
          ) : (
            <>
              <div className="flex items-center justify-between text-xs text-gray-500 px-1">
                <span>{selected.size} of {report.diffs.length} selected</span>
                <div className="flex gap-3">
                  <button type="button" className="underline hover:text-gray-700" onClick={() => setSelected(new Set(report.diffs.map((d) => d.orderNumber)))}>
                    Select all
                  </button>
                  <button type="button" className="underline hover:text-gray-700" onClick={() => setSelected(new Set())}>
                    Select none
                  </button>
                </div>
              </div>

              <div className="max-h-72 overflow-y-auto space-y-2 border rounded-md p-2">
                {report.diffs.map((diff) => (
                  <label key={diff.orderNumber} className="flex items-start gap-2 border rounded-md p-2 text-sm cursor-pointer hover:bg-gray-50">
                    <Checkbox
                      className="mt-0.5"
                      checked={selected.has(diff.orderNumber)}
                      onCheckedChange={(checked) => toggleOrder(diff.orderNumber, checked === true)}
                    />
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 font-medium">
                        <span>{diff.orderNumber}</span>
                        <span className="text-gray-500 font-normal">{diff.partyName}</span>
                        {diff.isNew ? (
                          <Badge className="bg-emerald-100 text-emerald-800 hover:bg-emerald-100 ml-auto">New</Badge>
                        ) : (
                          <Badge className="bg-amber-100 text-amber-800 hover:bg-amber-100 ml-auto">Changed</Badge>
                        )}
                      </div>
                      {diff.fieldChanges.length > 0 && (
                        <ul className="mt-1 space-y-0.5 text-xs text-gray-600">
                          {diff.fieldChanges.map((fc) => (
                            <li key={fc.field}>
                              <span className="font-medium">{fc.field}:</span> {fc.from} → {fc.to}
                            </li>
                          ))}
                        </ul>
                      )}
                      {diff.itemChanges.length > 0 && (
                        <ul className="mt-1 space-y-0.5 text-xs text-gray-600">
                          {diff.itemChanges.map((line, idx) => (
                            <li key={idx}>{line}</li>
                          ))}
                        </ul>
                      )}
                    </div>
                  </label>
                ))}
              </div>

              <div className="flex gap-2">
                <Button
                  onClick={handleApply}
                  disabled={applying || selected.size === 0}
                  className="flex-1 bg-emerald-600 hover:bg-emerald-700"
                >
                  {applying ? (
                    <>
                      <RefreshCw className="mr-2 h-4 w-4 animate-spin" />
                      Applying...
                    </>
                  ) : (
                    <>
                      <CheckCircle className="mr-2 h-4 w-4" />
                      Apply Sync ({selected.size})
                    </>
                  )}
                </Button>
                <Button onClick={handleDiscard} disabled={applying} variant="outline" className="flex-1">
                  Discard
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {!report && !error && (
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertTitle>How this works</AlertTitle>
          <AlertDescription>
            "Check for Changes" only reads from Notion — it doesn't write anything. Review the
            list, then click "Apply Sync" to write it, or "Discard" to cancel.
          </AlertDescription>
        </Alert>
      )}
    </div>
  );
}
