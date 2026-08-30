import { runPhase3aVerification } from "./verify-phase-3a-lib.mjs";

try {
  runPhase3aVerification();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nPhase 3A durable runtime verification stopped: ${message}.\n`);
  process.exitCode =
    typeof error === "object" && error !== null && "exitCode" in error
      ? Number(error.exitCode)
      : 1;
}
