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