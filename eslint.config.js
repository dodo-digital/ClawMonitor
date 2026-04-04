import tsParser from "@typescript-eslint/parser";
import tseslint from "@typescript-eslint/eslint-plugin";

export default [
  {
    ignores: ["build/**", "dist/**", "node_modules/**"],
  },
  {
    files: ["**/*.{ts,tsx,js}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tseslint,
    },
    rules: {
      ...tseslint.configs.recommended.rules,
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-unused-vars": "off",
    },
  },
];
