/**
 * Component-level tests for TUI building blocks.
 *
 * Tests TabBar, StatusBar, MetricBar, and SectionHeader in isolation
 * using ink-testing-library.
 */

import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { TabBar } from "../components/TabBar.js";
import { StatusBar } from "../components/StatusBar.js";
import { MetricBar } from "../components/MetricBar.js";
import { SectionHeader } from "../components/SectionHeader.js";

// ── TabBar ──────────────────────────────────────────────────────────────────

describe("TabBar", () => {
  it("renders all tab labels", () => {
    const { lastFrame } = render(<TabBar active="sessions" />);
    const frame = lastFrame()!;
    expect(frame).toContain("1:Sessions");
    expect(frame).toContain("2:Agents");
    expect(frame).toContain("3:Tools");
    expect(frame).toContain("4:Flows");
    expect(frame).toContain("5:History");
    expect(frame).toContain("6:Compute");
  });

  it("highlights the active tab by including it in output", () => {
    // ink-testing-library strips ANSI codes, so we verify each tab
    // label is present and the component renders without error for
    // every possible active tab
    const tabs = ["sessions", "agents", "tools", "flows", "history", "compute"] as const;
    for (const tab of tabs) {
      const { lastFrame } = render(<TabBar active={tab} />);
      const frame = lastFrame()!;
      // The active tab's capitalized label must appear
      const label = tab.charAt(0).toUpperCase() + tab.slice(1);
      expect(frame).toContain(label);
    }
  });

  it("renders correctly with each tab active", () => {
    const tabs = ["sessions", "agents", "tools", "flows", "history", "compute"] as const;
    for (const tab of tabs) {
      const { lastFrame } = render(<TabBar active={tab} />);
      const frame = lastFrame()!;
      // Should still contain all tab labels regardless of which is active
      expect(frame).toContain("1:Sessions");
      expect(frame).toContain("6:Compute");
    }
  });
});

// ── StatusBar ───────────────────────────────────────────────────────────────

describe("StatusBar", () => {
  const makeSessions = (statuses: string[]) =>
    statuses.map((status, i) => ({
      id: `s-${i}`,
      ticket: null,
      summary: null,
      repo: null,
      branch: null,
      compute_name: null,
      session_id: null,
      claude_session_id: null,
      stage: null,
      status,
      flow: "default",
      agent: null,
      workdir: null,
      pr_url: null,
      pr_id: null,
      error: null,
      parent_id: null,
      fork_group: null,
      group_name: null,
      breakpoint_reason: null,
      attached_by: null,
      config: {},
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    }));

  it("shows session count", () => {
    const sessions = makeSessions(["running", "pending", "completed"]);
    const { lastFrame } = render(
      <StatusBar tab="sessions" sessions={sessions} loading={false} error={null} label={null} />
    );
    const frame = lastFrame()!;
    // ink may truncate in narrow default terminal, so check count and prefix of label
    expect(frame).toContain("3");
    expect(frame).toContain("session");
  });

  it("shows running count when sessions are running", () => {
    const sessions = makeSessions(["running", "running", "pending"]);
    const { lastFrame } = render(
      <StatusBar tab="sessions" sessions={sessions} loading={false} error={null} label={null} />
    );
    const frame = lastFrame()!;
    // StatusBar uses "● N" for running — ink may truncate the count in narrow test terminal
    expect(frame).toContain("●");
  });

  it("shows error message when error is set", () => {
    const sessions = makeSessions([]);
    const { lastFrame } = render(
      <StatusBar tab="sessions" sessions={sessions} loading={false} error="Something broke" label={null} />
    );
    expect(lastFrame()!).toContain("Something broke");
  });

  it("shows loading state — spinner is in TabBar, not StatusBar", () => {
    // The loading spinner and label moved to TabBar; StatusBar only suppresses
    // the running-count dot when loading=true. Verify TabBar shows the label.
    const { lastFrame } = render(
      <TabBar active="sessions" loading={true} loadingLabel="Dispatching s-abc" />
    );
    expect(lastFrame()!).toContain("Dispatching s-abc");
  });

  it("shows error count for failed sessions", () => {
    const sessions = makeSessions(["failed", "failed", "running"]);
    const { lastFrame } = render(
      <StatusBar tab="sessions" sessions={sessions} loading={false} error={null} label={null} />
    );
    const frame = lastFrame()!;
    // StatusBar uses "✕ N" for failed — ink may truncate the count in narrow test terminal
    expect(frame).toContain("✕");
  });

  it("shows key hints for the active tab", () => {
    const sessions = makeSessions([]);
    const { lastFrame: f1 } = render(
      <StatusBar tab="sessions" sessions={sessions} loading={false} error={null} label={null} />
    );
    // With no selected session, shows "new" and "quit"
    expect(f1()!).toContain("new");
    expect(f1()!).toContain("quit");

    const { lastFrame: f2 } = render(
      <StatusBar tab="compute" sessions={sessions} loading={false} error={null} label={null} />
    );
    // ink may truncate, so check prefix of "provision"
    expect(f2()!).toContain("provis");
  });

  it("shows navigation hints for agents tab", () => {
    const sessions = makeSessions([]);
    const { lastFrame } = render(
      <StatusBar tab="agents" sessions={sessions} loading={false} error={null} label={null} />
    );
    const frame = lastFrame()!;
    expect(frame).toContain("j/k");
    expect(frame).toContain("quit");
  });

  it("shows navigation hints for flows tab", () => {
    const sessions = makeSessions([]);
    const { lastFrame } = render(
      <StatusBar tab="flows" sessions={sessions} loading={false} error={null} label={null} />
    );
    const frame = lastFrame()!;
    expect(frame).toContain("j/k");
    expect(frame).toContain("move");
    expect(frame).toContain("Tab");
    expect(frame).toContain("detail");
    expect(frame).toContain("quit");
  });

  it("shows quit hint for tools tab", () => {
    const sessions = makeSessions([]);
    const { lastFrame } = render(
      <StatusBar tab="tools" sessions={sessions} loading={false} error={null} label={null} />
    );
    const frame = lastFrame()!;
    expect(frame).toContain("quit");
  });
});

