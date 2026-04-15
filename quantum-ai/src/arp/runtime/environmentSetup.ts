import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { DetectedProject } from "../detector/backendDetector";

function run(cmd: string, args: string[], cwd: string): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(cmd, args, { cwd, shell: false, env: process.env });
    child.on("error", reject);
    child.on("close", (code) => {
      if ((code ?? 1) === 0) {
        resolvePromise();
        return;
      }
      reject(new Error(`Command failed: ${cmd} ${args.join(" ")}`));
    });
  });
}

export async function setupEnvironment(project: DetectedProject): Promise<void> {
  const requirements = resolve(project.root, "requirements.txt");
  if (!existsSync(requirements)) {
    return;
  }

  const candidates = ["python3", "python", "/usr/bin/python3"];
  let lastError: unknown = null;
  for (const py of candidates) {
    try {
      await run(py, ["-m", "pip", "install", "-r", requirements], project.root);
      return;
    } catch (error) {
      lastError = error;
    }
  }

  if (lastError) {
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}
