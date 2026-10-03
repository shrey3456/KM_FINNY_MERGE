import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export const createSyncChannel = (channelName: string) => {
  const channel = new BroadcastChannel(channelName);
  const deviceId = `device-${Math.random().toString(36).substring(2, 8)}`;

  const send = (type: string, data: any) => {
    channel.postMessage({
      type,
      data,
      timestamp: Date.now(),
      sender: deviceId
    });
  };

  return {
    channel,
    deviceId,
    send
  };
};

export const SYNC_ACTIONS = {
  FILTER_CHANGE: 'FILTER_CHANGE',
  OPERATION_UPDATE: 'OPERATION_UPDATE',
  USER_VIEW_CHANGE: 'USER_VIEW_CHANGE'
} as const;
// Natural order for names that end in a number — V1, V2, V3 … V10 (a plain text sort would put
// V10 before V2), however they were entered. Used for Dispatch Directory lists.
export function sortNatural<T>(list: T[], key: (item: T) => string = (item) => String(item)): T[] {
  return [...list].sort((a, b) => key(a).localeCompare(key(b), undefined, { numeric: true, sensitivity: "base" }));
}
