/**
 * Formats a username by removing the '@km-tribe' suffix if present
 * @param username The username to format
 * @returns The formatted username
 */
export function formatUsername(username: string | undefined | null): string {
  if (!username) return '';
  return username.replace('@km-tribe', '');
}