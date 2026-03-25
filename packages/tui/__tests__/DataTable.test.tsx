import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { DataTable } from "../components/DataTable.js";

const columns = [
  { key: "name", label: "Name", width: 12 },
  { key: "cpu", label: "CPU", width: 6 },
  { key: "status", label: "Status" },
];

const rows = [
  { name: "proc-1", cpu: "25.0", status: "running" },
  { name: "proc-2", cpu: "10.5", status: "idle" },
  { name: "proc-3", cpu: "0.1", status: "sleeping" },
];

describe("DataTable", () => {
  it("renders header and all rows", () => {
    const { lastFrame, unmount } = render(<DataTable columns={columns} rows={rows} />);
    const frame = lastFrame()!;
    expect(frame).toContain("Name");
    expect(frame).toContain("CPU");
    expect(frame).toContain("proc-1");
    expect(frame).toContain("proc-3");
    unmount();
  });

  it("respects limit", () => {
    const { lastFrame, unmount } = render(<DataTable columns={columns} rows={rows} limit={2} />);
    const frame = lastFrame()!;
    expect(frame).toContain("proc-1");
    expect(frame).toContain("proc-2");
    expect(frame).not.toContain("proc-3");
    unmount();
  });

  it("renders empty table with just header", () => {
    const { lastFrame, unmount } = render(<DataTable columns={columns} rows={[]} />);
    const frame = lastFrame()!;
    expect(frame).toContain("Name");
    expect(frame).not.toContain("proc");
    unmount();
  });
});
