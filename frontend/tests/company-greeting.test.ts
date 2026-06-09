import { describe, expect, test } from "vitest";
import { companyGreeting } from "@/lib/company-greeting";

describe("companyGreeting", () => {
  test("falls back when the company name is missing", () => {
    expect(companyGreeting(undefined)).toBe("Welcome back, there");
    expect(companyGreeting(null)).toBe("Welcome back, there");
    expect(companyGreeting("   ")).toBe("Welcome back, there");
  });

  test("preserves the existing greeting when the company name exists", () => {
    expect(companyGreeting("Acme")).toBe("Welcome back, Acme");
  });
});
