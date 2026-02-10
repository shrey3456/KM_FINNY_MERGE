declare module 'node-persist' {
  export function init(options?: any): Promise<void>;
  export function getItem(key: string): Promise<any>;
  export function setItem(key: string, value: any): Promise<any>;
  export function removeItem(key: string): Promise<void>;
  export function clear(): Promise<void>;
  export function values(): Promise<any[]>;
  export function keys(): Promise<string[]>;
  export function length(): Promise<number>;
}