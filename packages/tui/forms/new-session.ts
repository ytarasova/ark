import blessed from "neo-blessed";
import * as core from "../../core/index.js";
import { screen } from "../layout.js";
import { selectOne } from "./select.js";
import { renderAll } from "../render/index.js";

export function showNewSessionForm() {
  const prompt = blessed.prompt({
    parent: screen,
    top: "center",
    left: "center",
    width: 70,
    height: 8,
    border: { type: "line" },
    style: { border: { fg: "cyan" }, bg: "black" },
    tags: true,
  });

  const ask = (question: string, defaultVal: string): Promise<string | null> =>
    new Promise((resolve) => {
      prompt.input(`{bold}New Session{/bold}\n\n${question}`, defaultVal, (err, value) => {
        if (err || value === undefined || value === null) resolve(null);
        else resolve(value.trim());
      });
    });

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
    const { existsSync } = require("fs");
    const { resolve: resolvePath, basename } = require("path");
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
    const { spawn } = require("child_process");
    const { join } = require("path");
    const arkBin = join(import.meta.dir, "..", "..", "..", "ark");
    spawn("bash", [arkBin, "session", "dispatch", s.id], {
      detached: true, stdio: "ignore",
    }).unref();

    prompt.destroy();
    renderAll();
  })();
}
