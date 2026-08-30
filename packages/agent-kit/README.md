# @suedeai/agents

**The Suede SDK is the part you don't have to build.**

One import gives your agent a metered model, a memory, a schedule, a paid endpoint, and a payout
address. You write the run function. Suede runs the rails.

`npm i @suedeai/agents. That's the whole setup.`

---

## Install

```sh
npm i @suedeai/agents
```

## A working, sellable agent in twenty lines.

```ts
import { defineAgent, schedule, paidCall, suede } from "@suedeai/agents";

export default defineAgent({
  name: "price-watcher",
  description: "Watches a product page and emails a brief when the price drops.",
  triggers: [schedule("0 13 * * *"), paidCall(0.25)],
  async run({ input, memory }) {
    const out = await suede.llm({
      system: "Extract the price as a number.",
      prompt: String(input ?? ""),
    });
    const last = await memory.get<number>("lastPrice");
    await memory.set("lastPrice", Number(out.text));
    return { price: out.text, dropped: last !== undefined && Number(out.text) < last };
  },
});
```

---

## API reference (v0)

### `defineAgent(def)`

Validates and freezes an `AgentDefinition`. Throws on invalid input (empty name, empty triggers, etc.).

```ts
interface AgentDefinition {
  name: string;
  description?: string;
  triggers: Trigger[];
  run(ctx: AgentContext): Promise<unknown>;
}
```

### Triggers

- **`schedule(cron: string)`** — schedule trigger; validates the five-field cron expression (UTC).
- **`paidCall(priceUsdc: number)`** — paid endpoint trigger; price must be `>= 0`.
- **`manual()`** — operator-invoked trigger (no schedule, no payment).
- **`webhook()`** — relay-driven trigger (executes via Suede relay — Phase 8).

### `suede.llm({ system, prompt })`

Calls the Suede metered LLM gateway. Returns `{ text: string }`.

Typed errors: `GatewayError` with `.status`:
- `401` — invalid or missing workspace key (claim yours at `/flows`)
- `429` — rate limit exceeded
- `402` — out of gateway credit

**Local development:** set `SUEDE_GATEWAY_STUB=1` to enable offline echo mode — no HTTP, no key needed.
Set `SUEDE_API_URL` to override the platform URL (default: `https://agents.suedeai.ai`).
Set `SUEDE_WORKSPACE_KEY` to your workspace key.

### `createLocalMemory(workdir?)`

Creates a local JSON-file-backed `AgentMemory` instance. Stores data in `<workdir>/.suede/memory.json`.

**v0 caveat:** when self-hosting, memory is local only — it does not sync with the hosted version of
the same agent on the Suede platform. Memory unification is a later pass. If you need shared memory
across the hosted and self-hosted versions, use a shared external store (e.g. a database URL in config)
and inject it into your `run()` function manually.

### `serve(agent, { port })`

Starts a plain `node:http` server exposing:
- `POST /run` — execute the agent's `run()` function. Body: `{ input?: unknown, trigger?: string }`. Returns `{ output }`.
- `GET /manifest` — returns the agent definition minus `run()`.

Returns a `ServeHandle` with `.close()`.

---

## Types

```ts
interface AgentContext {
  input: unknown;
  memory: AgentMemory;
  trigger: "manual" | "schedule" | "paidCall" | "webhook";
}

interface AgentMemory {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
}

type Trigger =
  | { kind: "manual" }
  | { kind: "schedule"; cron: string }
  | { kind: "paidCall"; priceUsdc: number }
  | { kind: "webhook" };
```

---

## v0 caveats

This is SDK v0, released alongside [Suede Agent Studio](https://agents.suedeai.ai) Phase 6.

- The gateway route (`POST /api/gateway/llm`) ships in Phase 9. In v0, use `SUEDE_GATEWAY_STUB=1`
  for local development — the stub echoes your system + prompt without any network call.
- Memory is local-file-only. Hosted memory (tied to your agent's flow state) and sync with
  self-hosted are a later pass.
- The relay (self-hosted agents earning via Suede's paid endpoint) ships in Phase 8.
- The CLI (`suede push`, `suede pull`, etc.) ships in Phase 7.
- No publishing to npm yet — use a local `npm i /path/to/packages/agent-kit` for now.
  Phase 10 is the public publish gate (Jason-gated).

---

## License

MIT · [Jason Colapietro / Suede Labs AI](https://suedeai.ai/founder)
