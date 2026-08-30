import { runPhase2eVerification } from "./verify-phase-2e-lib.mjs";

try {
  runPhase2eVerification();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nPhase 2E ephemeral scoped tests verification stopped: ${message}.\n`);
  process.exitCode =
    typeof error === "object" && error !== null && "exitCode" in error
      ? Number(error.exitCode)
      : 1;
}
