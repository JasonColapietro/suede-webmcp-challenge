"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import {
  parseResourceCreateResponse,
  resourceJsonRequest,
  resourceMutationAllowedForHost,
  writeResourcePackPointer,
} from "./client";

type StarterId = "refinery" | "readiness" | "archive";
type ExecutionAccess = "free" | "paid" | "private";
type DiscoveryAccess = "public" | "unlisted";
type FieldType = "string" | "number" | "integer" | "boolean";

interface StarterBrief {
  readonly id: StarterId;
  readonly name: string;
  readonly suggestion: string;
  readonly jobStatement: string;
  readonly buyerIntent: string;
}

const STARTERS: readonly StarterBrief[] = [
  {
    id: "refinery", name: "Niche Data Refinery", suggestion: "Local pricing signals",
    jobStatement: "Return reviewed records for one bounded market question.",
    buyerIntent: "Compare a named market signal without rereading every source.",
  },
  {
    id: "readiness", name: "Agent Readiness", suggestion: "Company answer ledger",
    jobStatement: "Return the current reviewed answer to one buyer-agent question.",
    buyerIntent: "Understand and compare a company from its approved source of truth.",
  },
  {
    id: "archive", name: "Expert Archive", suggestion: "Expert method finder",
    jobStatement: "Return one evidence-backed method for a named expert task.",
    buyerIntent: "Apply a specific archived method without using a generic chat interface.",
  },
] as const;

function slugify(value: string): string {
  const slug = value.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "").slice(0, 140);
  return slug || "resource-product";
}

function commaList(value: string): readonly string[] {
  const fields = value.split(",").map((field) => field.trim()).filter(Boolean);
  if (new Set(fields).size !== fields.length || fields.some((field) => !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(field))) {
    throw new Error("Use unique comma-separated field names (letters, numbers, _ or -).");
  }
  return fields;
}

export function buildTypedResourceBrief(input: {
  readonly jobStatement: string;
  readonly buyerIntent: string;
  readonly fields: string;
  readonly filterFields: string;
  readonly returnFields: string;
  readonly taxonomy: string;
}): Readonly<Record<string, unknown>> {
  const declarations = input.fields.split(",").map((field) => field.trim()).filter(Boolean);
  if (declarations.length === 0) throw new Error("Declare at least one typed record field.");
  const properties: Record<string, { readonly type: FieldType }> = {};
  for (const declaration of declarations) {
    const [name, rawType = "string", ...extra] = declaration.split(":").map((part) => part.trim());
    if (!name || extra.length > 0 || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(name) ||
        !["string", "number", "integer", "boolean"].includes(rawType)) {
      throw new Error("Declare fields as name:string, score:number, count:integer, or active:boolean.");
    }
    if (Object.hasOwn(properties, name)) throw new Error("Field names must be unique.");
    properties[name] = { type: rawType as FieldType };
  }
  const filters = commaList(input.filterFields);
  const returns = commaList(input.returnFields);
  if (returns.length === 0 || [...filters, ...returns].some((field) => !Object.hasOwn(properties, field))) {
    throw new Error("Filter and return fields must be declared record fields; return at least one field.");
  }
  const taxonomy = commaList(input.taxonomy).map((id) => ({ id, label: id.replaceAll("-", " ") }));
  const recordSchema = { type: "object", properties, required: Object.keys(properties), additionalProperties: false } as const;
  const resultProperties = Object.fromEntries(returns.map((field) => [field, properties[field]!])) as Record<string, { readonly type: FieldType }>;
  const example = Object.fromEntries(returns.map((field) => {
    const type = properties[field]!.type;
    return [field, type === "string" ? "Reviewed example" : type === "boolean" ? false : 0];
  }));
  return Object.freeze({
    jobStatement: input.jobStatement.trim(), buyerIntent: input.buyerIntent.trim(),
    inputSchema: {
      type: "object",
      properties: Object.fromEntries(filters.map((field) => [field, properties[field]!])),
      required: [], additionalProperties: false,
    },
    outputSchema: {
      type: "array",
      items: { type: "object", properties: resultProperties, required: returns, additionalProperties: false },
    },
    safeExample: [example], recordSchema, filterFields: filters, returnFields: returns, taxonomy,
  });
}

