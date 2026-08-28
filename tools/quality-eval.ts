import { readFile } from "fs/promises";
import { resolve } from "path";
import { evaluateQualityFixture, type QualityEvalFixture } from "../src/core/quality-eval";

async function main(): Promise<void> {
  const fixturePath = resolve(process.argv[2] ?? "quality-fixtures/sample.json");
  const fixture = JSON.parse(await readFile(fixturePath, "utf8")) as QualityEvalFixture;
  const report = evaluateQualityFixture(fixture);
  process.stdout.write(`${JSON.stringify({ fixture: fixturePath, ...report }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`quality evaluation failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
