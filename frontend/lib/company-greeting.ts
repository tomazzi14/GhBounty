/**
 * Returns a greeting string for the company dashboard.
 *
 * Trims the company name and falls back to a sensible default
 * when the name is null, undefined, or whitespace-only.
 */
export function getCompanyGreeting(name: string | null | undefined): string {
  if (!name || name.trim().length === 0) {
    return "Welcome back, there";
  }
  return `Welcome back, ${name.trim()}`;
}
