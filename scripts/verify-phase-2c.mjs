import { runPhase2cVerification } from "./verify-phase-2c-lib.mjs";

try {
  runPhase2cVerification();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nPhase 2C verification stopped: ${message}.\n`);
  process.exitCode =
    typeof error === "object" && error !== null && "exitCode" in error
      ? Number(error.exitCode)
      : 1;
}
