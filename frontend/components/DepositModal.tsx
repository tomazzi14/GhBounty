"use client";

import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

/**
 * "Deposit" is just receive — the user sends SOL from an external wallet
 * (Phantom / Solflare / exchange withdrawal) to their Privy embedded
 * wallet's address. There is no transaction we sign here; we only show
 * the address + a copy button + a network reminder so the user doesn't
 * dust mainnet SOL into a devnet UI.
 *
 * Once the user has triggered the transfer from their external wallet,
 * the "Refresh balance" button bumps the parent dashboard's `tick`,
 * which re-runs the balance fetch in `CreateBountyForm`. Solana confirms
 * in ~1s on devnet so the new balance shows up after one click.
 */

export function DepositModal({
  walletAddress,
  network,
  onClose,
  onRefresh,
}: {
  walletAddress: string;
  /** Display string for the chain. Right now we only run on devnet, but
   * surfacing it explicitly keeps the user from mailing mainnet SOL into
   * a devnet UI. */
  network: string;
  onClose: () => void;
  onRefresh: () => void;
}) {
  const [copied, setCopied] = useState(false);

  // Lock body scroll + ESC handler. No "busy" gating here — there's
  // nothing in flight that we'd lose by closing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = "";
    };
  }, [onClose]);

  const onCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(walletAddress);
      setCopied(true);
      // Reset the affordance after a beat so subsequent copies feel
      // responsive (without it the button stays pinned at "Copied!").
      window.setTimeout(() => setCopied(false), 1500);
    } catch (err) {
      console.warn("[DepositModal] clipboard write failed:", err);
    }
  }, [walletAddress]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal modal-narrow"
        onClick={(e) => e.stopPropagation()}
      >
        <button
          className="modal-close"
          aria-label="Close"
          onClick={onClose}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>

        <div className="modal-head">
          <div className="eyebrow">Deposit</div>
          <h2 className="modal-title">Receive SOL into your Privy wallet</h2>
        </div>

        <p className="modal-note">
          Send SOL to this address from any external wallet (Phantom,
          Solflare, exchange withdrawal, etc.). It&apos;ll show up here
          after the network confirms — usually about 1 second on devnet.
        </p>

        <div className="deposit-address">
          <code>{walletAddress}</code>
          <button
            type="button"
            className="btn btn-sm wallet-withdraw deposit-copy"
            onClick={onCopy}
          >
            {copied ? "✓ Copied" : "Copy"}
          </button>
        </div>

        <p className="modal-note network-warning">
          Network: <strong>{network}</strong>. Sending mainnet SOL to this
          address will not show up here — the app is locked to devnet for
          MVP testing.
        </p>

        <div className="modal-foot">
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={onClose}
          >
            Close
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={onRefresh}
          >
            Refresh balance
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
