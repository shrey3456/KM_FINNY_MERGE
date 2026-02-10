/**
 * Simple utility for managing user preferences in localStorage
 * Used for storing UI state preferences like filters, view modes, etc.
 */

const PREFIX = 'km-tribe-pref-';

/**
 * Get a user preference from localStorage
 * @param key Preference key
 * @param defaultValue Default value if preference doesn't exist
 * @returns The stored preference value or the defaultValue
 */
export function getPreference<T>(key: string, defaultValue: T): T {
  try {
    const storedValue = localStorage.getItem(PREFIX + key);
    if (storedValue === null) return defaultValue;
    return JSON.parse(storedValue);
  } catch (error) {
    console.error(`Error retrieving preference "${key}":`, error);
    return defaultValue;
  }
}

/**
 * Save a user preference to localStorage
 * @param key Preference key
 * @param value Value to store
 */
export function setPreference<T>(key: string, value: T): void {
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify(value));
  } catch (error) {
    console.error(`Error storing preference "${key}":`, error);
  }
}

/**
 * Remove a user preference from localStorage
 * @param key Preference key to remove
 */
export function removePreference(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch (error) {
    console.error(`Error removing preference "${key}":`, error);
  }
}

/**
 * Clear all user preferences from localStorage
 */
export function clearAllPreferences(): void {
  try {
    Object.keys(localStorage).forEach(key => {
      if (key.startsWith(PREFIX)) {
        localStorage.removeItem(key);
      }
    });
  } catch (error) {
    console.error('Error clearing all preferences:', error);
  }
}