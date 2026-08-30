import { runPhase2dVerification } from "./verify-phase-2d-lib.mjs";

try {
  runPhase2dVerification();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nPhase 2D verification stopped: ${message}.\n`);
  process.exitCode =
    typeof error === "object" && error !== null && "exitCode" in error
      ? Number(error.exitCode)
      : 1;
}
