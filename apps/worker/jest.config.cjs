module.exports = {
  moduleFileExtensions: ["js", "json", "ts"],
  rootDir: "src",
  testRegex: ".*\\.spec\\.ts$",
  transform: {
    "^.+\\.ts$": ["ts-jest", { tsconfig: "<rootDir>/../tsconfig.json" }],
  },
  moduleNameMapper: {
    "^@bmc3/ai-core$": "<rootDir>/../../../packages/ai-core/src/index.ts",
    "^@bmc3/daily-practice-core$": "<rootDir>/../../../packages/daily-practice-core/src/index.ts",
    "^@bmc3/daily-practice-prisma$": "<rootDir>/../../../packages/daily-practice-prisma/src/index.ts",
    "^@bmc3/knowledge-core$": "<rootDir>/../../../packages/knowledge-core/src/index.ts",
    "^@bmc3/media-core$": "<rootDir>/../../../packages/media-core/src/index.ts",
    "^@bmc3/quiz-core$": "<rootDir>/../../../packages/quiz-core/src/index.ts",
  },
  testEnvironment: "node",
};
