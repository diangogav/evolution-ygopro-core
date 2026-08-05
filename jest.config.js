module.exports = {
	preset: "ts-jest",
	testEnvironment: "node",
	roots: ["<rootDir>/test"],
	testMatch: ["**/*.integration.test.ts"],
	setupFiles: ["reflect-metadata"],
	testTimeout: 60000,
	maxWorkers: "50%",
	transform: {
		"^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.json" }],
	},
};
