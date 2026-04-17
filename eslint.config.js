import tsPlugin from "@typescript-eslint/eslint-plugin";
import tsParser from "@typescript-eslint/parser";

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
];
