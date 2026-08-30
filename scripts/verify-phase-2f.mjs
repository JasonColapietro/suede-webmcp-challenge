import { runPhase2fVerification } from "./verify-phase-2f-lib.mjs";

try {
  runPhase2fVerification();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `\nPhase 2F version restore and promotion verification stopped: ${message}.\n`,
  );
  process.exitCode =
    typeof error === "object" && error !== null && "exitCode" in error
      ? Number(error.exitCode)
      : 1;
}
