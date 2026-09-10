import path from "node:path";
import { createOfflineSessionSnapshot } from "./lib/offline-session-snapshot.mts";

const [sourcePath, targetPath, agentId, ...extra] = process.argv.slice(2);
if (
  !sourcePath ||
  !targetPath ||
  !agentId ||
  extra.length ||
  !path.isAbsolute(sourcePath) ||
  !path.isAbsolute(targetPath)
) {
  throw new Error(
    "Usage: offline-session-snapshot <absolute prepared source> <absolute new target> <agent>",
  );
}
try {
  await createOfflineSessionSnapshot({ sourcePath, targetPath, agentId });
  console.log(JSON.stringify({ status: "verified", schemaVersion: 19 }));
} catch {
  console.error("Offline Session snapshot refused; retain private preparation for investigation.");
  process.exitCode = 1;
}
