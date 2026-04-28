"use client";

/**
 * Auth bypass for testing data layer without real auth.
 *
 * Activated when NEXT_PUBLIC_AUTH_BYPASS=1.
 *
 * Defaults to a fake company user. To switch to a fake dev user, run
 * in the browser console:
 *   localStorage.setItem("bypassRole", "dev"); location.reload();
 *
 * The fake user.id can be overridden via localStorage too, in case
 * you want it to match a real Supabase row:
 *   localStorage.setItem("bypassUserId", "<uuid>");
 *
 * DO NOT enable this in production once real auth is live.
 */

import { useCallback, useEffect, useState } from "react";
import type { ReactNode } from "react";
import type { Company, Dev, User } from "./types";
import { AuthCtx } from "./auth-context";

const FAKE_COMPANY: Company = {
  id: "00000000-0000-0000-0000-00000000c001",
  role: "company",
  email: "bypass@company.test",
  name: "Bypass Company",
  description: "Fake company injected by NEXT_PUBLIC_AUTH_BYPASS.",
  website: "https://example.com",
  industry: "Testing",
  avatarUrl: undefined,
  createdAt: Date.now(),
};

const FAKE_DEV: Dev = {
  id: "00000000-0000-0000-0000-00000000d001",
  role: "dev",
  email: "bypass@dev.test",
  username: "bypass-dev",
  github: "bypass-dev",
  bio: "Fake dev injected by NEXT_PUBLIC_AUTH_BYPASS.",
  skills: ["typescript", "react"],
  avatarUrl: undefined,
  createdAt: Date.now(),
};

function readBypassUser(): User {
  if (typeof window === "undefined") return FAKE_COMPANY;
  const role = window.localStorage.getItem("bypassRole");
  const overrideId = window.localStorage.getItem("bypassUserId");
  const base = role === "dev" ? FAKE_DEV : FAKE_COMPANY;
  return overrideId ? { ...base, id: overrideId } : base;
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    setUser(readBypassUser());
    setReady(true);
  }, []);

  const noopUser = useCallback(async () => null, []);
  const refresh = useCallback(() => setUser(readBypassUser()), []);
  const logout = useCallback(async () => setUser(null), []);
  const updateUser = useCallback(async (patch: Partial<User>) => {
    setUser((current) => (current ? ({ ...current, ...patch } as User) : current));
  }, []);

  return (
    <AuthCtx.Provider
      value={{
        user,
        ready,
        loginByEmail: noopUser,
        registerCompany: noopUser as never,
        registerDev: noopUser as never,
        updateUser,
        logout,
        refresh,
      }}
    >
      {children}
    </AuthCtx.Provider>
  );
}
