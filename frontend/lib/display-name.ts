import type { User } from "@/lib/types";

export function appNavDisplayName(user: User): string {
  const rawName = user.role === "company" ? user.name : user.username;
  const name = rawName?.trim();

  if (name) return name;

  return user.role === "company" ? "there" : "Developer";
}
