import React, { useState, useEffect, useMemo } from "react";
import { Box, Text, useInput } from "ink";
import { TextInputEnhanced } from "../components/TextInputEnhanced.js";
import { existsSync } from "fs";
import { resolve as resolvePath, basename } from "path";
import { execFileSync } from "child_process";
import * as core from "../../core/index.js";
import { SelectMenu } from "../components/SelectMenu.js";
import { PathInput, getPathCompletions } from "../components/PathInput.js";
import { submitForm } from "./submitForm.js";
import { getRecentRepos, addRecentRepo } from "../helpers/recentRepos.js";
import { generateName } from "../helpers.js";
import type { StoreData } from "../hooks/useStore.js";
import type { AsyncState } from "../hooks/useAsync.js";

type Step = "summary" | "repoSource" | "repo" | "isolation" | "group" | "host" | "flow";
type RepoSource = "local" | "github" | "recent";

interface NewSessionFormProps {
  store: StoreData;
  async: AsyncState;
  onDone: () => void;
}

const REPO_SOURCE_CHOICES = [
  { label: "Local directory", value: "local" },
  { label: "GitHub repo", value: "github" },
  { label: "Recent repos", value: "recent" },
];

interface GitHubRepo {
  label: string;
  value: string;
}

function fetchGitHubRepos(): GitHubRepo[] {
  try {
    const args = [
      "repo",
      "list",
      "--json",
      "nameWithOwner,description",
      "--limit",
      "20",
    ];
    const output = execFileSync("gh", args, {
      encoding: "utf-8",
      timeout: 10000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    const repos = JSON.parse(output);
    return repos.map((r: any) => ({
      label: `${r.nameWithOwner}${r.description ? ` - ${r.description.slice(0, 40)}` : ""}`,
      value: r.nameWithOwner,
    }));
  } catch {
    return [];
  }
}

export function NewSessionForm({
  store,
  async: asyncState,
  onDone,
}: NewSessionFormProps) {
  const [step, setStep] = useState<Step>("summary");
  const [summary, setSummary] = useState(generateName());
  const [repoSource, setRepoSource] = useState<RepoSource>("local");
  const [repoPath, setRepoPath] = useState(process.cwd());
  const [computeName, setComputeName] = useState("");
  const [useWorktree, setUseWorktree] = useState(true);
  const [groupName, setGroupName] = useState("");
  const [groupMode, setGroupMode] = useState<"pick" | "new">("pick");

  // GitHub repos: loaded async to avoid blocking the TUI
  const [ghRepos, setGhRepos] = useState<GitHubRepo[]>([]);
  const [ghLoading, setGhLoading] = useState(false);
  const [ghError, setGhError] = useState("");

  // Recent repos
  const recentRepos = useMemo(() => getRecentRepos(), []);
  const recentChoices = useMemo(
    () => recentRepos.slice(0, 10).map((r) => ({ label: r, value: r })),
    [recentRepos],
  );

  // Path completions for tab handler
  const completions = useMemo(
    () =>
      step === "repo" && repoSource === "local"
        ? getPathCompletions(repoPath)
        : [],
    [step, repoSource, repoPath],
  );

  useInput((input, key) => {
    if (key.escape) {
      // If we're in the repo sub-step, go back to source selection
      if (step === "repo") {
        setStep("repoSource");
        return;
      }
      onDone();
      return;
    }
    // Tab completion for local directory path
    if (
      step === "repo" &&
      repoSource === "local" &&
      key.tab &&
      completions.length > 0
    ) {
      setRepoPath(completions[0] + "/");
    }
  });

  // Load GitHub repos when source is selected
  useEffect(() => {
    if (step === "repo" && repoSource === "github" && ghRepos.length === 0 && !ghLoading) {
      setGhLoading(true);
      setGhError("");
      // Run in a microtask so the "Loading..." text renders first
      const timer = setTimeout(() => {
        const repos = fetchGitHubRepos();
        if (repos.length === 0) {
          setGhError(
            "No repos found. Is the GitHub CLI (gh) installed and authenticated?",
          );
        }
        setGhRepos(repos);
        setGhLoading(false);
      }, 0);
      return () => clearTimeout(timer);
    }
  }, [step, repoSource, ghRepos.length, ghLoading]);

  const hostChoices = store.hosts.map((h) => ({
    label:
      h.provider === "local"
        ? "local (this machine)"
        : `${h.name} (${h.provider})`,
    value: h.name,
  }));

  const flowChoices = store.flows.map((p) => ({
    label: p.name,
    value: p.name,
  }));

  const handleSubmitSummary = () => {
    setStep("repoSource");
  };

  const handleSelectRepoSource = (item: { label: string; value: string }) => {
    const src = item.value as RepoSource;
    setRepoSource(src);
    setStep("repo");
  };

  const handleRepoSelected = (repo: string) => {
    setRepoPath(repo);
    addRecentRepo(repo);
    // Only offer worktree choice for local git repos
    const rp = resolvePath(repo);
    if (existsSync(rp) && existsSync(resolvePath(rp, ".git"))) {
      setStep("isolation");
    } else {
      setStep("group");
    }
  };

  const handleSelectIsolation = (item: { label: string; value: string }) => {
    setUseWorktree(item.value === "worktree");
    setStep("group");
  };

  const existingGroups = core.getGroups();
  const groupChoices = [
    { label: "(none)", value: "__none__" },
    ...existingGroups.map(g => ({ label: g, value: g })),
    { label: "+ New group...", value: "__new__" },
  ];

  const handleSelectGroup = (item: { label: string; value: string }) => {
    if (item.value === "__new__") {
      setGroupMode("new");
    } else {
      setGroupName(item.value === "__none__" ? "" : item.value);
      setStep("host");
    }
  };

  const handleSubmitNewGroup = () => {
    if (groupName.trim()) setStep("host");
  };

  const handleSubmitLocalRepo = () => {
    handleRepoSelected(repoPath);
  };

  const handleSelectGitHubRepo = (item: { label: string; value: string }) => {
    handleRepoSelected(item.value);
  };

  const handleSelectRecentRepo = (item: { label: string; value: string }) => {
    handleRepoSelected(item.value);
  };

  const handleSelectHost = (item: { label: string; value: string }) => {
    setComputeName(item.value);
    setStep("flow");
  };

  const handleSelectFlow = (item: { label: string; value: string }) => {
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
          summary: summary.trim() || generateName(),
          repo,
          flow: item.value,
          workdir,
          compute_name: computeName || undefined,
          group_name: groupName || undefined,
          config: { worktree: useWorktree },
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
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
    >
      <Text bold color="cyan">
        {" New Session "}
      </Text>
      <Text>{""}</Text>

      {step === "summary" && (
        <Box flexDirection="column">
          <Text>{"Session name:"}</Text>
          <Box>
            <Text color="cyan">{"> "}</Text>
            <TextInputEnhanced
              value={summary}
              onChange={setSummary}
              onSubmit={handleSubmitSummary}
            />
          </Box>
          <Text dimColor>{"  Enter to continue, Esc to cancel"}</Text>
        </Box>
      )}

      {step === "repoSource" && (
        <Box flexDirection="column">
          <Text dimColor>{`Session: ${summary}`}</Text>
          <Text>{""}</Text>
          <Text>{"Source:"}</Text>
          <SelectMenu
            items={REPO_SOURCE_CHOICES}
            onSelect={handleSelectRepoSource}
          />
          <Text dimColor>{"  Esc to cancel"}</Text>
        </Box>
      )}

      {step === "repo" && repoSource === "local" && (
        <Box flexDirection="column">
          <Text dimColor>{`Session: ${summary}`}</Text>
          <Text>{""}</Text>
          <Text>{"Repo path:"}</Text>
          <PathInput
            value={repoPath}
            onChange={setRepoPath}
            onSubmit={handleSubmitLocalRepo}
          />
        </Box>
      )}

      {step === "repo" && repoSource === "github" && (
        <Box flexDirection="column">
          <Text dimColor>{`Session: ${summary}`}</Text>
          <Text>{""}</Text>
          <Text>{"GitHub repo:"}</Text>
          {ghLoading && <Text color="yellow">{"  Loading repos..."}</Text>}
          {ghError && <Text color="red">{`  ${ghError}`}</Text>}
          {!ghLoading && !ghError && ghRepos.length > 0 && (
            <SelectMenu
              items={ghRepos}
              onSelect={handleSelectGitHubRepo}
              limit={10}
            />
          )}
          <Text dimColor>{"  Esc to go back"}</Text>
        </Box>
      )}

      {step === "repo" && repoSource === "recent" && (
        <Box flexDirection="column">
          <Text dimColor>{`Session: ${summary}`}</Text>
          <Text>{""}</Text>
          <Text>{"Recent repos:"}</Text>
          {recentChoices.length > 0 ? (
            <SelectMenu
              items={recentChoices}
              onSelect={handleSelectRecentRepo}
              limit={10}
            />
          ) : (
            <Text color="yellow">{"  No recent repos yet"}</Text>
          )}
          <Text dimColor>{"  Esc to go back"}</Text>
        </Box>
      )}

      {step === "isolation" && (
        <Box flexDirection="column">
          <Text dimColor>{`Session: ${summary}`}</Text>
          <Text dimColor>{`Repo: ${repoPath}`}</Text>
          <Text>{""}</Text>
          <Text>{"Working copy:"}</Text>
          <SelectMenu
            items={[
              { label: "Git worktree  (isolated branch, safe)", value: "worktree" },
              { label: "In-place      (work directly in repo)", value: "inplace" },
            ]}
            onSelect={handleSelectIsolation}
          />
          <Text dimColor>{"  Esc to cancel"}</Text>
        </Box>
      )}

      {step === "group" && groupMode === "pick" && (
        <Box flexDirection="column">
          <Text dimColor>{`Session: ${summary}`}</Text>
          <Text dimColor>{`Repo: ${repoPath}`}</Text>
          <Text>{""}</Text>
          <Text>{"Group:"}</Text>
          <SelectMenu items={groupChoices} onSelect={handleSelectGroup} />
          <Text dimColor>{"  Esc to cancel"}</Text>
        </Box>
      )}

      {step === "group" && groupMode === "new" && (
        <Box flexDirection="column">
          <Text dimColor>{`Session: ${summary}`}</Text>
          <Text dimColor>{`Repo: ${repoPath}`}</Text>
          <Text>{""}</Text>
          <Text>{"New group name:"}</Text>
          <Box>
            <Text color="cyan">{"> "}</Text>
            <TextInputEnhanced
              value={groupName}
              onChange={setGroupName}
              onSubmit={handleSubmitNewGroup}
              placeholder="Enter group name..."
            />
          </Box>
          <Text dimColor>{"  Enter to continue, Esc to cancel"}</Text>
        </Box>
      )}

      {step === "host" && (
        <Box flexDirection="column">
          <Text dimColor>{`Session: ${summary}`}</Text>
          <Text dimColor>{`Repo: ${repoPath}`}</Text>
          <Text>{""}</Text>
          <Text>{"Compute host:"}</Text>
          <SelectMenu items={hostChoices} onSelect={handleSelectHost} />
          <Text dimColor>{"  Esc to cancel"}</Text>
        </Box>
      )}

      {step === "flow" && (
        <Box flexDirection="column">
          <Text dimColor>{`Session: ${summary}`}</Text>
          <Text dimColor>{`Repo: ${repoPath}`}</Text>
          <Text dimColor>{`Host: ${computeName || "local"}`}</Text>
          <Text>{""}</Text>
          <Text>{"Flow:"}</Text>
          {flowChoices.length > 0 ? (
            <SelectMenu
              items={flowChoices}
              onSelect={handleSelectFlow}
            />
          ) : (
            <Text color="red">{"  No flows available"}</Text>
          )}
          <Text dimColor>{"  Esc to cancel"}</Text>
        </Box>
      )}
    </Box>
  );
}
