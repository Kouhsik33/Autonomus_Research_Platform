import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { DetectedProject } from "../detector/backendDetector";

export type GeneratedFile = {
  path: string;
  content: string;
};

export async function generateImplementation(query: string, project: DetectedProject): Promise<GeneratedFile[]> {
  const outputDir = resolve(project.root, "generated");
  await mkdir(outputDir, { recursive: true });

  const file: GeneratedFile = {
    path: resolve(outputDir, "notes.txt"),
    content: `Autonomous research request:\n${query}\n`
  };
  await writeFile(file.path, file.content, "utf-8");

  return [file];
}
