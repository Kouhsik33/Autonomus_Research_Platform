import type { GeneratedFile } from "./codeGenerator";
import type { ExecutionResult } from "./executor";

export async function generateResearchReport(
  query: string,
  files: GeneratedFile[],
  results: ExecutionResult
): Promise<string> {
  const fileList = files.map((f) => `- ${f.path}`).join("\n") || "- none";
  return [
    "# Autonomous Research Report",
    "",
    "## Query",
    query,
    "",
    "## Generated Files",
    fileList,
    "",
    "## Execution",
    `Return code: ${results.returncode}`,
    "",
    "### Stdout",
    results.stdout || "(empty)",
    "",
    "### Stderr",
    results.stderr || "(empty)"
  ].join("\n");
}
