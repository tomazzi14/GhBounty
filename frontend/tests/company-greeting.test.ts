import { describe, expect, it } from "vitest";
import { formatCompanyGreeting } from "@/lib/company-greeting";

describe("formatCompanyGreeting", () => {
  it("falls back when the company name is missing", () => {
    expect(formatCompanyGreeting(undefined)).toBe("Welcome back, there");
    expect(formatCompanyGreeting(null)).toBe("Welcome back, there");
    expect(formatCompanyGreeting("   ")).toBe("Welcome back, there");
  });

  it("preserves the company name when present", () => {
    expect(formatCompanyGreeting("Acme")).toBe("Welcome back, Acme");
    expect(formatCompanyGreeting("  Acme  ")).toBe("Welcome back, Acme");
  });
});
