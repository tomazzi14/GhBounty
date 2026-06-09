export function formatCompanyGreeting(name: string | null | undefined): string {
  const trimmed = name?.trim();
  return trimmed ? `Welcome back, ${trimmed}` : "Welcome back, there";
}
