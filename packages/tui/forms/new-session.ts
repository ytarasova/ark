import { existsSync } from "fs";
import { resolve as resolvePath, basename } from "path";
import * as core from "../../core/index.js";
import { selectOne } from "./select.js";
import { createPrompt, askInput } from "./prompt.js";
import { renderAll } from "../render/index.js";
import { runAsync } from "../async.js";

export function showNewSessionForm() {
  const prompt = createPrompt();

  const ask = (question: string, defaultVal: string) =>
    askInput(prompt, "New Session", question, defaultVal);

  (async () => {
    const summary = await ask("Task / summary:", "");
    if (summary === null) { prompt.destroy(); renderAll(); return; }

    const repoPath = await ask("Repo path:", process.cwd());
    if (repoPath === null) { prompt.destroy(); renderAll(); return; }

    // Host selection
    const hostChoices = [
      { label: "local (this machine)", value: "" },
      ...core.listHosts().map(h => ({ label: `${h.name} (${h.provider})`, value: h.name })),
    ];
    const computeName = await selectOne("Compute Host", hostChoices, 0);
    if (computeName === null) { prompt.destroy(); renderAll(); return; }

    // Pipeline selection
    const pipelineNames = core.listPipelines().map(p => p.name);
    const pipelineChoice = await selectOne("Pipeline", pipelineNames, 0);
    if (!pipelineChoice) { prompt.destroy(); renderAll(); return; }

    // Create session
    let workdir: string | undefined;
    let repo = repoPath || process.cwd();
    const rp = resolvePath(repo);
    if (existsSync(rp)) {
      workdir = rp;
      if (repo === "." || repo === "./") repo = basename(rp);
    }

    const s = core.startSession({
      jira_summary: summary || "Ad-hoc task",
      repo, pipeline: pipelineChoice, workdir,
      compute_name: computeName || undefined,
    });
    runAsync(`Dispatching ${s.id}`, () => core.dispatch(s.id).then(() => {}));

    prompt.destroy();
    renderAll();
  })();
}
