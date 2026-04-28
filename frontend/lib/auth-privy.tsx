"use client";

/**
 * GHB-165: Auth provider backed by Privy + Supabase JWT bridge.
 *
 * Active when NEXT_PUBLIC_USE_PRIVY=1.
 *
 * Pipeline:
 *   1. Privy handles wallet sign-in and exposes `getAccessToken()`.
 *   2. We register that getter with `privy-supabase-bridge` so the Supabase
 *      browser client (which is constructed eagerly) can mint HS256 tokens
 *      via `/api/auth/privy-bridge` and attach them as Authorization headers.
 *   3. RLS policies (`auth.jwt() ->> 'sub'`) match the Privy DID stored in
 *      `profiles.user_id`, unlocking authenticated reads/writes.
 *
 * First-time vs returning users:
 *   - First time: Privy authenticated, but no row in `profiles`. We expose
 *     `needsOnboarding=true` via the user object being null while
 *     `privy.authenticated=true`. The route layer decides what to render
 *     (onboarding form, GHB-165 follow-up).
 *   - Returning: profile exists → we hydrate the User from Supabase, same
 *     shape as the Supabase-Auth path.
 *
 * Mock-style data is no longer injected. Components that depend on `user`
 * will simply see `null` until the profile is persisted.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { PrivyProvider, usePrivy } from "@privy-io/react-auth";
import { toSolanaWalletConnectors } from "@privy-io/react-auth/solana";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createClient } from "@/utils/supabase/client";
import type { Database } from "./db.types";
import type { Company, Dev, User } from "./types";
import { AuthCtx } from "./auth-context";
import {
  clearPrivySession,
  registerPrivyTokenGetter,
} from "./privy-supabase-bridge";

type DBClient = SupabaseClient<Database>;

const APP_ID = process.env.NEXT_PUBLIC_PRIVY_APP_ID ?? "";

const solanaConnectors = toSolanaWalletConnectors({
  shouldAutoConnect: false,
});

function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

async function loadUser(supabase: DBClient, userId: string): Promise<User | null> {
  const { data: profile } = await supabase
    .from("profiles")
    .select("*")
    .eq("user_id", userId)
    .single();
  if (!profile) return null;

  if (profile.role === "company") {
    const { data: company } = await supabase
      .from("companies")
      .select("*")
      .eq("user_id", userId)
      .single();
    if (!company) return null;
    return {
      id: profile.user_id,
      role: "company",
      email: profile.email ?? "",
      name: company.name,
      description: company.description,
      website: company.website ?? undefined,
      industry: company.industry ?? undefined,
      avatarUrl: company.logo_url ?? undefined,
      createdAt: new Date(profile.created_at).getTime(),
    } satisfies Company;
  }

  const { data: dev } = await supabase
    .from("developers")
    .select("*")
    .eq("user_id", userId)
    .single();
  if (!dev) return null;
  return {
    id: profile.user_id,
    role: "dev",
    email: profile.email ?? "",
    username: dev.username,
    bio: dev.bio ?? undefined,
    github: dev.github_handle ?? undefined,
    skills: dev.skills ?? [],
    avatarUrl: dev.avatar_url ?? undefined,
    createdAt: new Date(profile.created_at).getTime(),
  } satisfies Dev;
}

function PrivyAuthInner({ children }: { children: ReactNode }) {
  const privy = usePrivy();
  const supabase = useMemo<DBClient>(() => createClient(), []);
  const [user, setUser] = useState<User | null>(null);
  const [hydrating, setHydrating] = useState(false);
  const lastUserIdRef = useRef<string | null>(null);

  // Step 1: register the Privy access-token getter with the Supabase bridge.
  // The supabase client uses `getSupabaseAccessToken()` on every request, so
  // this MUST happen before any authenticated query fires.
  useEffect(() => {
    if (!privy.ready) return;
    if (privy.authenticated) {
      registerPrivyTokenGetter(() => privy.getAccessToken());
    } else {
      clearPrivySession();
    }
  }, [privy.ready, privy.authenticated, privy]);

  // Step 2: hydrate User from Supabase once Privy is authenticated. If there's
  // no profile row yet, leave `user` null — that signals "needs onboarding".
  useEffect(() => {
    let cancelled = false;
    const privyId = privy.user?.id ?? null;

    if (!privy.ready) return;
    if (!privy.authenticated || !privyId) {
      lastUserIdRef.current = null;
      setUser(null);
      return;
    }
    // Avoid duplicate work if the same user is still authenticated.
    if (lastUserIdRef.current === privyId && user) return;

    setHydrating(true);
    void (async () => {
      const u = await loadUser(supabase, privyId);
      if (cancelled) return;
      lastUserIdRef.current = privyId;
      setUser(u);
      setHydrating(false);
    })();

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [privy.ready, privy.authenticated, privy.user?.id, supabase]);

  const refresh = useCallback(() => {
    const privyId = privy.user?.id ?? null;
    if (!privyId) return;
    setHydrating(true);
    void loadUser(supabase, privyId).then((u) => {
      setUser(u);
      setHydrating(false);
    });
  }, [supabase, privy.user?.id]);

  const loginByEmail = useCallback(async () => {
    privy.login();
    return null;
  }, [privy]);

  const persistCompany = useCallback(
    async (
      data: Omit<Company, "id" | "role" | "createdAt">,
    ): Promise<Company | null> => {
      const privyId = privy.user?.id;
      if (!privyId) return null;

      const { error: profileErr } = await supabase.from("profiles").insert({
        user_id: privyId,
        role: "company",
        email: data.email || null,
        onboarding_completed: true,
      });
      if (profileErr && profileErr.code !== "23505") {
        // 23505 = unique_violation: profile already exists, OK to upsert below.
        throw new Error(`profiles insert: ${profileErr.message}`);
      }

      const slug = slugify(data.name) || privyId.slice(-8);
      const { error: companyErr } = await supabase.from("companies").insert({
        user_id: privyId,
        name: data.name,
        slug,
        description: data.description,
        website: data.website ?? null,
        industry: data.industry ?? null,
        logo_url: data.avatarUrl ?? null,
      });
      if (companyErr) throw new Error(`companies insert: ${companyErr.message}`);

      const u = await loadUser(supabase, privyId);
      if (u && u.role === "company") setUser(u);
      return (u as Company) ?? null;
    },
    [supabase, privy.user?.id],
  );

  const persistDev = useCallback(
    async (
      data: Omit<Dev, "id" | "role" | "createdAt">,
    ): Promise<Dev | null> => {
      const privyId = privy.user?.id;
      if (!privyId) return null;

      const { error: profileErr } = await supabase.from("profiles").insert({
        user_id: privyId,
        role: "dev",
        email: data.email || null,
        onboarding_completed: true,
      });
      if (profileErr && profileErr.code !== "23505") {
        throw new Error(`profiles insert: ${profileErr.message}`);
      }

      const { error: devErr } = await supabase.from("developers").insert({
        user_id: privyId,
        username: data.username,
        github_handle: data.github ?? null,
        bio: data.bio ?? null,
        skills: data.skills,
        avatar_url: data.avatarUrl ?? null,
      });
      if (devErr) throw new Error(`developers insert: ${devErr.message}`);

      const u = await loadUser(supabase, privyId);
      if (u && u.role === "dev") setUser(u);
      return (u as Dev) ?? null;
    },
    [supabase, privy.user?.id],
  );

  const registerCompany = useCallback(
    async (data: Omit<Company, "id" | "role" | "createdAt">): Promise<Company | null> => {
      // If the user hasn't authed with Privy yet, kick off the modal. The
      // caller should re-invoke once `privy.authenticated` flips true.
      if (!privy.authenticated) {
        privy.login();
        return null;
      }
      return persistCompany(data);
    },
    [privy, persistCompany],
  );

  const registerDev = useCallback(
    async (data: Omit<Dev, "id" | "role" | "createdAt">): Promise<Dev | null> => {
      if (!privy.authenticated) {
        privy.login();
        return null;
      }
      return persistDev(data);
    },
    [privy, persistDev],
  );

  const updateUser = useCallback(
    async (patch: Partial<User>) => {
      const current = user;
      if (!current) return;
      setUser({ ...current, ...patch } as User);

      const profilePatch: { email?: string | null } = {};
      if (patch.email !== undefined && patch.email !== current.email) {
        profilePatch.email = patch.email || null;
      }
      if (Object.keys(profilePatch).length > 0) {
        await supabase.from("profiles").update(profilePatch).eq("user_id", current.id);
      }

      if (current.role === "company") {
        const c = patch as Partial<Company>;
        const upd: Partial<Database["public"]["Tables"]["companies"]["Update"]> = {};
        if (c.name !== undefined) {
          upd.name = c.name;
          upd.slug = slugify(c.name) || current.id.slice(-8);
        }
        if (c.description !== undefined) upd.description = c.description;
        if (c.website !== undefined) upd.website = c.website ?? null;
        if (c.industry !== undefined) upd.industry = c.industry ?? null;
        if (c.avatarUrl !== undefined) upd.logo_url = c.avatarUrl ?? null;
        if (Object.keys(upd).length > 0) {
          await supabase.from("companies").update(upd).eq("user_id", current.id);
        }
      } else {
        const d = patch as Partial<Dev>;
        const upd: Partial<Database["public"]["Tables"]["developers"]["Update"]> = {};
        if (d.username !== undefined) upd.username = d.username;
        if (d.github !== undefined) upd.github_handle = d.github ?? null;
        if (d.bio !== undefined) upd.bio = d.bio ?? null;
        if (d.skills !== undefined) upd.skills = d.skills;
        if (d.avatarUrl !== undefined) upd.avatar_url = d.avatarUrl ?? null;
        if (Object.keys(upd).length > 0) {
          await supabase.from("developers").update(upd).eq("user_id", current.id);
        }
      }
    },
    [supabase, user],
  );

  const logout = useCallback(async () => {
    await privy.logout();
    clearPrivySession();
    setUser(null);
  }, [privy]);

  // True only once the Privy session is live, the bridge has had a chance
  // to mint, and Supabase still returned no profile. The route layer uses
  // this to choose between /app/auth and /app/onboarding.
  const pendingOnboarding = privy.ready && privy.authenticated && !hydrating && !user;

  return (
    <AuthCtx.Provider
      value={{
        user,
        // Considered ready once Privy resolved AND any in-flight profile
        // fetch finished. Otherwise pages would briefly render with user=null
        // for returning users while we hydrate from Supabase.
        ready: privy.ready && !hydrating,
        pendingOnboarding,
        loginByEmail,
        registerCompany,
        registerDev,
        updateUser,
        logout,
        refresh,
      }}
    >
      {children}
    </AuthCtx.Provider>
  );
}

export function AuthProvider({ children }: { children: ReactNode }) {
  if (!APP_ID) {
    console.error(
      "[auth-privy] NEXT_PUBLIC_PRIVY_APP_ID missing — Privy provider disabled.",
    );
    return <>{children}</>;
  }

  return (
    <PrivyProvider
      appId={APP_ID}
      config={{
        appearance: {
          theme: "dark",
          accentColor: "#00E5D1",
          showWalletLoginFirst: true,
          walletList: [
            "phantom",
            "solflare",
            "backpack",
            "metamask",
            "coinbase_wallet",
            "wallet_connect",
          ],
        },
        // Both flows are supported. Wallet shows up first because the
        // PrivyProvider config sets `showWalletLoginFirst: true`. Users
        // who only have email get a magic-link / OTP path; their Privy
        // DID still uniquely identifies them, and the bridge route
        // doesn't care how they authenticated.
        loginMethods: ["email", "wallet"],
        embeddedWallets: {
          ethereum: { createOnLogin: "off" },
          solana: { createOnLogin: "off" },
        },
        externalWallets: {
          solana: { connectors: solanaConnectors },
        },
      }}
    >
      <PrivyAuthInner>{children}</PrivyAuthInner>
    </PrivyProvider>
  );
}

/** Re-exported for use inside components that want the raw Privy state. */
export { usePrivy };
