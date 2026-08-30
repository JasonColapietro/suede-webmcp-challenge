import { isAbsolute, relative, resolve } from "node:path";
import { tmpdir } from "node:os";

type RuntimeEnvironment = Record<string, string | undefined>;

export function isSafeCaptureRuntime(
  environment: RuntimeEnvironment = process.env,
  temporaryRoot = tmpdir(),
): boolean {
  const sqlitePath = environment.SQLITE_PATH;
  const session = environment.PHASE0_CAPTURE_SESSION;
  if (
    environment.NODE_ENV === "production" ||
    environment.DB_DRIVER !== "sqlite" ||
    environment.X402_SKIP_SETTLEMENT !== "true" ||
    typeof sqlitePath !== "string" ||
    !isAbsolute(sqlitePath) ||
    typeof session !== "string" ||
    session.length < 16
  ) {
    return false;
  }

  const pathFromTemporaryRoot = relative(resolve(temporaryRoot), resolve(sqlitePath));
  return (
    pathFromTemporaryRoot !== "" &&
    !pathFromTemporaryRoot.startsWith("..") &&
    !isAbsolute(pathFromTemporaryRoot)
  );
}
