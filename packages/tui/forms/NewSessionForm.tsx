import React, { useState, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { TextInputEnhanced } from "../components/TextInputEnhanced.js";
import { existsSync } from "fs";
import { resolve as resolvePath, basename } from "path";
import * as core from "../../core/index.js";
import { SelectMenu } from "../components/SelectMenu.js";
import { PathInput, getPathCompletions } from "../components/PathInput.js";
import { submitForm } from "./submitForm.js";
import { getRecentRepos, addRecentRepo } from "../helpers/recentRepos.js";
import { generateName } from "../helpers.js";
import type { StoreData } from "../hooks/useStore.js";
import type { AsyncState } from "../hooks/useAsync.js";

type Field = "name" | "repo" | "isolation" | "group" | "compute" | "flow";

interface NewSessionFormProps {
  store: StoreData;
  async: AsyncState;
  onDone: () => void;
}

const FIELDS: Field[] = ["name", "repo", "isolation", "group", "compute", "flow"];

const ISOLATION_CHOICES = [
  { label: "Git worktree (isolated)", value: "worktree" },
  { label: "In-place (direct)", value: "inplace" },
];

export function NewSessionForm({
  store,
  async: asyncState,
  onDone,
}: NewSessionFormProps) {
  const [active, setActive] = useState<Field>("name");
  const [name, setName] = useState(generateName());
  const [repoPath, setRepoPath] = useState(process.cwd());
  const [isolation, setIsolation] = useState("worktree");
  const [groupName, setGroupName] = useState("");
  const [computeName, setComputeName] = useState("local");
  const [flowName, setFlowName] = useState("bare");

  const isGitRepo = useMemo(() => {
    const rp = resolvePath(repoPath);
    return existsSync(rp) && existsSync(resolvePath(rp, ".git"));
  }, [repoPath]);

  // Available fields (skip isolation for non-git repos)
  const fields = useMemo(
    () => isGitRepo ? FIELDS : FIELDS.filter(f => f !== "isolation"),
    [isGitRepo],
  );

  const computeChoices = useMemo(() =>
    store.computes.map(h => ({
      label: h.provider === "local" ? "local" : `${h.name} (${h.provider})`,
      value: h.name,
    })),
    [store.computes],
  );

  const flowChoices = useMemo(() =>
    store.flows.map(p => ({ label: p.name, value: p.name })),
    [store.flows],
  );

  const groupChoices = useMemo(() => {
    const existing = core.getGroups();
    return [
      { label: "(none)", value: "" },
      ...existing.map(g => ({ label: g, value: g })),
    ];
  }, []);

  // Navigation
  const moveField = (dir: 1 | -1) => {
    const idx = fields.indexOf(active);
    const next = idx + dir;
    if (next >= 0 && next < fields.length) setActive(fields[next]);
  };

  useInput((input, key) => {
    if (key.escape) { onDone(); return; }

    // Ctrl+J / Ctrl+K to move between fields
    if (input === "j" && key.ctrl) { moveField(1); return; }
    if (input === "k" && key.ctrl) { moveField(-1); return; }

    // Tab completion for repo path
    if (active === "repo" && key.tab) {
      const completions = getPathCompletions(repoPath);
      if (completions.length > 0) setRepoPath(completions[0] + "/");
      return;
    }
  });

  const submit = () => {
    let workdir: string | undefined;
    let repo = repoPath || process.cwd();
    const rp = resolvePath(repo);
    if (existsSync(rp)) {
      workdir = rp;
      if (repo === "." || repo === "./") repo = basename(rp);
    }
    addRecentRepo(repoPath);

    let sessionId = "";
    submitForm({
      create: () => {
        const s = core.startSession({
          summary: name.trim() || generateName(),
          repo,
          flow: flowName,
          workdir,
          compute_name: computeName || undefined,
          group_name: groupName || undefined,
          config: { worktree: isolation === "worktree" },
        });
        sessionId = s.id;
      },
      onDone,
      asyncFollowUp: {
        label: "Dispatching session",
        action: () => core.dispatch(sessionId).then(() => {}),
      },
      asyncState,
    });
  };

  // Submit on Enter when on last field
  const handleFieldSubmit = () => {
    const idx = fields.indexOf(active);
    if (idx === fields.length - 1) {
      submit();
    } else {
      moveField(1);
    }
  };

  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      <Text bold color="cyan">{" New Session "}</Text>
      <Text> </Text>

      {/* Name */}
      <FormField label="Name" active={active === "name"}>
        <TextInputEnhanced
          value={name}
          onChange={setName}
          onSubmit={handleFieldSubmit}
          focus={active === "name"}
        />
      </FormField>

      {/* Repo */}
      <FormField label="Repo" active={active === "repo"}>
        {active === "repo" ? (
          <TextInputEnhanced
            value={repoPath}
            onChange={setRepoPath}
            onSubmit={handleFieldSubmit}
            focus={true}
          />
        ) : (
          <Text>{repoPath}</Text>
        )}
      </FormField>

      {/* Isolation (only for git repos) */}
      {isGitRepo && (
        <FormField label="Isolation" active={active === "isolation"}>
          {active === "isolation" ? (
            <SelectMenu
              items={ISOLATION_CHOICES}
              onSelect={(item) => { setIsolation(item.value); moveField(1); }}
            />
          ) : (
            <Text>{isolation === "worktree" ? "worktree" : "in-place"}</Text>
          )}
        </FormField>
      )}

      {/* Group */}
      <FormField label="Group" active={active === "group"}>
        {active === "group" ? (
          <SelectMenu
            items={groupChoices}
            onSelect={(item) => { setGroupName(item.value); moveField(1); }}
          />
        ) : (
          <Text>{groupName || "(none)"}</Text>
        )}
      </FormField>

      {/* Compute */}
      <FormField label="Compute" active={active === "compute"}>
        {active === "compute" ? (
          <SelectMenu
            items={computeChoices}
            onSelect={(item) => { setComputeName(item.value); moveField(1); }}
          />
        ) : (
          <Text>{computeName || "local"}</Text>
        )}
      </FormField>

      {/* Flow */}
      <FormField label="Flow" active={active === "flow"}>
        {active === "flow" ? (
          <SelectMenu
            items={flowChoices}
            onSelect={(item) => { setFlowName(item.value); submit(); }}
          />
        ) : (
          <Text>{flowName}</Text>
        )}
      </FormField>

      <Text> </Text>
      <Text dimColor>{"  Ctrl+J/K:navigate  Enter:next/submit  Esc:cancel"}</Text>
    </Box>
  );
}

// -- Form Field --------------------------------------------------------------

function FormField({ label, active, children }: {
  label: string;
  active: boolean;
  children: React.ReactNode;
}) {
  return (
    <Box>
      <Text color={active ? "cyan" : "gray"}>
        {active ? "> " : "  "}
      </Text>
      <Text color={active ? "white" : "gray"} bold={active}>
        {`${label.padEnd(10)} `}
      </Text>
      {children}
    </Box>
  );
}