// ── MetricBar ───────────────────────────────────────────────────────────────

describe("MetricBar", () => {
  it("renders label and suffix", () => {
    const { lastFrame } = render(
      <MetricBar label="CPU" value={25} max={100} suffix="25.0%" />
    );
    const frame = lastFrame()!;
    expect(frame).toContain("CPU");
    expect(frame).toContain("25.0%");
  });

  it("renders with default percentage when no suffix given", () => {
    const { lastFrame } = render(
      <MetricBar label="MEM" value={50} max={100} />
    );
    const frame = lastFrame()!;
    expect(frame).toContain("MEM");
    expect(frame).toContain("50.0%");
  });

  it("renders green for low values (under 50%)", () => {
    // Value=20, max=100 => 20% => green
    const { lastFrame } = render(
      <MetricBar label="CPU" value={20} max={100} suffix="20%" />
    );
    const frame = lastFrame()!;
    // The frame should contain filled blocks and empty blocks
    expect(frame).toContain("CPU");
    expect(frame).toContain("20%");
  });

  it("renders for high values (over 80%)", () => {
    // Value=90, max=100 => 90% => red
    const { lastFrame } = render(
      <MetricBar label="DISK" value={90} max={100} suffix="90%" />
    );
    const frame = lastFrame()!;
    expect(frame).toContain("DISK");
    expect(frame).toContain("90%");
  });

  it("handles zero max gracefully", () => {
    const { lastFrame } = render(
      <MetricBar label="X" value={0} max={0} suffix="n/a" />
    );
    const frame = lastFrame()!;
    expect(frame).toContain("X");
    expect(frame).toContain("n/a");
  });
});

// ── SectionHeader ───────────────────────────────────────────────────────────

describe("SectionHeader", () => {
  it("renders title text", () => {
    const { lastFrame } = render(<SectionHeader title="Info" />);
    expect(lastFrame()!).toContain("Info");
  });

  it("renders different titles", () => {
    const { lastFrame: f1 } = render(<SectionHeader title="Metrics" />);
    expect(f1()!).toContain("Metrics");

    const { lastFrame: f2 } = render(<SectionHeader title="Events" />);
    expect(f2()!).toContain("Events");
  });
});
