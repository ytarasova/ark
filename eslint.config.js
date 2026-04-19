import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";
import reactHooks from "eslint-plugin-react-hooks";

export default [
  {
    // Global ignores (apply to every config below).
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.d.ts",
    ],
  },
  {
    files: ["packages/**/*.ts", "packages/**/*.tsx"],
    ignores: ["**/node_modules/**", "**/dist/**", "**/*.d.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      // No unused variables (error for vars, warn for args with _ prefix)
      "@typescript-eslint/no-unused-vars": ["warn", {
        argsIgnorePattern: "^_",
        varsIgnorePattern: "^_",
      }],
      // No require() in ES modules
      "@typescript-eslint/no-require-imports": "error",
      // No explicit any (warn -- strict:false means lots of implicit any)
      "@typescript-eslint/no-explicit-any": "off",
      // Prefer const
      "prefer-const": "warn",
      // No console.log in production (warn)
      "no-console": ["warn", { allow: ["warn", "error"] }],
      // No empty catch blocks
      "no-empty": ["error", { allowEmptyCatch: false }],
    },
  },
  {
    // React hooks rules enforced for the web frontend. Error level so CI
    // rejects stale-closure / conditional-hook regressions.
    files: ["packages/web/**/*.ts", "packages/web/**/*.tsx", "packages/desktop/**/*.ts", "packages/desktop/**/*.tsx"],
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "error",
    },
  },
  {
    // Relax rules for test files
    files: ["**/__tests__/**", "**/*.test.ts", "**/*.test.tsx"],
    rules: {
      "no-console": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
  {
    // Relax for CLI (console.log is expected)
    files: ["packages/cli/**"],
    rules: {
      "no-console": "off",
    },
  },
  {
    // Hex boundary: ports and domain code MUST NOT reach raw infrastructure.
    // Every I/O side effect goes through an adapter injected via the container.
    files: ["packages/core/ports/**", "packages/core/domain/**"],
    rules: {
      "no-restricted-imports": ["error", {
        paths: [
          { name: "fs", message: "Ports/domain must not import fs. Use Workspace port." },
          { name: "fs/promises", message: "Ports/domain must not import fs. Use Workspace port." },
          { name: "node:fs", message: "Ports/domain must not import fs. Use Workspace port." },
          { name: "node:fs/promises", message: "Ports/domain must not import fs. Use Workspace port." },
          { name: "child_process", message: "Ports/domain must not import child_process. Use ProcessRunner port." },
          { name: "node:child_process", message: "Ports/domain must not import child_process. Use ProcessRunner port." },
          { name: "bun:sqlite", message: "Ports/domain must not import SQLite directly. Use SessionStore/EventStore ports." },
        ],
      }],
    },
  },
  {
    // Hex boundary: adapters are siblings; one adapter must not reach into
    // another adapter's internals. Composition happens in the binding module.
    files: ["packages/core/adapters/**"],
    rules: {
      "no-restricted-imports": ["error", {
        patterns: [
          { group: ["../local/*", "../control-plane/*", "../test/*"], message: "Adapters must not import each other. Compose via binding modules." },
        ],
      }],
    },
  },
];
