import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { FlatCompat } from "@eslint/eslintrc";

const compat = new FlatCompat({
  baseDirectory: dirname(fileURLToPath(import.meta.url)),
});

const config = [
  {
    ignores: [
      ".next/**",
      "dist/**",
      "packages/*/dist/**",
      // Capacitor wrapper: vendored web assets and a generated native project,
      // neither authored nor built here. The `ios` CI job compiles it instead.
      "ios-app/**",
      // Git worktrees created under .claude/worktrees/ are full checkouts of
      // this same repo. Without this, `npm run lint` walks into them and
      // reports every nested copy of tests/ as errors — the `tests/**`
      // override below cannot match `.claude/worktrees/<name>/tests/**`.
      // CI never sees this because it lints a fresh checkout.
      ".claude/**",
      "next-env.d.ts",
    ],
  },

  ...compat.extends("next/core-web-vitals", "next/typescript"),

  {
    rules: {
      // A leading underscore is the repo's existing signal for "deliberately
      // unused" — `_requestedStatus`, `_default` and friends already read that
      // way. Honour it rather than rewriting those call sites.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
    },
  },

  {
    // Tests deliberately build shapes the type system forbids, because that is
    // the thing under test — `openapi-adversarial` exists to feed the compiler
    // documents no valid caller could construct. `unknown` does not help there:
    // the value has to reach a function that expects the real type, so the cast
    // just moves. AGENTS.md's no-`any` rule is about shipping code, and src/ is
    // already clean of it — that is enforced as an error above.
    //
    // `no-assign-module-variable` guards Next's webpack `module` global. These
    // are vitest files with a local binding of that name; the rule does not
    // apply to them.
    files: ["tests/**", "packages/*/tests/**"],
    rules: {
      "@typescript-eslint/no-explicit-any": "off",
      "@next/next/no-assign-module-variable": "off",
    },
  },
];

export default config;
