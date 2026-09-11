module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: "src",
  testRegex: ".*\\.spec\\.ts$",
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/../tsconfig.json" }],
    "^.+\\.js$": ["ts-jest", { tsconfig: { allowJs: true, module: "CommonJS", target: "ES2022" }, diagnostics: false }],
  },
  // sanitize-html uses ESM parser dependencies; Jest's CJS loader needs their transform.
  transformIgnorePatterns: ["node_modules/(?!(?:\\.pnpm/)?(?:htmlparser2|domhandler|domutils|domelementtype|dom-serializer|entities)(?:@|/))"],
  moduleNameMapper: {
    "^@bmc3/ai-core$": "<rootDir>/../../../packages/ai-core/src/index.ts",
    "^@bmc3/daily-practice-core$": "<rootDir>/../../../packages/daily-practice-core/src/index.ts",
    "^@bmc3/daily-practice-prisma$": "<rootDir>/../../../packages/daily-practice-prisma/src/index.ts",
    "^@bmc3/knowledge-core$": "<rootDir>/../../../packages/knowledge-core/src/index.ts",
    "^@bmc3/media-core$": "<rootDir>/../../../packages/media-core/src/index.ts",
    "^@bmc3/quiz-core$": "<rootDir>/../../../packages/quiz-core/src/index.ts",
  },
  collectCoverageFrom: ["**/*.(t|j)s", "!**/*.module.ts", "!main.ts"],
  coverageDirectory: "../coverage",
  testEnvironment: "node",
};
