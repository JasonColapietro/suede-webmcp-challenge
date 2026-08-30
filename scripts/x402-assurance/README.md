# x402 Offer Assurance Runbook

Automated implementation of the vault spec `06_agents/X402_Offer_Assurance_Runbook.md`. Runs Tiers A, B, C1, C2, D (all read-only HTTP/chain reads); C3 (live paid canary) always reports BLOCKED — it requires a Jason-authorized funded wallet and is out of scope here.

## Run manually

```bash
node scripts/x402-assurance/run.mjs
```

Prints the verdict table, known-defect table, and escalation summary to stdout, and writes the same report as a vault handoff at:

```
Codex Claude Memory Vault/05_handoffs/YYYY-MM-DD-x402-assurance-cron-x402-assurance-run.md
```

Exit codes: `0` clean or only pre-registered known defects, `1` an unattributed FAIL appeared, `2` a critical escalation fired (payment bypass, dry-run settled, or zero payTo), `3` the script crashed.

## Schedule

Runs daily via launchd job `com.suede.x402-assurance-runbook` (`~/Library/LaunchAgents/com.suede.x402-assurance-runbook.plist`). Logs land in `logs/` (gitignored) in this directory.

```bash
launchctl list | grep x402-assurance          # check it's loaded
launchctl start com.suede.x402-assurance-runbook   # force a run now
```

## Boundaries (from the spec)

Report only — never edits prices, wallets, discovery documents, env vars, or code. Never sends funds. Never marks PASS on assumption; unreachable checks are BLOCKED, not PASS.