export default function ResourceCreateForm(): React.JSX.Element {
  const router = useRouter();
  const [starterId, setStarterId] = useState<StarterId>("refinery");
  const [name, setName] = useState(STARTERS[0].suggestion);
  const [jobStatement, setJobStatement] = useState(STARTERS[0].jobStatement);
  const [buyerIntent, setBuyerIntent] = useState(STARTERS[0].buyerIntent);
  const [executionAccess, setExecutionAccess] = useState<ExecutionAccess>("free");
  const [discoveryAccess, setDiscoveryAccess] = useState<DiscoveryAccess>("unlisted");
  const [fields, setFields] = useState("text:string");
  const [filterFields, setFilterFields] = useState("");
  const [returnFields, setReturnFields] = useState("text");
  const [taxonomy, setTaxonomy] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const playDenied = typeof window !== "undefined" && !resourceMutationAllowedForHost(window.location.host);

  const chooseStarter = (next: StarterBrief): void => {
    setStarterId(next.id);
    setName(next.suggestion);
    setJobStatement(next.jobStatement);
    setBuyerIntent(next.buyerIntent);
    setNotice(null);
  };

  const onSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (busy || playDenied) return;
    setBusy(true);
    setNotice(null);
    try {
      const brief = buildTypedResourceBrief({ jobStatement, buyerIntent, fields, filterFields, returnFields, taxonomy });
      const created = parseResourceCreateResponse(await resourceJsonRequest("/api/v2/resources", {
        method: "POST",
        body: JSON.stringify({
          name: name.trim(), slug: slugify(name), executionAccess, discoveryAccess, brief,
        }),
      }));
      writeResourcePackPointer(created.resource.id, created.candidate);
      router.push(`/resources/${encodeURIComponent(created.resource.id)}?tab=sources`);
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "The resource could not be created.");
      setBusy(false);
    }
  };

  return (
    <>
      <header className="ws-head resource-page-head">
        <p className="resource-kicker">Entry brief</p>
        <h1>Frame one resource-backed job</h1>
        <p className="ws-head-sub">Choose a starting lens, narrow the job, then add a manual source next.</p>
      </header>

      <form className="resource-create" onSubmit={(event) => void onSubmit(event)}>
        <fieldset className="resource-starters">
          <legend>Starter brief</legend>
          <p>All three continue through the same seven release stages.</p>
          <div className="resource-starter-list">
            {STARTERS.map((item) => (
              <button
                key={item.id}
                type="button"
                className="resource-starter-row"
                aria-pressed={starterId === item.id}
                onClick={() => chooseStarter(item)}
              >
                <strong>{item.name}</strong>
                <span>{item.jobStatement}</span>
              </button>
            ))}
          </div>
        </fieldset>

        <section className="resource-form-pane" aria-labelledby="resource-brief-fields">
          <h2 id="resource-brief-fields">Brief</h2>
          <label>
            Resource name
            <input value={name} onChange={(event) => setName(event.target.value)} maxLength={160} required />
          </label>
          <label>
            Narrow job
            <textarea value={jobStatement} onChange={(event) => setJobStatement(event.target.value)} maxLength={4096} required />
          </label>
          <label>
            Buyer or buying-agent intent
            <textarea value={buyerIntent} onChange={(event) => setBuyerIntent(event.target.value)} maxLength={4096} required />
          </label>
          <label>
            Execution access
            <select value={executionAccess} onChange={(event) => setExecutionAccess(event.target.value as ExecutionAccess)}>
              <option value="free">Free</option>
              <option value="paid">Paid</option>
              <option value="private">Private</option>
            </select>
          </label>
          <label>
            Discovery access
            <select value={discoveryAccess} onChange={(event) => setDiscoveryAccess(event.target.value as DiscoveryAccess)}>
              <option value="unlisted">Unlisted</option>
              <option value="public">Public</option>
            </select>
          </label>
          <label>
            Typed record fields
            <input value={fields} onChange={(event) => setFields(event.target.value)} maxLength={1024} required placeholder="name:string, score:number, active:boolean" />
          </label>
          <label>
            Filter fields
            <input value={filterFields} onChange={(event) => setFilterFields(event.target.value)} maxLength={1024} placeholder="name, active" />
          </label>
          <label>
            Return fields
            <input value={returnFields} onChange={(event) => setReturnFields(event.target.value)} maxLength={1024} required placeholder="name, score" />
          </label>
          <label>
            Taxonomy tags
            <input value={taxonomy} onChange={(event) => setTaxonomy(event.target.value)} maxLength={1024} placeholder="priority, enterprise" />
          </label>
          <div className="resource-form-action">
            <button type="submit" className="lp-btn lp-btn--primary" disabled={busy || playDenied || name.trim() === "" || jobStatement.trim() === "" || buyerIntent.trim() === ""}>
              {busy ? "Creating…" : "Create and add a manual source next →"}
            </button>
            {playDenied && <p role="alert">Resource mutations are unavailable in this Google Play build.</p>}
            <p aria-live="polite">{notice}</p>
          </div>
        </section>
      </form>
    </>
  );
}
