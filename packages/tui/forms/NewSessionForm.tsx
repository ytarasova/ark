import React, { useState, useMemo, useEffect, useRef } from "react";
import { Box, Text } from "ink";
import { existsSync } from "fs";
import { resolve as resolvePath, basename } from "path";
import { useArkClient } from "../hooks/useArkClient.js";
import { loadRepoConfig } from "../../core/repo-config.js";
import { getIsolationModes } from "../../compute/index.js";
import { addRecentRepo } from "../helpers/recentRepos.js";
import { generateName } from "../helpers.js";
import {
  FormTextField,
  FormSelectField,
  FormPathField,
  useFormNavigation,
} from "../components/form/index.js";
import type { StoreData } from "../hooks/useArkStore.js";
import type { AsyncState } from "../hooks/useAsync.js";

export interface SessionPrefill {
  name?: string;
  repo?: string;
  claudeSessionId?: string;
  agent?: string;
  compute?: string;
  group?: string;
  flow?: string;
  summary?: string;
}

interface NewSessionFormProps {
  store: StoreData;
  asyncState: AsyncState;
  onDone: () => void;
  prefill?: SessionPrefill;
}

// Isolation choices are provider-driven — see ComputeProvider.isolationModes

export function NewSessionForm({ store, asyncState, onDone, prefill }: NewSessionFormProps) {
  const ark = useArkClient();
  const [name, setName] = useState(prefill?.summary || prefill?.name || generateName());
  const [repoPath, setRepoPath] = useState(prefill?.repo || process.cwd());
  const [isolation, setIsolation] = useState("worktree");
  const [groupName, setGroupName] = useState(prefill?.group || "");
  const [computeName, setComputeName] = useState(prefill?.compute || "local");
  const [flowName, setFlowName] = useState(prefill?.flow || "bare");

  const isGitRepo = useMemo(() => {
    const rp = resolvePath(repoPath);
    return existsSync(rp) && existsSync(resolvePath(rp, ".git"));
  }, [repoPath]);

  // Load repo-scoped config (.ark.yaml) when repo path changes
  const repoConfig = useMemo(() => {
    try {
      const rp = resolvePath(repoPath);
      return existsSync(rp) ? loadRepoConfig(rp) : {};
    } catch { return {}; }
  }, [repoPath]);

  // Apply repo config defaults once per repoPath change (don't override user edits)
  const repoConfigApplied = useRef("");
  useEffect(() => {
    if (repoPath === repoConfigApplied.current) return;
    if (repoConfig.flow) setFlowName(repoConfig.flow);
    if (repoConfig.compute) setComputeName(repoConfig.compute);
    if (repoConfig.group) setGroupName(repoConfig.group);
    repoConfigApplied.current = repoPath;
  }, [repoPath, repoConfig]);

  // Provider-driven isolation modes
  const isolationChoices = useMemo(() => {
    const compute = store.computes.find(c => c.name === computeName);
    const providerName = compute?.provider ?? "local";
    try { return getIsolationModes(providerName); } catch { return []; }
  }, [computeName, store.computes]);

  const showIsolation = isGitRepo && isolationChoices.length > 1;

  const computeChoices = useMemo(() =>
    store.computes.map(c => ({
      label: c.provider === "local" ? "local" : `${c.name} (${c.provider})`,
      value: c.name,
    })),
    [store.computes],
  );

  const flowChoices = useMemo(() => {
    const fromStore = store.flows.map(f => ({ label: f.name, value: f.name }));
    // Always include "bare" as a fallback even if flows aren't loaded
    if (fromStore.length === 0) return [{ label: "bare", value: "bare" }];
    return fromStore;
  }, [store.flows]);

  const [groupChoices, setGroupChoices] = useState([{ label: "(none)", value: "" }]);
  useEffect(() => {
    ark.groupList().then((groups) => {
      setGroupChoices([
        { label: "(none)", value: "" },
        ...groups.map((g: string) => ({ label: g, value: g })),
      ]);
    }).catch(() => { /* keep default */ });
  }, [ark]);

  const submit = () => {
    let workdir: string | undefined;
    let repo = repoPath || process.cwd();
    const rp = resolvePath(repo).replace(/\/+$/, "");
    if (!existsSync(rp)) return;
    if (!existsSync(resolvePath(rp, ".git"))) return;
    workdir = rp;
    if (repo === "." || repo === "./") repo = basename(rp);
    addRecentRepo(repoPath);

    // Sanitize name: alphanumeric, dash, underscore only
    const sanitized = (name.trim() || generateName())
      .replace(/[^a-zA-Z0-9_-]/g, "-")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 60) || generateName();

    // Close form before async work so React unmount doesn't cancel it
    onDone();

    asyncState.run("Creating session...", async (updateLabel) => {
      const s = await ark.sessionStart({
        summary: sanitized,
        repo,
        flow: flowName,
        agent: prefill?.agent || undefined,
        workdir,
        compute_name: computeName || undefined,
        group_name: groupName || undefined,
        config: { worktree: isolation === "worktree" },
      });
      if (prefill?.claudeSessionId) {
        await ark.sessionUpdate(s.id, { claude_session_id: prefill.claudeSessionId });
      }
      store.refresh();
      updateLabel("Dispatching session...");
      await ark.sessionDispatch(s.id);
      store.refresh();
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
          items={isolationChoices}
          onSelect={(v) => { setIsolation(v); advance(); }}
          active={active === "isolation"}
          displayValue={isolationChoices.find(c => c.value === isolation)?.label ?? isolation}
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

      {repoPath && !isGitRepo && (
        <Box marginTop={1}>
          <Text color="red">{" Not a git repository - select a folder with .git"}</Text>
        </Box>
      )}
      <Box flexGrow={1} />
    </Box>
  );
}
