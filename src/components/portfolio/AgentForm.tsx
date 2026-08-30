"use client";

import { useState } from "react";
import type { Agent, AgentStatus } from "@/lib/portfolio/types";
import { addManualAgent, updateManualAgent, type AgentInput } from "@/lib/portfolio/client-store";
import { CATEGORY_OPTIONS } from "@/lib/portfolio/category";
import { Modal } from "./Modal";
import { Field, controlStyle } from "./fields";

const STATUSES: AgentStatus[] = ["live", "degraded", "down", "paused", "draft"];

function todayISO(): string {
  return new Date().toISOString().slice(0, 10);
}

export function AgentForm({ initial, onClose, onSaved }: { initial?: Agent; onClose: () => void; onSaved: (agent: Agent) => void }) {
  const editing = !!initial;
  const [name, setName] = useState(initial?.name ?? "");
  const [category, setCategory] = useState(initial?.category ?? "");
  const [price, setPrice] = useState(initial ? String(initial.priceUsdc) : "");
  const [status, setStatus] = useState<AgentStatus>(initial?.status ?? "live");
  const [x402Url, setX402Url] = useState(initial?.x402Url ?? "");
  const [wallet, setWallet] = useState(initial?.ownerWallet ?? "");
  const [launchedAt, setLaunchedAt] = useState(initial ? initial.launchedAt.slice(0, 10) : todayISO());
  const [error, setError] = useState("");

  function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!name.trim()) return setError("Give the agent a name.");
    const priceNum = Number(price);
    if (!Number.isFinite(priceNum) || priceNum < 0) return setError("Price/call must be a number ≥ 0.");
    // A cleared date field bypasses the browser's max check and would persist
    // an Invalid Date that throws on every later render of this agent.
    if (!launchedAt || Number.isNaN(Date.parse(launchedAt))) return setError("Pick a launch date.");
    const input: AgentInput = { name, category, priceUsdc: priceNum, status, x402Url, ownerWallet: wallet, launchedAt };
    const agent = editing && initial ? (updateManualAgent(initial.id, input), { ...initial, ...input, priceUsdc: priceNum }) : addManualAgent(input);
    onSaved(agent as Agent);
    onClose();
  }

  return (
    <Modal title={editing ? "Edit agent" : "Track an agent"} onClose={onClose}>
      <form onSubmit={submit} className="flex flex-col gap-4">
        <Field label="Name">
          <input style={controlStyle} value={name} onChange={(e) => setName(e.target.value)} placeholder="External Scraper" autoFocus />
        </Field>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Category">
            <input style={controlStyle} list="agentix-cats" value={category} onChange={(e) => setCategory(e.target.value)} placeholder="Scraping" />
            <datalist id="agentix-cats">
              {CATEGORY_OPTIONS.map((c) => (
                <option key={c} value={c} />
              ))}
            </datalist>
          </Field>
          <Field label="Price / call (USDC)">
            <input style={controlStyle} type="number" inputMode="decimal" step="0.01" min="0" value={price} onChange={(e) => setPrice(e.target.value)} placeholder="0.10" />
          </Field>
        </div>

        <div className="grid grid-cols-2 gap-3">
          <Field label="Status">
            <select style={controlStyle} value={status} onChange={(e) => setStatus(e.target.value as AgentStatus)}>
              {STATUSES.map((s) => (
                <option key={s} value={s}>
                  {s[0].toUpperCase() + s.slice(1)}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Launched">
            <input style={controlStyle} type="date" required value={launchedAt} onChange={(e) => setLaunchedAt(e.target.value)} max={todayISO()} />
          </Field>
        </div>

        <Field label="x402 endpoint URL" hint="Optional: links the agent's listing.">
          <input style={controlStyle} type="url" value={x402Url} onChange={(e) => setX402Url(e.target.value)} placeholder="https://…/api/agents/your-agent/run" />
        </Field>

        <Field label="Payout wallet (Base)" hint="Optional: the address this agent settles to.">
          <input style={{ ...controlStyle, fontFamily: "var(--font-mono)", fontSize: "var(--text-sm)" }} value={wallet} onChange={(e) => setWallet(e.target.value)} placeholder="0x…" />
        </Field>

        {error ? (
          <p style={{ color: "var(--rights-red)", fontSize: "var(--text-sm)" }} role="alert">
            {error}
          </p>
        ) : null}

        <div className="mt-1 flex justify-end gap-2">
          <button type="button" onClick={onClose} className="lp-btn lp-btn--ghost">
            Cancel
          </button>
          <button type="submit" className="lp-btn lp-btn--primary">
            {editing ? "Save changes" : "Track agent"}
          </button>
        </div>
      </form>
    </Modal>
  );
}
