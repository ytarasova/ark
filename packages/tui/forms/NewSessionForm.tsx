import React, { useState } from "react";
import { Box, Text, useInput } from "ink";
import TextInput from "ink-text-input";
import { existsSync } from "fs";
import { resolve as resolvePath, basename } from "path";
import * as core from "../../core/index.js";
import { SelectMenu } from "../components/SelectMenu.js";
import { submitForm } from "./submitForm.js";
import type { StoreData } from "../hooks/useStore.js";
import type { AsyncState } from "../hooks/useAsync.js";

type Step = "summary" | "repo" | "host" | "pipeline";

interface NewSessionFormProps {
  store: StoreData;
  async: AsyncState;
  onDone: () => void;
}

export function NewSessionForm({ store, async: asyncState, onDone }: NewSessionFormProps) {
  const [step, setStep] = useState<Step>("summary");
  const [summary, setSummary] = useState("");
  const [repoPath, setRepoPath] = useState(process.cwd());
  const [computeName, setComputeName] = useState("");

  useInput((input, key) => {
    if (key.escape) {
      onDone();
    }
  });

  const hostChoices = store.hosts.map((h) => ({
    label: h.provider === "local" ? "local (this machine)" : `${h.name} (${h.provider})`,
    value: h.name,
  }));

  const pipelineChoices = store.pipelines.map((p) => ({
    label: p.name,
    value: p.name,
  }));

  const handleSubmitSummary = () => {
    setStep("repo");
  };

  const handleSubmitRepo = () => {
    setStep("host");
  };

  const handleSelectHost = (item: { label: string; value: string }) => {
    setComputeName(item.value);
    setStep("pipeline");
  };

  const handleSelectPipeline = (item: { label: string; value: string }) => {
    let workdir: string | undefined;
    let repo = repoPath || process.cwd();
    const rp = resolvePath(repo);
    if (existsSync(rp)) {
      workdir = rp;
      if (repo === "." || repo === "./") repo = basename(rp);
    }

    let sessionId = "";
    submitForm({
      create: () => {
        const s = core.startSession({
          summary: summary || "Ad-hoc task",
          repo,
          pipeline: item.value,
          workdir,
          compute_name: computeName || undefined,
        });
        sessionId = s.id;
      },
      onDone,
      asyncFollowUp: {
        label: `Dispatching session`,
        action: () => core.dispatch(sessionId).then(() => {}),
      },
      asyncState,
    });
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      <Text bold color="cyan">{" New Session "}</Text>
      <Text>{""}</Text>

      {step === "summary" && (
        <Box flexDirection="column">
          <Text>{"Task / summary:"}</Text>
          <Box>
            <Text color="cyan">{"> "}</Text>
            <TextInput
              value={summary}
              onChange={setSummary}
              onSubmit={handleSubmitSummary}
              placeholder="Describe the task..."
            />
          </Box>
          <Text dimColor>{"  Enter to continue, Esc to cancel"}</Text>
        </Box>
      )}

      {step === "repo" && (
        <Box flexDirection="column">
          <Text dimColor>{`Summary: ${summary || "(empty)"}`}</Text>
          <Text>{""}</Text>
          <Text>{"Repo path:"}</Text>
          <Box>
            <Text color="cyan">{"> "}</Text>
            <TextInput
              value={repoPath}
              onChange={setRepoPath}
              onSubmit={handleSubmitRepo}
            />
          </Box>
          <Text dimColor>{"  Enter to continue, Esc to cancel"}</Text>
        </Box>
      )}

      {step === "host" && (
        <Box flexDirection="column">
          <Text dimColor>{`Summary: ${summary || "(empty)"}`}</Text>
          <Text dimColor>{`Repo: ${repoPath}`}</Text>
          <Text>{""}</Text>
          <Text>{"Compute host:"}</Text>
          <SelectMenu items={hostChoices} onSelect={handleSelectHost} />
          <Text dimColor>{"  Esc to cancel"}</Text>
        </Box>
      )}

      {step === "pipeline" && (
        <Box flexDirection="column">
          <Text dimColor>{`Summary: ${summary || "(empty)"}`}</Text>
          <Text dimColor>{`Repo: ${repoPath}`}</Text>
          <Text dimColor>{`Host: ${computeName || "local"}`}</Text>
          <Text>{""}</Text>
          <Text>{"Pipeline:"}</Text>
          {pipelineChoices.length > 0 ? (
            <SelectMenu items={pipelineChoices} onSelect={handleSelectPipeline} />
          ) : (
            <Text color="red">{"  No pipelines available"}</Text>
          )}
          <Text dimColor>{"  Esc to cancel"}</Text>
        </Box>
      )}
    </Box>
  );
}
