/**
 * AppMode binding tests.
 *
 * These tests verify the DI contract of the AppMode bindings without needing a
 * DOM: both bindings must expose the same component slots, and LocalBinding
 * must reference the local variants while HostedBinding references the hosted
 * ones. This catches the "someone added a slot to the contract but forgot to
 * populate one binding" bug class at compile time + in CI.
 */

import { describe, test, expect } from "bun:test";
import { LocalBinding } from "../components/mode/local-binding.js";
import { HostedBinding } from "../components/mode/hosted-binding.js";
import { LocalRepoPicker } from "../components/mode/local-repo-picker.js";
import { HostedRepoPicker } from "../components/mode/hosted-repo-picker.js";
import { LocalFileInputRow } from "../components/mode/local-file-input-row.js";
import { HostedFileInputRow } from "../components/mode/hosted-file-input-row.js";
import { LocalFileInputAddEditor } from "../components/mode/local-file-input-add-editor.js";
import { HostedFileInputAddEditor } from "../components/mode/hosted-file-input-add-editor.js";

describe("AppMode bindings", () => {
  test("both bindings expose the same component slots", () => {
    const localKeys = Object.keys(LocalBinding).sort();
    const hostedKeys = Object.keys(HostedBinding).sort();
    expect(localKeys).toEqual(hostedKeys);
    // Guard against future accidental shrinkage.
    expect(localKeys).toEqual(["FileInputAddEditor", "FileInputRow", "RepoPicker"]);
  });

  test("LocalBinding wires to local variants", () => {
    expect(LocalBinding.RepoPicker).toBe(LocalRepoPicker);
    expect(LocalBinding.FileInputRow).toBe(LocalFileInputRow);
    expect(LocalBinding.FileInputAddEditor).toBe(LocalFileInputAddEditor);
  });

  test("HostedBinding wires to hosted variants", () => {
    expect(HostedBinding.RepoPicker).toBe(HostedRepoPicker);
    expect(HostedBinding.FileInputRow).toBe(HostedFileInputRow);
    expect(HostedBinding.FileInputAddEditor).toBe(HostedFileInputAddEditor);
  });

  test("local and hosted variants are distinct functions per slot", () => {
    expect(LocalBinding.RepoPicker).not.toBe(HostedBinding.RepoPicker);
    expect(LocalBinding.FileInputRow).not.toBe(HostedBinding.FileInputRow);
    expect(LocalBinding.FileInputAddEditor).not.toBe(HostedBinding.FileInputAddEditor);
  });
});
