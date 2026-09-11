import { vi, afterAll } from "vitest";
import dotenv from "dotenv";
import { resolve } from "path";
import fs from "fs";

// Load the .env file
const envPath = resolve(__dirname, "../../.env");
dotenv.config({ path: envPath });

// Read the .env file content
const envContent = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf-8") : "";

// Parse the .env content
const envVars = dotenv.parse(envContent);

// Separate public and private variables
const publicEnv = {};
const privateEnv = {};

for (const [key, value] of Object.entries(envVars)) {
	if (key.startsWith("PUBLIC_")) {
		publicEnv[key] = value;
	} else {
		privateEnv[key] = value;
	}
}

vi.mock("$env/dynamic/public", () => ({
	env: publicEnv,
}));

vi.mock("$env/dynamic/private", async () => {
	return {
		env: {
			...privateEnv,
			// RVF store uses in-memory for tests (no file path = no persistence)
			RVF_DB_PATH: "",
		},
	};
});

afterAll(async () => {
	// No cleanup needed — RVF store is in-memory for tests
});
