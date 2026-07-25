import { readFile, writeFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";

const summary = JSON.parse(await readFile("coverage/coverage-summary.json", "utf8"));
const sha =
  process.env.GITHUB_SHA ||
  execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
await writeFile(
  "coverage/coverage-metadata.json",
  `${JSON.stringify({ sha, generated_at: new Date().toISOString(), total: summary.total }, null, 2)}\n`,
);
