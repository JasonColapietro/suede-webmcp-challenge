import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createProspectRecord } from "@/lib/company/prospect-engine/engine";
import { SupabaseRepo } from "@/lib/db/supabase-repo";

describe.runIf(process.env.RUN_PROSPECT_PRODUCTION_CANARY === "1")(
  "Prospect Engine production backend canary",
  () => {
    it("creates, reads, and redacts a synthetic prospect through the production repository", async () => {
      const repo = new SupabaseRepo();
      const ownerId = `sb:codex-prospect-canary:${randomUUID()}`;
      const record = createProspectRecord({
        ownerId,
        websiteUrl: "https://example.com/",
        source: { kind: "manual" },
      });

      let created = false;
      try {
        expect(await repo.createProspect(record)).toEqual(record);
        created = true;
        expect(await repo.getProspect(record.id, ownerId)).toEqual(record);
      } finally {
        if (created) expect(await repo.redactProspect(record.id, ownerId)).toBe(true);
      }

      expect(await repo.getProspect(record.id, ownerId)).toBeNull();
    });
  },
);
