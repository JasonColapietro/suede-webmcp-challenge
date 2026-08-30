"use client";

/**
 * Owner dashboard — every flow you've built, every agent you've launched,
 * every run it has done, and what it has earned. Identity is the per-browser
 * owner cookie; nothing here is public. The workspace key at the bottom IS
 * the identity — treat it like a password.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import Link from "next/link";
import SiteNav from "@/components/site/SiteNav";
import SiteFooter from "@/components/site/SiteFooter";
import WorkspaceTabs from "@/components/workspace/WorkspaceTabs";
import { runPillClass, runPillLabel } from "@/lib/runs/status";
import { SEED_TEMPLATES } from "@/lib/templates";
import { describeCron } from "@/lib/cron";
import ProjectContext from "@/components/projects/ProjectContext";
import type { PersonalContext } from "@/lib/projects/types";
import {
  deleteFlowControl,
  parsePersonalContextEnvelope,
  parseVersionSummariesEnvelope,
} from "@/lib/projects/ui-model";
import { COMMIT_TIERS, commitGrantUsdc } from "@/lib/billing";
import { useGooglePlayAccessOnly } from "@/contexts/google-play-access-only-context";
import "../chrome.css";
import "../site.css";
import "../workspace.css";
import "./flows.css";
import { signInUrl } from "@/lib/sign-in-url";

interface MeFlow {
  id: string;
  name: string;
  nodeCount: number;
  updatedAt: number;
}

interface MeSchedule {
  cron: string;
  description: string;
  nextRunAt: number | null;
  lastRunAt: number | null;
}

interface MeAgent {
  id: string;
  flowId: string;
  slug: string;
  status: "draft" | "live";
  priceUsdc: number;
  settlementLive: boolean;
  calls: number;
  earnedUsdc: number;
  settledUsdc: number;
  schedule: MeSchedule | null;
}

interface MeRun {
  id: string;
  flowId: string;
  status: "running" | "done" | "error";
  trigger: string;
  totalCostUsdc: number;
  startedAt: number;
}

interface MeGateway {
  usageThisMonth: number;
  freeMonthlyTokens: number;
  creditBalanceUsdc: number;
}

interface MeResponse {
  ownerId: string;
  identity?: { signedIn: boolean; email: string | null };
  wallet: { address: string; network: string } | null;
  gateway: MeGateway;
  totals: { earnedUsdc: number; settledUsdc: number; calls: number };
  flows: MeFlow[];
  agents: MeAgent[];
  runs: MeRun[];
}

function isMeResponse(v: unknown): v is MeResponse {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.ownerId === "string" &&
    Array.isArray(o.flows) &&
    Array.isArray(o.agents) &&
    Array.isArray(o.runs)
  );
}

function when(ts: number): string {
  const delta = Date.now() - ts;
  const minutes = Math.floor(delta / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function untilShort(ts: number): string {
  const hours = Math.round((ts - Date.now()) / 3_600_000);
  if (hours <= 1) return "within the hour";
  if (hours < 48) return `~${hours}h`;
  return `~${Math.round(hours / 24)}d`;
}

function shortAddr(addr: string): string {
  return `${addr.slice(0, 6)}…${addr.slice(-4)}`;
}

/** Featured starters for the first-run path — pure data, client-safe. */
const STARTERS = SEED_TEMPLATES.slice(0, 3).map((t) => {
  const scheduleNode = t.graph.nodes.find((n) => n.type === "schedule");
  const cron = typeof scheduleNode?.params.cron === "string" ? scheduleNode.params.cron : null;
  return {
    slug: t.slug,
    name: t.name,
    pitch: t.pitch,
    price: t.suggestedPriceUsdc,
    cadence: cron ? describeCron(cron) : null,
    coreNodes: t.graph.nodes.every((n) => !n.type.startsWith("suede.")),
    monthly: scheduleNode ? null : Math.round(t.suggestedPriceUsdc * 50 * 30),
  };
});

const MAX_FLOW_BACKUP_FILE_BYTES = 2 * 1024 * 1024;

/**
 * One-time card top-up tiers, in USDC. Mirrors TOPUP_TIERS in
 * src/lib/gateway/topup-handler.ts, which is server-only (it pulls the x402
 * verify stack) and must never be imported into this client bundle. A source
 * tripwire in tests/flows-money-surfaces.test.ts keeps the two lists in step.
 */
const TOPUP_TIERS = [1, 5, 20] as const;

/** Loose EVM address shape; the server re-validates with viem's isAddress. */
const EVM_ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;

/** The dashboard shows the freshest slice; /runs holds the full history. */
const DASHBOARD_RUN_LIMIT = 8;

/** Price the way a buyer sees it — free is a price, not a missing one. */
function priceLabel(priceUsdc: number): string {
  return priceUsdc === 0 ? "Free" : `$${priceUsdc.toFixed(3)}`;
}

