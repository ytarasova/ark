import { describe, it, expect } from "bun:test";
import React from "react";
import { render } from "ink-testing-library";
import { Text, Box } from "ink";
import { useFormNavigation } from "../components/form/useFormNavigation.js";
import { waitFor } from "../../core/__tests__/test-helpers.js";

function TestForm({ onCancel, onSubmit }: { onCancel: () => void; onSubmit?: () => void }) {
  const { active, fields } = useFormNavigation({
    fields: [
      { name: "name", type: "text" },
      { name: "color", type: "select" },
      { name: "path", type: "path" },
    ],
    onCancel,
    onSubmit,
  });

  return (
    <Box flexDirection="column">
      {fields.map(f => (
        <Text key={f.name}>{f.name === active ? `[${f.name}]` : f.name}</Text>
      ))}
    </Box>
  );
}

describe("useFormNavigation", () => {
  it("starts on first field", () => {
    const { lastFrame, unmount } = render(<TestForm onCancel={() => {}} />);
    expect(lastFrame()!).toContain("[name]");
    unmount();
  });

  it("Tab moves to next field", async () => {
    const { lastFrame, stdin, unmount } = render(<TestForm onCancel={() => {}} />);
    stdin.write("\t");
    await waitFor(() => lastFrame()!.includes("[color]"));
    expect(lastFrame()!).toContain("[color]");
    unmount();
  });

  it("does not move past last field with Tab", async () => {
    const { lastFrame, stdin, unmount } = render(<TestForm onCancel={() => {}} />);
    stdin.write("\t");
    stdin.write("\t");
    stdin.write("\t");
    stdin.write("\t");
    await waitFor(() => lastFrame()!.includes("[path]"));
    expect(lastFrame()!).toContain("[path]");
    unmount();
  });

  it("hides fields with visible=false", () => {
    function HiddenFieldForm() {
      const { active, fields } = useFormNavigation({
        fields: [
          { name: "a", type: "text" },
          { name: "b", type: "text", visible: false },
          { name: "c", type: "text" },
        ],
        onCancel: () => {},
      });
      return <Text>{fields.map(f => f.name).join(",")}</Text>;
    }

    const { lastFrame, unmount } = render(<HiddenFieldForm />);
    expect(lastFrame()!).toBe("a,c");
    unmount();
  });
});
