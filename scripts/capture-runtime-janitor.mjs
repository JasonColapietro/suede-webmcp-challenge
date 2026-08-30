import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, relative, resolve } from "node:path";

const parentPid = Number(process.argv[2]);
const childPid = Number(process.argv[3]);
const directory = process.argv[4] ?? "";
const relativeToTemp = relative(resolve(tmpdir()), resolve(directory));
if (
  !Number.isInteger(parentPid) ||
  parentPid <= 0 ||
  !Number.isInteger(childPid) ||
  childPid <= 0 ||
  !isAbsolute(directory) ||
  relativeToTemp === "" ||
  relativeToTemp.startsWith("..") ||
  isAbsolute(relativeToTemp) ||
  !basename(directory).startsWith("suede-phase0-")
) {
  process.exit(1);
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function killServer(signal) {
  try {
    if (process.platform === "win32") process.kill(childPid, signal);
    else process.kill(-childPid, signal);
  } catch {
    // Already stopped.
  }
}

const timer = setInterval(() => {
  if (isAlive(parentPid)) return;
  clearInterval(timer);
  killServer("SIGTERM");
  rmSync(directory, { recursive: true, force: true });
  setTimeout(() => {
    killServer("SIGKILL");
    process.exit(0);
  }, 500);
}, 100);