export default function FlowsDashboardPage(): React.JSX.Element {
  const [data, setData] = useState<MeResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [keyShown, setKeyShown] = useState<boolean>(false);
  const [copied, setCopied] = useState<boolean>(false);
  const [claimToken, setClaimToken] = useState<string>("");
  const [claimError, setClaimError] = useState<string | null>(null);
  const [projectContext, setProjectContext] = useState<PersonalContext | null>(null);
  const [versionCounts, setVersionCounts] = useState<Record<string, number>>({});
  const [unknownVersionIds, setUnknownVersionIds] = useState<ReadonlySet<string>>(new Set());
  const [metadataLoading, setMetadataLoading] = useState<boolean>(true);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [topupBusyTier, setTopupBusyTier] = useState<number | null>(null);
  const [showEmptyDrafts, setShowEmptyDrafts] = useState<boolean>(false);
  const [recoveryBusy, setRecoveryBusy] = useState<"backup" | "restore" | null>(null);
  const [recoveryStatus, setRecoveryStatus] = useState<string | null>(null);
  const [flowQuery, setFlowQuery] = useState<string>("");
  const [copiedAgentId, setCopiedAgentId] = useState<string | null>(null);
  const [walletDraft, setWalletDraft] = useState<string>("");
  const [walletBusy, setWalletBusy] = useState<boolean>(false);
  const [walletNotice, setWalletNotice] = useState<
    { tone: "ok" | "error"; text: string } | null
  >(null);
  const [settleAllBusy, setSettleAllBusy] = useState<boolean>(false);
  const restoreInputRef = useRef<HTMLInputElement | null>(null);
  /*
   * True only on the dedicated Android host the Play shell loads. Card and
   * USDC top-ups are Google Play Payments violations inside a Play-distributed
   * binary, so the controls are not rendered there. Web and iOS are untouched:
   * this hides a surface on one host, it does not remove the feature.
   */
  const googlePlayAccessOnly = useGooglePlayAccessOnly();

  const copyAgentLink = useCallback(async (agentId: string, slug: string): Promise<void> => {
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/a/${slug}`);
      setCopiedAgentId(agentId);
      window.setTimeout(() => {
        setCopiedAgentId((current) => (current === agentId ? null : current));
      }, 2000);
    } catch {
      // Clipboard can be denied; the row's public link still works.
    }
  }, []);

  const payByCard = useCallback(async (tier: number): Promise<void> => {
    // Defence in depth. Middleware 403s /api/gateway/topup on the Play host
    // and the controls below are not rendered there, but this keeps the
    // handler itself from ever opening a card checkout in that runtime.
    if (googlePlayAccessOnly) return;
    setTopupBusyTier(tier);
    setError(null);
    try {
      const res = await fetch("/api/gateway/topup/stripe", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tier }),
      });
      const body: unknown = await res.json();
      if (!res.ok || typeof body !== "object" || body === null || !("url" in body)) {
        const message =
          typeof body === "object" && body !== null && "error" in body && typeof body.error === "string"
            ? body.error
            : "Could not start checkout.";
        setError(message);
        setTopupBusyTier(null);
        return;
      }
      window.location.href = (body as { url: string }).url;
    } catch {
      setError("Could not reach the checkout service.");
      setTopupBusyTier(null);
    }
  }, [googlePlayAccessOnly]);

  const load = useCallback(async (): Promise<void> => {
    try {
      const res = await fetch("/api/me");
      if (!res.ok) throw new Error(`Failed to load (${res.status})`);
      const body: unknown = await res.json();
      if (!isMeResponse(body)) throw new Error("Malformed response.");
      setData(body);
      setError(null);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load.");
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const loadProjectMetadata = useCallback(async (flows: readonly MeFlow[]): Promise<void> => {
    setMetadataLoading(true);
    const contextRequest = fetch("/api/v2/context").then(async (res) => {
      if (!res.ok) throw new Error(`Project context failed (${res.status})`);
      const parsed = parsePersonalContextEnvelope(await res.json());
      if (!parsed) throw new Error("Malformed project context.");
      return parsed;
    });
    const versionRequests = flows.map(async (flow) => {
      const res = await fetch(`/api/v2/flows/${encodeURIComponent(flow.id)}/versions`);
      if (!res.ok) throw new Error(`Version history failed (${res.status})`);
      const parsed = parseVersionSummariesEnvelope(await res.json());
      if (!parsed) throw new Error("Malformed version history.");
      return { flowId: flow.id, count: parsed.length };
    });
    const [contextResult, versionResults] = await Promise.all([
      Promise.allSettled([contextRequest]).then(([result]) => result),
      Promise.allSettled(versionRequests),
    ]);
    if (contextResult.status === "fulfilled") setProjectContext(contextResult.value);
    const counts: Record<string, number> = {};
    const unknown = new Set<string>();
    versionResults.forEach((result, index) => {
      const flowId = flows[index]?.id;
      if (!flowId) return;
      if (result.status === "fulfilled") counts[result.value.flowId] = result.value.count;
      else unknown.add(flowId);
    });
    setVersionCounts(counts);
    setUnknownVersionIds(unknown);
    setMetadataError(
      contextResult.status === "rejected" || unknown.size > 0
        ? "Some project metadata is unavailable. Your flows are still ready to open."
        : null,
    );
    setMetadataLoading(false);
  }, []);

  useEffect(() => {
    if (!data) return;
    void loadProjectMetadata(data.flows);
  }, [data, loadProjectMetadata]);

  const [pendingDelete, setPendingDelete] = useState<MeFlow | null>(null);
  const deleteCancelRef = useRef<HTMLButtonElement | null>(null);
  const deleteTriggerRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (pendingDelete) {
      deleteCancelRef.current?.focus();
    } else {
      // Return focus to the row button that opened the dialog so keyboard
      // and screen reader users keep their place in the list.
      deleteTriggerRef.current?.focus();
      deleteTriggerRef.current = null;
    }
  }, [pendingDelete]);
  const handleDelete = useCallback((flow: MeFlow, trigger?: HTMLElement): void => {
    deleteTriggerRef.current = trigger ?? null;
    setPendingDelete(flow);
  }, []);
  // While the dialog is open, everything else in <body> goes inert so screen
  // reader virtual cursors can't reach (or activate) content behind the modal.
  useEffect(() => {
    if (!pendingDelete) return;
    const touched: HTMLElement[] = [];
    for (const child of Array.from(document.body.children)) {
      if (!(child instanceof HTMLElement)) continue;
      if (child.dataset.dialogPortal === "flows-delete" || child.inert) continue;
      child.inert = true;
      touched.push(child);
    }
    return () => {
      for (const el of touched) el.inert = false;
    };
  }, [pendingDelete]);
  const confirmDelete = useCallback(
    async (flow: MeFlow): Promise<void> => {
      setPendingDelete(null);
      setBusyId(flow.id);
      try {
        const res = await fetch(`/api/flows/${flow.id}`, { method: "DELETE" });
        if (!res.ok) throw new Error(`Delete failed (${res.status})`);
        await load();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Delete failed.");
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const handleDuplicate = useCallback(
    async (flow: MeFlow): Promise<void> => {
      setBusyId(flow.id);
      try {
        const res = await fetch(`/api/flows/${flow.id}`);
        if (!res.ok) throw new Error(`Load failed (${res.status})`);
        const body: unknown = await res.json();
        const graph =
          typeof body === "object" && body !== null
            ? (body as { flow?: { graph?: unknown } }).flow?.graph
            : undefined;
        if (!graph || typeof graph !== "object") throw new Error("Malformed flow.");
        const name = `${flow.name} copy`;
        const created = await fetch("/api/flows", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ name, graph: { ...(graph as Record<string, unknown>), name } }),
        });
        if (!created.ok) throw new Error(`Duplicate failed (${created.status})`);
        await load();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Duplicate failed.");
      } finally {
        setBusyId(null);
      }
    },
    [load],
  );

  const handleCopyKey = useCallback(async (): Promise<void> => {
    if (!data) return;
    try {
      await navigator.clipboard.writeText(data.ownerId);
      setCopied(true);
      setTimeout(() => setCopied(false), 1600);
    } catch {
      setKeyShown(true);
    }
  }, [data]);

  const handleClaim = useCallback(async (): Promise<void> => {
    setClaimError(null);
    try {
      const res = await fetch("/api/me/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ token: claimToken.trim() }),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const msg =
          typeof body === "object" && body !== null
            ? (body as { error?: unknown }).error
            : undefined;
        throw new Error(typeof msg === "string" ? msg : `Claim failed (${res.status})`);
      }
      window.location.reload();
    } catch (err: unknown) {
      setClaimError(err instanceof Error ? err.message : "Claim failed.");
    }
  }, [claimToken]);

  const handleSettlementToggle = useCallback(
    async (agent: MeAgent): Promise<void> => {
      try {
        const res = await fetch(`/api/agents/${agent.slug}/settlement`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ live: !agent.settlementLive }),
        });
        if (!res.ok) throw new Error(`Toggle failed (${res.status})`);
        await load();
      } catch (err: unknown) {
        setError(err instanceof Error ? err.message : "Toggle failed.");
      }
    },
    [load],
  );

  /**
   * Turn on Settle for every live, priced agent that isn't collecting yet.
   * Same per-agent opt-in the row toggle uses; this just saves N clicks.
   */
  const handleEnableCollecting = useCallback(async (): Promise<void> => {
    if (!data || settleAllBusy) return;
    const targets = data.agents.filter(
      (a) => a.status === "live" && a.priceUsdc > 0 && !a.settlementLive,
    );
    if (targets.length === 0) return;
    setSettleAllBusy(true);
    setError(null);
    try {
      const results = await Promise.allSettled(
        targets.map((agent) =>
          fetch(`/api/agents/${encodeURIComponent(agent.slug)}/settlement`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ live: true }),
          }).then((res) => {
            if (!res.ok) throw new Error(`Toggle failed (${res.status})`);
          }),
        ),
      );
      const failed = results.filter((r) => r.status === "rejected").length;
      if (failed > 0) {
        setError(
          `Couldn't turn on Settle for ${failed} of ${targets.length} agents. Use the per-agent Settle switch below to retry.`,
        );
      }
      await load();
    } finally {
      setSettleAllBusy(false);
    }
  }, [data, settleAllBusy, load]);

  /**
   * Save a payout wallet from the Earnings panel. The launch route is the
   * only transport that persists a workspace wallet today, so this rides a
   * relaunch of an agent that is ALREADY live: for a live agent that call is
   * an in-place update (same slug, price untouched because priceUsdc is
   * omitted) plus the wallet write. It never launches a draft.
   */
  const handleWalletSave = useCallback(async (): Promise<void> => {
    if (!data || walletBusy) return;
    const address = walletDraft.trim();
    if (!EVM_ADDRESS_RE.test(address)) {
      setWalletNotice({
        tone: "error",
        text: "That doesn't look like a wallet address. Paste the full 0x address (42 characters).",
      });
      return;
    }
    const liveAgent = data.agents.find((a) => a.status === "live");
    if (!liveAgent) {
      setWalletNotice({
        tone: "error",
        text: "Launch an agent first: the wallet is saved with a launch.",
      });
      return;
    }
    setWalletBusy(true);
    setWalletNotice(null);
    try {
      const res = await fetch(`/api/flows/${encodeURIComponent(liveAgent.flowId)}/launch`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ payoutAddress: address }),
      });
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        const message =
          typeof body === "object" && body !== null &&
          typeof Reflect.get(body, "error") === "string"
            ? (Reflect.get(body, "error") as string)
            : `Couldn't save the wallet (${res.status}).`;
        setWalletNotice({ tone: "error", text: message });
        return;
      }
      await load();
      setWalletDraft("");
      setWalletNotice({
        tone: "ok",
        text: `Wallet saved. Settled calls now pay ${shortAddr(address)}.`,
      });
    } catch {
      setWalletNotice({ tone: "error", text: "Couldn't reach the server. Try again." });
    } finally {
      setWalletBusy(false);
    }
  }, [data, walletBusy, walletDraft, load]);

  const handleBackup = useCallback(async (): Promise<void> => {
    setRecoveryBusy("backup");
    setRecoveryStatus(null);
    setError(null);
    try {
      const res = await fetch("/api/flows/backup");
      if (!res.ok) {
        const body: unknown = await res.json().catch(() => null);
        const message = typeof body === "object" && body !== null &&
          typeof Reflect.get(body, "error") === "string"
          ? Reflect.get(body, "error") as string
          : `Backup failed (${res.status})`;
        throw new Error(message);
      }
      const blob = await res.blob();
      const disposition = res.headers.get("content-disposition") ?? "";
      const matchedFilename = /filename="([^"]+)"/u.exec(disposition)?.[1];
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = matchedFilename ?? "suede-agent-studio-flows.json";
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      const count = data?.flows.length ?? 0;
      setRecoveryStatus(
        `Downloaded ${count} saved ${count === 1 ? "flow" : "flows"}. Keep the JSON file private.`,
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Backup failed.");
    } finally {
      setRecoveryBusy(null);
    }
  }, [data]);

  const handleRestore = useCallback(async (file: File): Promise<void> => {
    setRecoveryBusy("restore");
    setRecoveryStatus(null);
    setError(null);
    try {
      if (file.size > MAX_FLOW_BACKUP_FILE_BYTES) {
        throw new Error("That backup is larger than the 2 MB recovery limit.");
      }
      const res = await fetch("/api/flows/backup", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: await file.text(),
      });
      const body: unknown = await res.json().catch(() => null);
      if (!res.ok) {
        const message = typeof body === "object" && body !== null &&
          typeof Reflect.get(body, "error") === "string"
          ? Reflect.get(body, "error") as string
          : `Restore failed (${res.status})`;
        throw new Error(message);
      }
      const restored = typeof body === "object" && body !== null &&
        Number.isSafeInteger(Reflect.get(body, "restored"))
        ? Reflect.get(body, "restored") as number
        : null;
      const skipped = typeof body === "object" && body !== null &&
        Number.isSafeInteger(Reflect.get(body, "skipped"))
        ? Reflect.get(body, "skipped") as number
        : null;
      if (restored === null || skipped === null || restored < 0 || skipped < 0) {
        throw new Error("Restore returned a malformed response.");
      }
      await load();
      setRecoveryStatus(
        restored === 0
          ? `No flows were missing. ${skipped} existing ${skipped === 1 ? "flow was" : "flows were"} left unchanged.`
          : `Restored ${restored} ${restored === 1 ? "flow" : "flows"}.${
              skipped > 0 ? ` ${skipped} existing ${skipped === 1 ? "flow was" : "flows were"} left unchanged.` : ""
            }`,
      );
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Restore failed.");
    } finally {
      setRecoveryBusy(null);
    }
  }, [load]);

  /**
   * One row per flow — the launched agent's status, price, cadence and takings
   * are folded in so a workspace never has to cross-reference two lists to
   * answer "is this thing live, what does it charge, when does it fire".
   */
  const renderFlowRow = (f: MeFlow, agent?: MeAgent): React.JSX.Element => (
    <div key={f.id} className="lp-row fl-row" style={{ cursor: "default" }}>
      <div className="grow">
        <div className="fl-row-title">
          {/* The name opens the agent's hub — the one page that holds its
              whole record. "Open" stays the fast path to the canvas. */}
          <Link href={`/flows/${f.id}`} className="name fl-hub-link">
            {f.name}
          </Link>
          <span className={`lp-pill ${agent?.status === "live" ? "lp-pill--live" : "lp-pill--draft"}`}>
            {agent ? agent.status : "draft"}
          </span>
        </div>
        <div className="sub">
          {agent ? (
            <>
              <Link href={`/a/${agent.slug}`} className="fl-endpoint">
                /a/{agent.slug}
              </Link>
              {" · "}
            </>
          ) : null}
          {f.nodeCount} {f.nodeCount === 1 ? "node" : "nodes"} · updated {when(f.updatedAt)}
        </div>
        <ProjectContext
          context={projectContext}
          versionCount={versionCounts[f.id] ?? 0}
          loading={metadataLoading}
          error={metadataError}
          announce={false}
        />
        {agent ? (
          <>
            <div className="fl-facts">
              <span className="lp-pill lp-pill--price tabular">{priceLabel(agent.priceUsdc)}</span>
              {agent.status === "live" && agent.priceUsdc > 0 && !agent.settlementLive && (
                <span
                  className="lp-pill"
                  style={{ color: "var(--text-warning)" }}
                  title="This agent is live with a price but Settle is off, so every call is served free. Turn on Settle to start collecting."
                >
                  not collecting
                </span>
              )}
              {agent.schedule && (
                <span className="lp-pill lp-pill--sched tabular">
                  runs {agent.schedule.description}
                  {agent.schedule.nextRunAt !== null && ` · next ${untilShort(agent.schedule.nextRunAt)}`}
                </span>
              )}
              <span className="fl-earn tabular">
                {agent.calls} {agent.calls === 1 ? "call" : "calls"} ·{" "}
                <b>${agent.settledUsdc.toFixed(2)}</b> settled
                {/* Honest gap framing: with Settle off nothing is "pending" —
                    those calls were simply served free. */}
                {agent.earnedUsdc > agent.settledUsdc &&
                  (agent.settlementLive
                    ? ` · $${(agent.earnedUsdc - agent.settledUsdc).toFixed(2)} pending settlement`
                    : ` · $${(agent.earnedUsdc - agent.settledUsdc).toFixed(2)} served free`)}
              </span>
            </div>
            <div className="fl-endpoint-controls">
              <button
                type="button"
                className={`lp-iconbtn${copiedAgentId === agent.id ? " fl-copied" : ""}`}
                title="Copy this agent's public link"
                onClick={() => void copyAgentLink(agent.id, agent.slug)}
              >
                {copiedAgentId === agent.id ? "Copied" : "Copy link"}
              </button>
              <span className="sr-only" role="status">
                {copiedAgentId === agent.id ? "Public link copied" : ""}
              </span>
              <button
                type="button"
                className={`lp-iconbtn${agent.settlementLive ? " lp-iconbtn--active fl-settle-on" : ""}`}
                aria-pressed={agent.settlementLive}
                title={
                  agent.settlementLive
                    ? "Settlement live: click to disable"
                    : "Settlement off: click to enable (sends real USDC)"
                }
                onClick={() => void handleSettlementToggle(agent)}
              >
                {agent.settlementLive ? "Settle: ON" : "Settle: OFF"}
              </button>
            </div>
          </>
        ) : null}
        {(() => {
          const known = !metadataLoading && !unknownVersionIds.has(f.id);
          const control = known
            ? deleteFlowControl(versionCounts[f.id] ?? 0)
            : {
                disabled: true,
                reason: metadataLoading
                  ? "Checking saved versions before delete is available."
                  : "Version status unavailable. Retry metadata before deleting.",
              };
          return control.reason ? (
            <span id={`delete-note-${f.id}`} className="lp-row-delete-note">
              {control.reason}
            </span>
          ) : null;
        })()}
      </div>
      <div className="lp-row-actions">
        <Link
          href={`/build/${f.id}`}
          className="lp-btn lp-btn--primary lp-btn--sm"
          style={{ textDecoration: "none" }}
        >
          Open
        </Link>
        <button
          type="button"
          className="lp-iconbtn"
          disabled={busyId === f.id}
          onClick={() => void handleDuplicate(f)}
        >
          Duplicate
        </button>
        <button
          type="button"
          className="lp-iconbtn lp-iconbtn--danger"
          disabled={
            busyId === f.id ||
            metadataLoading ||
            unknownVersionIds.has(f.id) ||
            deleteFlowControl(versionCounts[f.id] ?? 0).disabled
          }
          aria-describedby={
            metadataLoading ||
            unknownVersionIds.has(f.id) ||
            deleteFlowControl(versionCounts[f.id] ?? 0).disabled
              ? `delete-note-${f.id}`
              : undefined
          }
          onClick={(event) => void handleDelete(f, event.currentTarget)}
        >
          Delete
        </button>
      </div>
    </div>
  );

  // Derived once per render: the dashboard's whole job is joining flows to the
  // agents they launched and the runs those agents produced.
  const agentByFlow = new Map<string, MeAgent>((data?.agents ?? []).map((a) => [a.flowId, a]));
  const flowNameById = new Map<string, string>((data?.flows ?? []).map((f) => [f.id, f.name]));
  const liveCount = (data?.agents ?? []).filter((a) => a.status === "live").length;
  const scheduledCount = (data?.agents ?? []).filter((a) => a.schedule !== null).length;
  const draftCount = (data?.flows ?? []).filter((f) => !agentByFlow.has(f.id)).length;
  const collectingCount = (data?.agents ?? []).filter(
    (a) => a.status === "live" && a.settlementLive,
  ).length;
  const notCollectingPriced = (data?.agents ?? []).filter(
    (a) => a.status === "live" && a.priceUsdc > 0 && !a.settlementLive,
  );
  // The earned-minus-settled gap means two different things per agent: money
  // genuinely awaiting settlement (Settle on) vs calls that were served free
  // (Settle off). Summing them into one "pending" number would be a lie.
  const pendingCollectingUsdc = (data?.agents ?? [])
    .filter((a) => a.settlementLive)
    .reduce((sum, a) => sum + Math.max(0, a.earnedUsdc - a.settledUsdc), 0);
  const servedFreeUsdc = (data?.agents ?? [])
    .filter((a) => !a.settlementLive)
    .reduce((sum, a) => sum + Math.max(0, a.earnedUsdc - a.settledUsdc), 0);

  // Money leads for an operating workspace, but on an empty account creating
  // the first agent outranks balances — the same panel renders below the
  // Agents section until a flow exists.
  const moneyPanel = data ? (
    <section
      className="lp-money-panel"
      style={data.flows.length > 0 ? { marginTop: 0 } : undefined}
    >
      <div className="lp-money-col">
        <h2 className="lp-eyebrow">Spend balance</h2>
        <div className="lp-money-figure tabular">
          ${data.gateway.creditBalanceUsdc.toFixed(2)}
        </div>
        <p className="lp-money-sub">
          Prepaid credit for running the LLM gateway.{" "}
          {data.gateway.usageThisMonth.toLocaleString()} of{" "}
          {data.gateway.freeMonthlyTokens.toLocaleString()} free tokens used
          this month.
        </p>
        {googlePlayAccessOnly ? (
          <p className="lp-money-sub" style={{ margin: "0.7rem 0 0" }}>
            Adding credit isn&apos;t available in the Android app. Your
            balance and free monthly tokens work exactly the same here.
          </p>
        ) : (
          <>
            <div
              style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}
            >
              {TOPUP_TIERS.map((tier) => (
                <button
                  key={tier}
                  type="button"
                  className="lp-btn lp-btn--ghost lp-btn--sm"
                  disabled={topupBusyTier !== null}
                  onClick={() => void payByCard(tier)}
                >
                  {topupBusyTier === tier
                    ? "Opening checkout…"
                    : tier === 5
                      // scripts/check-play-billing-contract.mjs (prebuild) pins
                      // this exact literal as its "feature still exists" probe.
                      ? "Add $5 by card"
                      : `Add $${tier} by card`}
                </button>
              ))}
            </div>
            <p className="lp-money-sub" style={{ margin: "0.7rem 0 0" }}>
              Commit up front and every dollar buys more. Same metered gateway,
              nothing recurring.
            </p>
            <div
              style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem", marginTop: "0.15rem" }}
            >
              {COMMIT_TIERS.map((tier) => (
                <button
                  key={tier}
                  type="button"
                  className="lp-btn lp-btn--ghost lp-btn--sm"
                  disabled={topupBusyTier !== null}
                  onClick={() => void payByCard(tier)}
                >
                  {topupBusyTier === tier
                    ? "Opening checkout…"
                    : `Buy $${tier} → $${commitGrantUsdc(tier).toFixed(2)} credit`}
                </button>
              ))}
            </div>
          </>
        )}
      </div>

      <div className="lp-money-divider" aria-hidden="true" />

      <div className="lp-money-col">
        <h2 className="lp-eyebrow">Earnings</h2>
        <Link
          href="/portfolio"
          className="lp-money-figure tabular"
          title="Open the full earnings dashboard"
          style={{
            color: "var(--text-success)",
            textDecoration: "none",
            display: "inline-block",
          }}
        >
          ${data.totals.settledUsdc.toFixed(2)}
        </Link>
        <p className="lp-money-sub">
          Your agents sell while you build. Every settled call lands in
          your wallet.
          {data.totals.calls > 0 &&
            ` ${data.totals.calls} ${data.totals.calls === 1 ? "call" : "calls"} settled so far.`}
          {/* Split the gap honestly: only Settle-on agents have money pending;
              Settle-off agents served those calls free. */}
          {pendingCollectingUsdc > 0 &&
            ` $${pendingCollectingUsdc.toFixed(2)} more is pending settlement.`}
          {servedFreeUsdc > 0 &&
            ` $${servedFreeUsdc.toFixed(2)} of calls were served free with Settle off.`}
        </p>
        {notCollectingPriced.length > 0 && (
          <button
            type="button"
            className="lp-btn lp-btn--ghost lp-btn--sm"
            disabled={settleAllBusy}
            onClick={() => void handleEnableCollecting()}
            style={{ marginBottom: "0.6rem" }}
          >
            {settleAllBusy
              ? "Turning on Settle…"
              : `Turn on Settle to start collecting (${notCollectingPriced.length} ${
                  notCollectingPriced.length === 1 ? "agent" : "agents"
                })`}
          </button>
        )}
        {data.wallet ? (
          <span className="lp-pill lp-pill--live tabular" title={data.wallet.address}>
            pays {shortAddr(data.wallet.address)}
          </span>
        ) : (
          <span
            className="lp-pill"
            style={{ color: "var(--text-warning)" }}
            title="Without a wallet, settled calls can't reach you. Save one below."
          >
            no payout wallet yet
          </span>
        )}
        {(data.agents.some((a) => a.status === "live") || data.wallet) && (
          <div style={{ marginTop: "0.7rem" }}>
            <label
              htmlFor="fl-wallet-input"
              className="lp-eyebrow"
              style={{ display: "block", marginBottom: "0.3rem" }}
            >
              {data.wallet ? "Change payout wallet" : "Save a payout wallet"}
            </label>
            <div style={{ display: "flex", flexWrap: "wrap", gap: "0.5rem" }}>
              <input
                id="fl-wallet-input"
                className="lp-input mono"
                value={walletDraft}
                onChange={(event) => setWalletDraft(event.target.value)}
                placeholder="0x wallet on Base"
                spellCheck={false}
                aria-label="Payout wallet address (USDC on Base)"
                style={{ maxWidth: "22rem" }}
              />
              <button
                type="button"
                className="lp-btn lp-btn--ghost lp-btn--sm"
                disabled={walletBusy || walletDraft.trim() === ""}
                onClick={() => void handleWalletSave()}
              >
                {walletBusy ? "Saving…" : "Save wallet"}
              </button>
            </div>
            {walletNotice && (
              <p
                className="lp-money-sub"
                role={walletNotice.tone === "error" ? "alert" : "status"}
                style={{
                  margin: "0.4rem 0 0",
                  color:
                    walletNotice.tone === "error"
                      ? "var(--text-error)"
                      : "var(--text-success)",
                }}
              >
                {walletNotice.text}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  ) : null;

  return (
    <div className="lp">
      <SiteNav active="/flows" />
      <WorkspaceTabs active="/flows" />
      <main id="main-content" className="lp-shell lp-page">
        {/* One canonical name for this surface: Workspace. It is also the
            nav label, tab label, and footer label — never "My studio",
            "control room", or "fleet" — so the visitor always knows they are
            in the same place they clicked. Compact tool header: an operator
            already knows what the page is for; hand over the controls. */}
        <header className="ws-head">
          <h1>Workspace</h1>
          {data && data.flows.length > 0 && (
            <span className="ws-head-stats">
              <span>
                <b>{liveCount}</b> live
              </span>
              <span>
                <b>{collectingCount}</b> collecting
              </span>
              <span>
                <b>{scheduledCount}</b> on a schedule
              </span>
              <span>
                <b>{draftCount}</b> in draft
              </span>
            </span>
          )}
          <div className="ws-head-actions">
            <Link href="/start" className="lp-btn lp-btn--primary lp-btn--sm">
              New agent →
            </Link>
            <Link href="/templates" className="lp-btn lp-btn--ghost lp-btn--sm">
              Browse templates
            </Link>
          </div>
          <p className="ws-head-sub">
            Every agent you&apos;ve built, what it charges, when it fires, and
            what it has taken in. Open any agent for its full record — runs,
            earnings, and every way to change it.
          </p>
        </header>

        {error && (
          <div className="state-panel state-panel--error" role="alert" style={{ marginBottom: "1.2rem" }}>
            {error}
          </div>
        )}

        {data && data.flows.length > 0 && moneyPanel}

        <section
          className="lp-block"
          style={data && data.flows.length > 0 ? undefined : { marginTop: 0 }}
        >
          <h2 className="lp-eyebrow">Agents</h2>
          {!data ? (
            <div className="lp-loading" role="status">Loading your workspace…</div>
          ) : data.flows.length === 0 ? (
            <div className="lp-empty" style={{ textAlign: "left" }}>
              <b>Your first agent is three clicks away.</b>
              Pick a business below. It opens pre-wired and pre-priced, and one
              Launch puts it in the directory taking paid calls in USDC.
              <div className="lp-rows" style={{ marginTop: "1.1rem" }}>
                {STARTERS.map((t) => (
                  <Link key={t.slug} href={`/build/new?template=${t.slug}`} className="lp-row">
                    <div className="grow">
                      <div className="name">{t.name}</div>
                      <div className="sub">{t.pitch}</div>
                    </div>
                    <span
                      className={`lp-tpl-tag lp-tpl-tag--${t.coreNodes ? "core" : "rails"}`}
                      title={
                        t.coreNodes
                          ? "Runs on the built-in nodes; launches as-is."
                          : "Taps Suede's paid endpoints (audio, rights, registry)."
                      }
                    >
                      {t.coreNodes ? "Core" : "Suede rails"}
                    </span>
                    {t.monthly !== null && (
                      <span
                        className="lp-tpl-est tabular"
                        title="Illustrative: price × 50 calls/day × 30 days."
                      >
                        ~${t.monthly.toLocaleString()}/mo
                      </span>
                    )}
                    {t.cadence && (
                      <span className="lp-pill lp-pill--sched tabular">runs {t.cadence}</span>
                    )}
                    <span className="lp-pill lp-pill--price tabular">${t.price.toFixed(2)}</span>
                  </Link>
                ))}
              </div>
              <div style={{ marginTop: "1.1rem", display: "flex", gap: "0.6rem" }}>
                <Link href="/build/new" className="lp-btn lp-btn--ghost lp-btn--sm">
                  Start from a blank canvas →
                </Link>
              </div>
            </div>
          ) : (
            (() => {
              const query = flowQuery.trim().toLowerCase();
              const matches = (f: MeFlow): boolean =>
                query === "" || f.name.toLowerCase().includes(query);
              const byRecency = (a: MeFlow, b: MeFlow): number => b.updatedAt - a.updatedAt;
              const visible = data.flows.filter(matches);
              // Launched first: those are the rows that earn and the rows an
              // owner scans for trouble. Drafts follow, empties stay folded.
              const launched = visible
                .filter((f) => agentByFlow.has(f.id))
                .sort(byRecency);
              const drafts = visible
                .filter((f) => !agentByFlow.has(f.id) && f.nodeCount > 0)
                .sort(byRecency);
              const empty = visible
                .filter((f) => f.nodeCount === 0 && !agentByFlow.has(f.id))
                .sort(byRecency);
              return (
                <>
                  {data.flows.length > 5 && (
                    <input
                      type="search"
                      className="lp-input"
                      placeholder="Filter flows by name"
                      aria-label="Filter flows by name"
                      value={flowQuery}
                      onChange={(event) => setFlowQuery(event.target.value)}
                      style={{ margin: "0.6rem 0 0.9rem", maxWidth: "26rem", display: "block" }}
                    />
                  )}
                  {launched.length === 0 && drafts.length === 0 && empty.length === 0 && query !== "" ? (
                    <div className="lp-empty" style={{ textAlign: "left" }}>
                      No flows match &ldquo;{flowQuery.trim()}&rdquo;.
                    </div>
                  ) : null}
                  {launched.length > 0 && (
                    <>
                      <h3 className="fl-group-label">Launched · {launched.length}</h3>
                      <div className="lp-rows">
                        {launched.map((f) => renderFlowRow(f, agentByFlow.get(f.id)))}
                      </div>
                    </>
                  )}
                  {drafts.length > 0 && (
                    <>
                      <h3 className="fl-group-label">Not launched yet · {drafts.length}</h3>
                      <div className="lp-rows">{drafts.map((f) => renderFlowRow(f))}</div>
                    </>
                  )}
                  {empty.length > 0 && (
                    <div style={{ marginTop: "0.9rem" }}>
                      <button
                        type="button"
                        className="lp-iconbtn"
                        onClick={() => setShowEmptyDrafts((s) => !s)}
                      >
                        {showEmptyDrafts ? "Hide" : "Show"} {empty.length} empty{" "}
                        {empty.length === 1 ? "draft" : "drafts"}
                      </button>
                      {showEmptyDrafts && (
                        <div className="lp-rows" style={{ marginTop: "0.6rem" }}>
                          {empty.map((f) => renderFlowRow(f))}
                        </div>
                      )}
                    </div>
                  )}
                </>
              );
            })()
          )}
          {metadataError && data && data.flows.length > 0 ? (
            <button
              type="button"
              className="lp-iconbtn project-metadata-retry"
              style={{ marginTop: "0.75rem" }}
              onClick={() => void loadProjectMetadata(data.flows)}
            >
              Retry metadata
            </button>
          ) : null}
        </section>

        {data && data.flows.length === 0 && moneyPanel}

        <section className="lp-block">
          <div className="fl-section-head">
            <h2 className="lp-eyebrow">Recent runs</h2>
            {data && data.runs.length > 0 && (
              <Link href="/runs" className="lp-iconbtn" style={{ textDecoration: "none" }}>
                Full run history
              </Link>
            )}
          </div>
          {!data ? (
            <div className="lp-loading" role="status">Loading…</div>
          ) : data.runs.length === 0 ? (
            <div className="lp-empty">
              Run a flow and its node-by-node cost ledger lands here.
              {data.flows.some((f) => f.nodeCount > 0) && (
                <div style={{ marginTop: "0.9rem" }}>
                  <Link
                    href={`/build/${data.flows.find((f) => f.nodeCount > 0)!.id}`}
                    className="lp-btn lp-btn--ghost lp-btn--sm"
                  >
                    Open a flow and run it →
                  </Link>
                </div>
              )}
            </div>
          ) : (
            <div className="lp-rows">
              {data.runs.slice(0, DASHBOARD_RUN_LIMIT).map((r) => (
                <Link key={r.id} href={`/runs/${r.id}`} className="lp-row fl-run-row">
                  <span className={runPillClass(r.status)}>{runPillLabel(r.status)}</span>
                  <div className="grow">
                    <div className="fl-run-name">{flowNameById.get(r.flowId) ?? "Deleted flow"}</div>
                    <div className="fl-run-meta">
                      {r.trigger} · {when(r.startedAt)}
                    </div>
                  </div>
                  <span className="lp-pill tabular fl-run-cost">${r.totalCostUsdc.toFixed(3)}</span>
                </Link>
              ))}
            </div>
          )}
        </section>

        <section className="lp-block">
          <h2 className="lp-eyebrow">Flow recovery</h2>
          <div className="lp-rows">
            <div className="lp-row" style={{ cursor: "default", alignItems: "flex-start" }}>
              <div className="grow">
                <div className="name">Keep a copy you control.</div>
                <div className="sub" style={{ marginTop: "0.35rem", maxWidth: "64ch" }}>
                  Download every saved flow in this workspace as one versioned JSON file;
                  run and agent history is not included.
                  Restore adds only missing flow IDs and never overwrites a current flow.
                  Backups can contain prompts and configuration, so store them privately.
                </div>
                {recoveryStatus && (
                  <div className="sub" role="status" style={{ color: "var(--text-success)", marginTop: "0.5rem" }}>
                    {recoveryStatus}
                  </div>
                )}
              </div>
              <div className="lp-row-actions">
                <button
                  type="button"
                  className="lp-btn lp-btn--ghost lp-btn--sm"
                  disabled={!data || recoveryBusy !== null}
                  onClick={() => void handleBackup()}
                >
                  {recoveryBusy === "backup" ? "Preparing backup…" : "Back up all flows"}
                </button>
                <button
                  type="button"
                  className="lp-btn lp-btn--ghost lp-btn--sm"
                  disabled={recoveryBusy !== null}
                  onClick={() => restoreInputRef.current?.click()}
                >
                  {recoveryBusy === "restore" ? "Restoring…" : "Restore backup"}
                </button>
                <input
                  ref={restoreInputRef}
                  type="file"
                  accept="application/json,.json"
                  aria-label="Choose a flow backup to restore"
                  hidden
                  onChange={(event) => {
                    const file = event.currentTarget.files?.[0];
                    event.currentTarget.value = "";
                    if (file) void handleRestore(file);
                  }}
                />
              </div>
            </div>
          </div>
        </section>

        <section className="lp-block">
          <h2 className="lp-eyebrow">Workspace key</h2>
          <div className="lp-rows">
            <div className="lp-row" style={{ cursor: "default", flexWrap: "wrap" }}>
              <div className="grow">
                <div className="name">
                  {data?.identity?.signedIn
                    ? `Signed in with Suede${data.identity.email ? ` as ${data.identity.email}` : ""}.`
                    : "Sign in with Suede."}
                </div>
                <div className="sub">
                  {data?.identity?.signedIn
                    ? "This workspace is tied to your Suede account (the same login as Suede Social and Muse), so it follows you across browsers and devices."
                    : "One Suede login (the same account as Suede Social and Muse) makes this workspace yours on every device. Your current anonymous workspace merges in automatically on first sign-in."}
                </div>
              </div>
              {data?.identity?.signedIn ? (
                <div className="lp-row-actions">
                  <Link className="lp-iconbtn" href="/account-deletion">
                    Account settings
                  </Link>
                </div>
              ) : (
                <div className="lp-row-actions">
                  <a
                    className="lp-iconbtn"
                    href={signInUrl("https://agents.suedeai.ai/flows")}
                  >
                    Sign in with Suede
                  </a>
                </div>
              )}
            </div>
            <div className="lp-row" style={{ cursor: "default", flexWrap: "wrap" }}>
              <div className="grow">
                <div className="name">This key IS your workspace.</div>
                <div className="sub">
                  Your flows live behind a private key in this browser. Copy it
                  to claim the same workspace on another device, and treat it
                  like a password: anyone holding it controls your agents.
                </div>
                {keyShown && data && (
                  <div
                    className="mono"
                    style={{
                      marginTop: 8,
                      fontFamily: "var(--font-mono)",
                      fontSize: "var(--text-sm)",
                      wordBreak: "break-all",
                    }}
                  >
                    {data.ownerId}
                  </div>
                )}
              </div>
              <div className="lp-row-actions">
                <button type="button" className="lp-iconbtn" onClick={() => setKeyShown((s) => !s)}>
                  {keyShown ? "Hide" : "Reveal"}
                </button>
                <button type="button" className="lp-iconbtn" onClick={() => void handleCopyKey()}>
                  {copied ? "Copied ✓" : "Copy"}
                </button>
              </div>
            </div>
            <div className="lp-row" style={{ cursor: "default", flexWrap: "wrap" }}>
              <div className="grow">
                <div className="name">Claim a workspace on this device.</div>
                <div className="sub">
                  Paste a key from another browser to take over that workspace here.
                </div>
                {claimError && (
                  <div className="sub" role="alert" style={{ color: "var(--text-error)" }}>
                    {claimError}
                  </div>
                )}
              </div>
              <div className="lp-row-actions" style={{ gap: 8 }}>
                <input
                  value={claimToken}
                  onChange={(e) => setClaimToken(e.target.value)}
                  placeholder="paste workspace key"
                  aria-label="Workspace key to claim"
                  spellCheck={false}
                  className="mono lp-claim-input"
                />
                <button
                  type="button"
                  className="lp-iconbtn"
                  disabled={claimToken.trim() === ""}
                  onClick={() => void handleClaim()}
                >
                  Claim
                </button>
              </div>
            </div>
          </div>
        </section>

        {pendingDelete && createPortal(
          <div
            className="flow-impact-dialog__backdrop"
            data-dialog-portal="flows-delete"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) setPendingDelete(null);
            }}
          >
            <div
              className="flow-impact-dialog"
              role="alertdialog"
              aria-modal="true"
              aria-labelledby="delete-flow-title"
              aria-describedby="delete-flow-desc"
              tabIndex={-1}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  setPendingDelete(null);
                  return;
                }
                if (event.key !== "Tab") return;
                const dialog = event.currentTarget;
                const focusable = [
                  ...dialog.querySelectorAll<HTMLElement>("button:not([disabled])"),
                ];
                if (focusable.length === 0) return;
                const first = focusable[0]!;
                const last = focusable.at(-1)!;
                if (event.shiftKey && document.activeElement === first) {
                  event.preventDefault();
                  last.focus();
                } else if (!event.shiftKey && document.activeElement === last) {
                  event.preventDefault();
                  first.focus();
                }
              }}
            >
              <header className="flow-impact-dialog__heading">
                <span className="eyebrow">Delete flow</span>
                <h2 id="delete-flow-title">Delete &ldquo;{pendingDelete.name}&rdquo;?</h2>
                <p id="delete-flow-desc">
                  {data?.agents.some((a) => a.flowId === pendingDelete.id)
                    ? "This flow has a launched agent. Deleting it takes the agent off the directory and its endpoint stops answering. "
                    : ""}
                  Its run history goes with it. This can&apos;t be undone.
                </p>
              </header>
              <div className="flow-impact-dialog__actions">
                <button
                  ref={deleteCancelRef}
                  type="button"
                  onClick={() => setPendingDelete(null)}
                >
                  Keep it
                </button>
                <button
                  type="button"
                  className="flow-impact-dialog__confirm"
                  onClick={() => void confirmDelete(pendingDelete)}
                >
                  Delete flow
                </button>
              </div>
            </div>
          </div>,
          document.body,
        )}
      </main>
      <SiteFooter />
    </div>
  );
}
