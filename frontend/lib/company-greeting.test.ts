import { describe, expect, test } from "vitest";
import { getCompanyGreeting } from "./company-greeting";

describe("getCompanyGreeting", () => {
  test("returns greeting with trimmed name for a valid name", () => {
    expect(getCompanyGreeting("Acme Corp")).toBe("Welcome back, Acme Corp");
  });

  test("trims whitespace from name", () => {
    expect(getCompanyGreeting("  Acme Corp  ")).toBe("Welcome back, Acme Corp");
  });

  test('falls back to "Welcome back, there" for null', () => {
    expect(getCompanyGreeting(null)).toBe("Welcome back, there");
  });

  test('falls back to "Welcome back, there" for undefined', () => {
    expect(getCompanyGreeting(undefined)).toBe("Welcome back, there");
  });

  test('falls back to "Welcome back, there" for empty string', () => {
    expect(getCompanyGreeting("")).toBe("Welcome back, there");
  });

  test('falls back to "Welcome back, there" for whitespace-only string', () => {
    expect(getCompanyGreeting("   ")).toBe("Welcome back, there");
  });
});
