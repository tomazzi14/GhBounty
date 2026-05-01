"use client";

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { Avatar } from "./Avatar";
import {
  fetchSubmissionsForBountyDetailed,
  type EnrichedSubmission,
} from "@/lib/data";
import type { Bounty } from "@/lib/types";

/**
 * Company-side review modal — shows every PR submitted for a bounty,
 * with the dev's profile, the AI score (if computed), and a "recommended
 * to reject" hint when the score is below the bounty's
 * `reject_threshold`.
 *
 * Read-only for now: the company sees the data and can click through to
 * GitHub. Approve / reject actions live in a follow-up ticket once the
 * scoring pipeline (Opus + GenLayer) actually fills in scores.
 */

export function SubmissionsListModal({
  bounty,
  onClose,
}: {
  bounty: Bounty;
  onClose: () => void;
}) {
  const [items, setItems] = useState<EnrichedSubmission[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Lock body scroll + ESC handler. No "busy" gating because nothing
  // here mutates state we'd lose by closing.
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

  useEffect(() => {
    let cancelled = false;
    setError(null);
    setItems(null);
    fetchSubmissionsForBountyDetailed(bounty.id, bounty.rejectThreshold ?? null)
      .then((rows) => {
        if (!cancelled) setItems(rows);
      })
      .catch((err) => {
        console.error("[SubmissionsListModal] fetch failed:", err);
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Failed to load submissions.");
          setItems([]);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [bounty.id, bounty.rejectThreshold]);

  if (typeof document === "undefined") return null;
  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal modal-wide" onClick={(e) => e.stopPropagation()}>
        <button className="modal-close" aria-label="Close" onClick={onClose}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>

        <div className="modal-head">
          <div className="eyebrow">Submissions</div>
          <h2 className="modal-title">
            <span className="mono-inline">{bounty.repo}</span>{" "}
            <span className="bounty-hash">#{bounty.issueNumber}</span>
          </h2>
          {bounty.title && <p className="modal-note">{bounty.title}</p>}
          <div className="submissions-meta">
            <span>
              {(items?.length ?? 0)} PR{(items?.length ?? 0) === 1 ? "" : "s"}
            </span>
            <span className="submissions-meta-sep">·</span>
            <span>
              {bounty.rejectThreshold != null
                ? `Auto-reject below ${bounty.rejectThreshold}/10`
                : "No auto-rejection"}
            </span>
          </div>
        </div>

        {error && <div className="form-error">{error}</div>}

        {items === null ? (
          <div className="submissions-loading">
            <span className="loading-dot" />
            <span>Loading submissions…</span>
          </div>
        ) : items.length === 0 ? (
          <div className="empty">
            <p>No submissions yet.</p>
            <p className="muted">
              When developers submit PRs against this bounty, they&apos;ll
              show up here with their AI scores.
            </p>
          </div>
        ) : (
          <ul className="submissions-list">
            {items.map((s) => (
              <SubmissionCard key={s.id} submission={s} />
            ))}
          </ul>
        )}

        <div className="modal-foot">
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function SubmissionCard({ submission: s }: { submission: EnrichedSubmission }) {
  const displayName = s.dev.username || s.dev.email || "Anonymous dev";
  const score = s.evaluation?.score ?? null;
  const isWinner = s.state === "winner";

  return (
    <li className="submission-card">
      <div className="submission-card-head">
        <div className="submission-dev">
          <Avatar src={s.dev.avatarUrl} name={displayName} size={32} />
          <div className="submission-dev-meta">
            <span className="submission-dev-name">{displayName}</span>
            {s.dev.githubHandle && (
              <a
                href={`https://github.com/${s.dev.githubHandle}`}
                target="_blank"
                rel="noopener noreferrer"
                className="submission-dev-handle"
              >
                @{s.dev.githubHandle}
              </a>
            )}
          </div>
        </div>
        <div className="submission-card-badges">
          {isWinner && (
            <span className="submission-badge submission-badge-winner">
              ★ Winner
            </span>
          )}
          {!isWinner && s.recommendedReject && (
            <span className="submission-badge submission-badge-reject">
              Recommended to reject
            </span>
          )}
          {score !== null ? (
            <span
              className={`submission-score ${
                s.recommendedReject ? "submission-score-low" : ""
              }`}
            >
              {score}/10
            </span>
          ) : (
            <span className="submission-score submission-score-pending">
              Pending review
            </span>
          )}
        </div>
      </div>

      <a
        href={s.prUrl}
        target="_blank"
        rel="noopener noreferrer"
        className="submission-pr-link"
      >
        <span className="mono-inline">{s.prRepo}</span>{" "}
        <span className="bounty-hash">#{s.prNumber}</span>
      </a>

      {s.note && <p className="submission-note">{s.note}</p>}

      {s.evaluation?.reasoning && (
        <details className="submission-reasoning">
          <summary>AI reasoning</summary>
          <p>{s.evaluation.reasoning}</p>
        </details>
      )}

      <div className="submission-card-foot">
        <span className="submission-time">
          {timeAgo(s.createdAt)}
          {s.evaluation?.source && (
            <>
              {" · scored by "}
              <span className="mono-inline">{s.evaluation.source}</span>
            </>
          )}
        </span>
        <a
          href={s.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="btn btn-ghost btn-sm"
        >
          View PR
        </a>
      </div>
    </li>
  );
}

function timeAgo(ms: number): string {
  const diff = Date.now() - ms;
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}
