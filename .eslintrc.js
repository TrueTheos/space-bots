/* eslint-env node */
module.exports = {
    extends: [
        "eslint:recommended",
        "plugin:@typescript-eslint/eslint-recommended",
        "plugin:@typescript-eslint/recommended",
    ],
    parser: "@typescript-eslint/parser",
    plugins: ["@typescript-eslint"],
    root: true,
    rules: {
        "@typescript-eslint/no-floating-promises": "warn",
    },
    parserOptions: {
        project: ["./tsconfig.json"],
    },
    ignorePatterns: [".eslintrc.js"],
};
