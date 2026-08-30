import { runPhase2dSubflowVerification } from "./verify-phase-2d-subflows-lib.mjs";

try {
  runPhase2dSubflowVerification();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nPhase 2D reusable subflows verification stopped: ${message}.\n`);
  process.exitCode =
    typeof error === "object" && error !== null && "exitCode" in error
      ? Number(error.exitCode)
      : 1;
}
