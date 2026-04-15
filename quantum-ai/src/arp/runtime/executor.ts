import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import type { DetectedProject } from "../detector/backendDetector";

export type ExecutionResult = {
  returncode: number;
  stdout: string;
  stderr: string;
};

export async function executeProject(project: DetectedProject): Promise<ExecutionResult> {
  if (!project.pythonEntry || !existsSync(project.pythonEntry)) {
    return { returncode: 0, stdout: "No executable script found.", stderr: "" };
  }

  const candidates = ["python3", "python", "/usr/bin/python3"];

  for (const py of candidates) {
    const run = await runOnce(py, [project.pythonEntry], project.root);
    if (run.returncode === 0 || !String(run.stderr || "").includes("ENOENT")) {
      return run;
    }
  }

  return { returncode: 1, stdout: "", stderr: "Unable to execute project with available Python executables." };
}

function runOnce(cmd: string, args: string[], cwd: string): Promise<ExecutionResult> {
  return new Promise((resolvePromise) => {
    const child = spawn(cmd, args, { cwd, shell: false, env: process.env });
    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderr += String(chunk);
    });

    child.on("error", (error) => {
      resolvePromise({ returncode: 1, stdout, stderr: error.message });
    });

    child.on("close", (code) => {
      resolvePromise({ returncode: code ?? 1, stdout, stderr });
    });
  });
}
