import React, { useState, useMemo } from "react";
import { Box, Text } from "ink";
import { existsSync } from "fs";
import { resolve as resolvePath, basename } from "path";
import * as core from "../../core/index.js";
import { submitForm } from "./submitForm.js";
import { addRecentRepo } from "../helpers/recentRepos.js";
import { generateName } from "../helpers.js";
import {
  FormTextField,
  FormSelectField,
  FormPathField,
  useFormNavigation,
} from "../components/form/index.js";
import type { StoreData } from "../hooks/useStore.js";
import type { AsyncState } from "../hooks/useAsync.js";

export interface SessionPrefill {
  name?: string;
  repo?: string;
  claudeSessionId?: string;
}

interface NewSessionFormProps {
  store: StoreData;
  async: AsyncState;
  onDone: () => void;
  prefill?: SessionPrefill;
}

const ISOLATION_CHOICES = [
  { label: "Git worktree (isolated)", value: "worktree" },
  { label: "In-place (direct)", value: "inplace" },
];

export function NewSessionForm({ store, async: asyncState, onDone, prefill }: NewSessionFormProps) {
  const [name, setName] = useState(prefill?.name || generateName());
  const [repoPath, setRepoPath] = useState(prefill?.repo || process.cwd());
  const [isolation, setIsolation] = useState("worktree");
  const [groupName, setGroupName] = useState("");
  const [computeName, setComputeName] = useState("local");
  const [flowName, setFlowName] = useState("bare");

  const isGitRepo = useMemo(() => {
    const rp = resolvePath(repoPath);
    return existsSync(rp) && existsSync(resolvePath(rp, ".git"));
  }, [repoPath]);

  const isLocalCompute = computeName === "local" || computeName === "";
  const showIsolation = isGitRepo && isLocalCompute;

  const computeChoices = useMemo(() =>
    store.computes.map(c => ({
      label: c.provider === "local" ? "local" : `${c.name} (${c.provider})`,
      value: c.name,
    })),
    [store.computes],
  );

  const flowChoices = useMemo(() =>
    store.flows.map(f => ({ label: f.name, value: f.name })),
    [store.flows],
  );

  const groupChoices = useMemo(() => {
    const existing = core.getGroups();
    return [
      { label: "(none)", value: "" },
      ...existing.map(g => ({ label: g, value: g })),
    ];
  }, []);

  const submit = () => {
    let workdir: string | undefined;
    let repo = repoPath || process.cwd();
    const rp = resolvePath(repo);
    if (existsSync(rp)) {
      workdir = rp;
      if (repo === "." || repo === "./") repo = basename(rp);
    }
    addRecentRepo(repoPath);

    // Sanitize name: alphanumeric, dash, underscore only
    const sanitized = (name.trim() || generateName())
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || generateName();

    let sessionId = "";
    submitForm({
      create: () => {
        const s = core.startSession({
          summary: sanitized,
          repo,
          flow: flowName,
          workdir,
          compute_name: computeName || undefined,
          group_name: groupName || undefined,
          config: { worktree: isLocalCompute && isolation === "worktree" },
        });
        sessionId = s.id;
        if (prefill?.claudeSessionId) {
          core.updateSession(s.id, { claude_session_id: prefill.claudeSessionId });
        }
        store.refresh();
      },
      onDone,
      asyncFollowUp: {
        label: "Dispatching session",
        action: async () => {
          await core.dispatch(sessionId);
          store.refresh();
        },
      },
      asyncState,
    });
  };

  const { active, advance, setEditing } = useFormNavigation({
    fields: [
      { name: "name", type: "text" },
      { name: "repo", type: "path" },
      { name: "compute", type: "select" },
      { name: "isolation", type: "select", visible: showIsolation },
      { name: "group", type: "select" },
      { name: "flow", type: "select" },
    ],
    onCancel: onDone,
    onSubmit: submit,
  });

  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text bold color="cyan">{" New Session "}</Text>
      <Text> </Text>

      <FormTextField
        label="Name"
        value={name}
        onChange={setName}
        active={active === "name"}
        onEditChange={setEditing}
      />

      <FormPathField
        label="Repo"
        value={repoPath}
        onChange={setRepoPath}
        active={active === "repo"}
        onEditChange={setEditing}
      />

      <FormSelectField
        label="Compute"
        value={computeName}
        items={computeChoices}
        onSelect={(v) => { setComputeName(v); advance(); }}
        active={active === "compute"}
        displayValue={computeName || "local"}
      />

      {showIsolation && (
        <FormSelectField
          label="Isolation"
          value={isolation}
          items={ISOLATION_CHOICES}
          onSelect={(v) => { setIsolation(v); advance(); }}
          active={active === "isolation"}
          displayValue={isolation === "worktree" ? "worktree" : "in-place"}
        />
      )}

      <FormSelectField
        label="Group"
        value={groupName}
        items={groupChoices}
        onSelect={(v) => { setGroupName(v); advance(); }}
        active={active === "group"}
        displayValue={groupName || "(none)"}
      />

      <FormSelectField
        label="Flow"
        value={flowName}
        items={flowChoices}
        onSelect={(v) => { setFlowName(v); submit(); }}
        active={active === "flow"}
      />

      <Box flexGrow={1} />
    </Box>
  );
}
