import { existsSync } from "node:fs";
import { resolve } from "node:path";

export type DetectedProject = {
  root: string;
  pythonEntry: string;
  hasRequirements: boolean;
};

export async function detectProject(projectRoot: string): Promise<DetectedProject> {
  const root = resolve(projectRoot || process.cwd());
  const mainPy = resolve(root, "main.py");
  const appPy = resolve(root, "app.py");
  const requirements = resolve(root, "requirements.txt");

  const pythonEntry = existsSync(mainPy) ? mainPy : appPy;
  return {
    root,
    pythonEntry,
    hasRequirements: existsSync(requirements)
  };
}
