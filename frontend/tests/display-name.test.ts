import { describe, expect, test } from "vitest";
import { appNavDisplayName } from "@/lib/display-name";
import type { User } from "@/lib/types";

function company(overrides: Partial<User> = {}): User {
  return {
    id: "company-1",
    role: "company",
    email: "company@example.com",
    name: "Acme",
    description: "",
    createdAt: 0,
    ...overrides,
  } as User;
}

function dev(overrides: Partial<User> = {}): User {
  return {
    id: "dev-1",
    role: "dev",
    email: "dev@example.com",
    username: "builder",
    skills: [],
    createdAt: 0,
    ...overrides,
  } as User;
}

describe("appNavDisplayName", () => {
  test("preserves a configured company name", () => {
    expect(appNavDisplayName(company({ name: "GhBounty" }))).toBe("GhBounty");
  });

  test("falls back for missing company names", () => {
    expect(appNavDisplayName(company({ name: undefined } as Partial<User>))).toBe(
      "there",
    );
  });

  test("falls back for blank company names", () => {
    expect(appNavDisplayName(company({ name: "   " }))).toBe("there");
  });

  test("preserves a configured developer username", () => {
    expect(appNavDisplayName(dev({ username: "opus-builder" }))).toBe(
      "opus-builder",
    );
  });
});
