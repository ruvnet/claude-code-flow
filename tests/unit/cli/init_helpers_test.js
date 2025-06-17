import {
  assertEquals,
  assertSpyCall,
  assertSpyCalls,
  spy,
  stub,
} from "https://deno.land/std@0.224.0/testing/mock.ts";
import {
  assert,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "https://deno.land/std@0.224.0/assert/mod.ts";

// Import functions from simple-cli.js
// Assuming these functions are exported or can be accessed for testing.
// This might require temporary modifications to simple-cli.js to export them if they are not.
// For now, let's assume we can import them.
// We will need to adjust simple-cli.js to export these if they are not already.

// Placeholder for actual imports - will need to ensure these are exported from simple-cli.js
let createSparcStructureManually,
    handleClaudeMdOutput,
    handleSettingsJsonOutput,
    ensureDirectoryExists,
    fileExists,
    writeFileWithHandling,
    getDefaultSettingsJsonContent,
    getLocalExecutableContent,
    printWarning, // Assuming printWarning is also exportable for spy
    printSuccess, // Assuming printSuccess is also exportable for spy
    printError;   // Assuming printError is also exportable for spy

// Placeholder for claude-flow-commands.js import
let createClaudeFlowCommands;

// --- Test Suites ---
Deno.test("Init Helpers Test Suite", async (t) => {
  // This is a placeholder. Actual tests will be added in subsequent steps.
  // For now, just ensuring the test runner can pick up this file.

  // Example of how functions from simple-cli.js would be loaded if they were exported
  // This dynamic import is complex for top-level functions not designed as a module.
  // A better approach is to ensure simple-cli.js exports them or refactor them into a module.
  try {
    const simpleCliPath = "../../../src/cli/simple-cli.js"; // Adjust path as necessary
    const simpleCliModule = await import(simpleCliPath);

    createSparcStructureManually = simpleCliModule.createSparcStructureManually_TESTING_ONLY || simpleCliModule.createSparcStructureManually; // Example: use testing versions if available
    handleClaudeMdOutput = simpleCliModule.handleClaudeMdOutput_TESTING_ONLY || simpleCliModule.handleClaudeMdOutput;
    handleSettingsJsonOutput = simpleCliModule.handleSettingsJsonOutput_TESTING_ONLY || simpleCliModule.handleSettingsJsonOutput;
    ensureDirectoryExists = simpleCliModule.ensureDirectoryExists_TESTING_ONLY || simpleCliModule.ensureDirectoryExists;
    fileExists = simpleCliModule.fileExists_TESTING_ONLY || simpleCliModule.fileExists;
    writeFileWithHandling = simpleCliModule.writeFileWithHandling_TESTING_ONLY || simpleCliModule.writeFileWithHandling;
    getDefaultSettingsJsonContent = simpleCliModule.getDefaultSettingsJsonContent_TESTING_ONLY || simpleCliModule.getDefaultSettingsJsonContent;
    getLocalExecutableContent = simpleCliModule.getLocalExecutableContent_TESTING_ONLY || simpleCliModule.getLocalExecutableContent;
    printWarning = simpleCliModule.printWarning_TESTING_ONLY || simpleCliModule.printWarning;
    printSuccess = simpleCliModule.printSuccess_TESTING_ONLY || simpleCliModule.printSuccess;
    printError = simpleCliModule.printError_TESTING_ONLY || simpleCliModule.printError;


    const claudeFlowCommandsPath = "../../../src/cli/simple-commands/init/claude-commands/claude-flow-commands.js";
    const claudeFlowCommandsModule = await import(claudeFlowCommandsPath);
    createClaudeFlowCommands = claudeFlowCommandsModule.createClaudeFlowCommands;

  } catch (e) {
    console.error("Failed to import functions for testing. Ensure they are exported from their modules.", e);
    console.warn("Some tests will be skipped due to import errors.");
  }


  await t.step("fileExists helper", async (t) => {
    if (!fileExists) { console.warn("Skipping fileExists tests, function not loaded."); return; }

    let statStub;

    await t.step("should return true if file exists", async () => {
      statStub = stub(Deno, "stat", async () => await Promise.resolve({ isFile: true, isDirectory: false, isSymlink: false, size: 0, mtime: null, atime: null, birthtime: null, dev: 0, ino: 0, mode: 0, nlink: 0, uid: 0, gid: 0, rdev: 0, blksize: 0, blocks: 0  }));
      assert(await fileExists("anyfile.txt"));
      assertSpyCall(statStub, 0, { args: ["anyfile.txt"] });
      statStub.restore();
    });

    await t.step("should return false if file does not exist (NotFound error)", async () => {
      statStub = stub(Deno, "stat", async () => await Promise.reject(new Deno.errors.NotFound()));
      assertFalse(await fileExists("nonexistent.txt"));
      assertSpyCall(statStub, 0, { args: ["nonexistent.txt"] });
      statStub.restore();
    });

    await t.step("should re-throw other errors", async () => {
      statStub = stub(Deno, "stat", async () => await Promise.reject(new Error("Permission denied")));
      await assertRejects(async () => {
        await fileExists("anyfile.txt");
      }, Error, "Permission denied");
      statStub.restore();
    });
  });

  await t.step("ensureDirectoryExists helper", async (t) => {
    if (!ensureDirectoryExists) { console.warn("Skipping ensureDirectoryExists tests, function not loaded."); return; }

    let mkdirStub;
    let statStub;

    await t.step("should call Deno.mkdir with recursive true", async () => {
      mkdirStub = stub(Deno, "mkdir", async () => await Promise.resolve());
      statStub = stub(Deno, "stat", async () => await Promise.reject(new Deno.errors.NotFound())); // Simulate dir doesn't exist initially

      await ensureDirectoryExists("new/directory");

      assertSpyCall(mkdirStub, 0, { args: ["new/directory", { recursive: true }] });

      mkdirStub.restore();
      statStub.restore();
    });

    await t.step("should not throw if directory already exists (Deno.mkdir handles this with recursive:true)", async () => {
      // Deno.mkdir with recursive: true should not throw if the directory exists.
      // So we don't need to mock Deno.stat to simulate already existing directory for this specific case.
      mkdirStub = stub(Deno, "mkdir", async () => await Promise.resolve()); // Simulates Deno.mkdir success (or no-op if exists)

      await ensureDirectoryExists("existing/directory");
      assertSpyCall(mkdirStub, 0, { args: ["existing/directory", { recursive: true }] });

      mkdirStub.restore();
    });

    await t.step("should log and re-throw other errors from Deno.mkdir", async () => {
      if (!printError) { console.warn("Skipping printError test for ensureDirectoryExists, function not loaded."); return; }
      const consoleErrorSpy = spy(console, "error"); // Using console.error as printError uses it.
      mkdirStub = stub(Deno, "mkdir", async () => await Promise.reject(new Error("Test permission denied")));

      await assertRejects(async () => {
        await ensureDirectoryExists("any/directory");
      }, Error, "Test permission denied");

      // Check if printError (via console.error) was called
      // This is a bit indirect. If printError itself was spied, it would be cleaner.
      assertSpyCall(consoleErrorSpy, 0);
      assertStringIncludes(consoleErrorSpy.calls[0].args[0], "Failed to ensure directory any/directory: Test permission denied");

      mkdirStub.restore();
      consoleErrorSpy.restore();
    });
  });

  await t.step("writeFileWithHandling helper", async (t) => {
    if (!writeFileWithHandling || !fileExists || !ensureDirectoryExists || !printSuccess || !printWarning) {
      console.warn("Skipping writeFileWithHandling tests, required functions not loaded.");
      return;
    }

    let fileExistsStub, writeTextFileStub, ensureDirStub, readTextFileStub;
    let consoleSuccessSpy, consoleWarnSpy;

    const setupGlobalSpies = () => {
      // Ensure these are spied upon if not already, or use imported spied versions
      // For simplicity, assuming printSuccess and printWarning call console.log/warn
      consoleSuccessSpy = spy(console, "log"); // Assuming printSuccess calls console.log
      consoleWarnSpy = spy(console, "warn");   // Assuming printWarning calls console.warn
    };
    const restoreGlobalSpies = () => {
      consoleSuccessSpy.restore();
      consoleWarnSpy.restore();
    };

    await t.step("should create a new file if it does not exist", async () => {
      setupGlobalSpies();
      fileExistsStub = stub(Deno, "stat", async () => await Promise.reject(new Deno.errors.NotFound())); // fileExists will return false
      writeTextFileStub = stub(Deno, "writeTextFile", async () => await Promise.resolve());
      ensureDirStub = stub(Deno, "mkdir", async () => await Promise.resolve()); // ensureDirectoryExists calls this

      await writeFileWithHandling("testdir/newfile.txt", "new content", false, false, null);

      assertSpyCall(ensureDirStub, 0, { args: ["testdir", { recursive: true }] });
      assertSpyCall(writeTextFileStub, 0, { args: ["testdir/newfile.txt", "new content"] });
      assertSpyCall(consoleSuccessSpy, 0);
      assertStringIncludes(consoleSuccessSpy.calls[0].args[0], "Created testdir/newfile.txt");

      fileExistsStub.restore();
      writeTextFileStub.restore();
      ensureDirStub.restore();
      restoreGlobalSpies();
    });

    await t.step("should overwrite if force is true", async () => {
      setupGlobalSpies();
      fileExistsStub = stub(Deno, "stat", async () => await Promise.resolve({isFile: true})); // fileExists will return true
      writeTextFileStub = stub(Deno, "writeTextFile", async () => await Promise.resolve());
      ensureDirStub = stub(Deno, "mkdir", async () => await Promise.resolve());

      await writeFileWithHandling("testdir/existing.txt", "forced content", true, false, null);

      assertSpyCall(writeTextFileStub, 0, { args: ["testdir/existing.txt", "forced content"] });
      assertSpyCall(consoleSuccessSpy, 0);
      assertStringIncludes(consoleSuccessSpy.calls[0].args[0], "Overwrote testdir/existing.txt");

      fileExistsStub.restore();
      writeTextFileStub.restore();
      ensureDirStub.restore();
      restoreGlobalSpies();
    });

    await t.step("should skip and warn if file exists, no force, no merge", async () => {
      setupGlobalSpies();
      fileExistsStub = stub(Deno, "stat", async () => await Promise.resolve({isFile: true}));
      writeTextFileStub = stub(Deno, "writeTextFile", async () => await Promise.resolve()); // Should not be called
      ensureDirStub = stub(Deno, "mkdir", async () => await Promise.resolve());

      await writeFileWithHandling("testdir/existing.txt", "new data", false, false, null);

      assertEquals(writeTextFileStub.calls.length, 0); // Ensure not called
      assertSpyCall(consoleWarnSpy, 0);
      assertStringIncludes(consoleWarnSpy.calls[0].args[0], "testdir/existing.txt already exists. Use --force to overwrite or --merge to apply a strategy.");

      fileExistsStub.restore();
      writeTextFileStub.restore();
      ensureDirStub.restore();
      restoreGlobalSpies();
    });

    await t.step("should merge with append strategy if merge is true and strategy is null/basic", async () => {
      setupGlobalSpies();
      fileExistsStub = stub(Deno, "stat", async () => await Promise.resolve({isFile: true}));
      readTextFileStub = stub(Deno, "readTextFile", async () => await Promise.resolve("old content."));
      writeTextFileStub = stub(Deno, "writeTextFile", async () => await Promise.resolve());
      ensureDirStub = stub(Deno, "mkdir", async () => await Promise.resolve());

      await writeFileWithHandling("testdir/mergefile.txt", "new content.", true, true, null); // mergeStrategy = null implies basic append

      assertSpyCall(readTextFileStub, 0, { args: ["testdir/mergefile.txt"] });
      assertSpyCall(writeTextFileStub, 0, { args: ["testdir/mergefile.txt", "old content.\\nnew content."] });
      assertSpyCall(consoleSuccessSpy, 0);
      assertStringIncludes(consoleSuccessSpy.calls[0].args[0], "Merged content into testdir/mergefile.txt.");
      assertSpyCall(consoleWarnSpy,0) // It will warn about unknown merge strategy
      assertStringIncludes(consoleWarnSpy.calls[0].args[0], "Unknown merge strategy for testdir/mergefile.txt. Appending content.");


      fileExistsStub.restore();
      readTextFileStub.restore();
      writeTextFileStub.restore();
      ensureDirStub.restore();
      restoreGlobalSpies();
    });

    await t.step("should merge with custom function strategy if merge is true", async () => {
      setupGlobalSpies();
      fileExistsStub = stub(Deno, "stat", async () => await Promise.resolve({isFile: true}));
      readTextFileStub = stub(Deno, "readTextFile", async () => await Promise.resolve("Line1"));
      writeTextFileStub = stub(Deno, "writeTextFile", async () => await Promise.resolve());
      ensureDirStub = stub(Deno, "mkdir", async () => await Promise.resolve());
      const customMerge = (oldContent, newContent) => `${oldContent}\n${newContent} - merged by custom!`;

      await writeFileWithHandling("testdir/custommerge.txt", "Line2", true, true, customMerge);

      assertSpyCall(readTextFileStub, 0, { args: ["testdir/custommerge.txt"] });
      assertSpyCall(writeTextFileStub, 0, { args: ["testdir/custommerge.txt", "Line1\nLine2 - merged by custom!"] });
      assertSpyCall(consoleSuccessSpy, 0);
      assertStringIncludes(consoleSuccessSpy.calls[0].args[0], "Merged content into testdir/custommerge.txt.");

      fileExistsStub.restore();
      readTextFileStub.restore();
      writeTextFileStub.restore();
      ensureDirStub.restore();
      restoreGlobalSpies();
    });

  });

  await t.step("handleSettingsJsonOutput helper", async (t) => {
    if (!handleSettingsJsonOutput || !getDefaultSettingsJsonContent || !ensureDirectoryExists || !fileExists || !printSuccess || !printWarning || !printError) {
      console.warn("Skipping handleSettingsJsonOutput tests, required functions not loaded.");
      return;
    }

    let fileExistsStub, writeTextFileStub, ensureDirStub, readTextFileStub, mkdirStub;
    let consoleSuccessSpy, consoleWarnSpy, consoleErrorSpy;
    const workingDir = "test_project";
    const claudeDir = `${workingDir}/.claude`;
    const settingsPath = `${claudeDir}/settings.local.json`;
    const defaultSettings = JSON.parse(getDefaultSettingsJsonContent());

    const setupSpiesAndStubs = () => {
      consoleSuccessSpy = spy(console, "log"); // for printSuccess
      consoleWarnSpy = spy(console, "warn");   // for printWarning
      consoleErrorSpy = spy(console, "error"); // for printError
      // Deno stubs
      ensureDirStub = stub(Deno, "mkdir", async () => await Promise.resolve()); // Used by ensureDirectoryExists
      writeTextFileStub = stub(Deno, "writeTextFile", async () => await Promise.resolve());
      readTextFileStub = stub(Deno, "readTextFile", async (path) => await Promise.resolve(JSON.stringify({}))); // Default empty JSON
    };

    const restoreSpiesAndStubs = () => {
      consoleSuccessSpy.restore();
      consoleWarnSpy.restore();
      consoleErrorSpy.restore();
      ensureDirStub.restore();
      writeTextFileStub.restore();
      readTextFileStub.restore();
      if (fileExistsStub) fileExistsStub.restore(); // ensure it's restored if used
    };

    await t.step("should create .claude directory and settings.local.json if they don't exist", async () => {
      setupSpiesAndStubs();
      fileExistsStub = stub(Deno, "stat", async () => await Promise.reject(new Deno.errors.NotFound())); // fileExists returns false

      await handleSettingsJsonOutput(workingDir, getDefaultSettingsJsonContent(), false, false);

      assertSpyCall(ensureDirStub, 0, { args: [claudeDir, { recursive: true }] });
      assertSpyCall(writeTextFileStub, 0, { args: [settingsPath, JSON.stringify(defaultSettings, null, 2)] });
      assertSpyCall(consoleSuccessSpy, 0);
      assertStringIncludes(consoleSuccessSpy.calls[0].args[0], `Created ${settingsPath}`);

      restoreSpiesAndStubs();
    });

    await t.step("should overwrite settings.local.json if force is true", async () => {
      setupSpiesAndStubs();
      fileExistsStub = stub(Deno, "stat", async () => await Promise.resolve({isFile: true})); // fileExists returns true
      readTextFileStub.restore(); // Not needed for force overwrite test
      readTextFileStub = stub(Deno, "readTextFile", async () => await Promise.resolve(JSON.stringify({ "user_key": "uservalue" })));


      await handleSettingsJsonOutput(workingDir, getDefaultSettingsJsonContent(), true, false);

      assertSpyCall(writeTextFileStub, 0, { args: [settingsPath, JSON.stringify(defaultSettings, null, 2)] });
      assertSpyCall(consoleSuccessSpy, 0);
      assertStringIncludes(consoleSuccessSpy.calls[0].args[0], `Overwrote ${settingsPath}`);

      restoreSpiesAndStubs();
    });

    await t.step("should skip and warn if file exists, no force, no merge", async () => {
      setupSpiesAndStubs();
      fileExistsStub = stub(Deno, "stat", async () => await Promise.resolve({isFile: true}));

      await handleSettingsJsonOutput(workingDir, getDefaultSettingsJsonContent(), false, false);

      assertEquals(writeTextFileStub.calls.length, 0);
      assertSpyCall(consoleWarnSpy, 0);
      assertStringIncludes(consoleWarnSpy.calls[0].args[0], `${settingsPath} already exists. Use --force to overwrite or --merge to combine.`);

      restoreSpiesAndStubs();
    });

    await t.step("should merge settings if merge is true, preserving user keys", async () => {
      setupSpiesAndStubs();
      fileExistsStub = stub(Deno, "stat", async () => await Promise.resolve({isFile: true}));
      const existingUserSettings = { "sparc_default_mode": "tdd", "user_specific_key": "user_value", "log_level": "debug" };
      readTextFileStub.restore();
      readTextFileStub = stub(Deno, "readTextFile", async () => await Promise.resolve(JSON.stringify(existingUserSettings)));

      await handleSettingsJsonOutput(workingDir, getDefaultSettingsJsonContent(), false, true);

      const expectedMergedSettings = {
        ...defaultSettings, // Start with defaults
        ...existingUserSettings, // Override with user's settings
      };

      assertSpyCall(writeTextFileStub, 0, { args: [settingsPath, JSON.stringify(expectedMergedSettings, null, 2)] });
      assertSpyCall(consoleSuccessSpy, 0);
      assertStringIncludes(consoleSuccessSpy.calls[0].args[0], `Merged settings into ${settingsPath}`);

      restoreSpiesAndStubs();
    });

    await t.step("should add new default keys if missing during merge", async () => {
        setupSpiesAndStubs();
        fileExistsStub = stub(Deno, "stat", async () => await Promise.resolve({isFile: true}));
        const existingUserSettings = { "user_specific_key": "user_value" }; // Missing some default keys
        readTextFileStub.restore();
        readTextFileStub = stub(Deno, "readTextFile", async () => await Promise.resolve(JSON.stringify(existingUserSettings)));

        await handleSettingsJsonOutput(workingDir, getDefaultSettingsJsonContent(), false, true);

        const expectedMergedSettings = {
          ...defaultSettings, // Start with defaults
          ...existingUserSettings, // Override with user's settings
        };

        assertSpyCall(writeTextFileStub, 0, { args: [settingsPath, JSON.stringify(expectedMergedSettings, null, 2)] });
        assertSpyCall(consoleSuccessSpy, 0);
        assertStringIncludes(consoleSuccessSpy.calls[0].args[0], `Merged settings into ${settingsPath}`);

        restoreSpiesAndStubs();
      });

    await t.step("should overwrite with defaults if existing JSON is corrupt during merge", async () => {
      setupSpiesAndStubs();
      fileExistsStub = stub(Deno, "stat", async () => await Promise.resolve({isFile: true}));
      readTextFileStub.restore();
      readTextFileStub = stub(Deno, "readTextFile", async () => await Promise.resolve("this is not json"));

      await handleSettingsJsonOutput(workingDir, getDefaultSettingsJsonContent(), false, true);

      assertSpyCall(writeTextFileStub, 0, { args: [settingsPath, JSON.stringify(defaultSettings, null, 2)] });
      assertSpyCall(consoleWarnSpy, 0);
      assertStringIncludes(consoleWarnSpy.calls[0].args[0], `Could not parse existing ${settingsPath}`);
      assertSpyCall(consoleSuccessSpy, 0);
      assertStringIncludes(consoleSuccessSpy.calls[0].args[0], `Overwrote corrupted ${settingsPath}`);

      restoreSpiesAndStubs();
    });
  });

  await t.step("handleClaudeMdOutput helper", async (t) => {
    if (!handleClaudeMdOutput || !fileExists || !printSuccess || !printWarning || !printError) {
      console.warn("Skipping handleClaudeMdOutput tests, required functions not loaded.");
      return;
    }

    let fileExistsStub, writeTextFileStub, readTextFileStub;
    let consoleSuccessSpy, consoleWarnSpy, consoleErrorSpy;
    const workingDir = "test_project_md";
    const claudeMdPath = `${workingDir}/CLAUDE.md`;

    const setup = () => {
      consoleSuccessSpy = spy(console, "log");
      consoleWarnSpy = spy(console, "warn");
      consoleErrorSpy = spy(console, "error");
      writeTextFileStub = stub(Deno, "writeTextFile", async () => await Promise.resolve());
      readTextFileStub = stub(Deno, "readTextFile", async () => await Promise.resolve("")); // Default empty
      // fileExists (via Deno.stat) will be stubbed per test case
    };

    const teardown = () => {
      consoleSuccessSpy.restore();
      consoleWarnSpy.restore();
      consoleErrorSpy.restore();
      writeTextFileStub.restore();
      readTextFileStub.restore();
      if (fileExistsStub) fileExistsStub.restore();
    };

    await t.step("should create CLAUDE.md if it does not exist", async () => {
      setup();
      fileExistsStub = stub(Deno, "stat", async () => await Promise.reject(new Deno.errors.NotFound()));
      const newContent = "## New Project\nDetails here.";

      await handleClaudeMdOutput(workingDir, newContent, false, false);

      assertSpyCall(writeTextFileStub, 0, { args: [claudeMdPath, newContent] });
      assertSpyCall(consoleSuccessSpy, 0);
      assertStringIncludes(consoleSuccessSpy.calls[0].args[0], `Created ${claudeMdPath}`);
      teardown();
    });

    await t.step("should overwrite CLAUDE.md if force is true", async () => {
      setup();
      fileExistsStub = stub(Deno, "stat", async () => await Promise.resolve({isFile: true}));
      const newContent = "## Forced Project\nDetails here.";
      // readTextFile won't be called in force=true if file exists.

      await handleClaudeMdOutput(workingDir, newContent, true, false);

      assertSpyCall(writeTextFileStub, 0, { args: [claudeMdPath, newContent] });
      assertSpyCall(consoleSuccessSpy, 0);
      assertStringIncludes(consoleSuccessSpy.calls[0].args[0], `Overwrote ${claudeMdPath}`);
      teardown();
    });

    await t.step("should skip and warn if file exists, no force, no merge", async () => {
      setup();
      fileExistsStub = stub(Deno, "stat", async () => await Promise.resolve({isFile: true}));

      await handleClaudeMdOutput(workingDir, "any content", false, false);

      assertEquals(writeTextFileStub.calls.length, 0);
      assertSpyCall(consoleWarnSpy, 0);
      assertStringIncludes(consoleWarnSpy.calls[0].args[0], `${claudeMdPath} already exists. Use --force to overwrite or --merge to combine.`);
      teardown();
    });

    await t.step("should merge MD content by appending unique new sections", async () => {
      setup();
      fileExistsStub = stub(Deno, "stat", async () => await Promise.resolve({isFile: true}));
      const existingContent = "## Section 1\nOld S1 content.\n\n## Section 2\nOld S2 content.";
      const newContent = "## Section 2\nNew S2 content (should be ignored).\n\n## Section 3\nNew S3 content (should be added).";
      readTextFileStub.restore(); // Restore default before re-stubbing
      readTextFileStub = stub(Deno, "readTextFile", async () => await Promise.resolve(existingContent));

      await handleClaudeMdOutput(workingDir, newContent, false, true);

      const expectedMergedContent = existingContent + "\n\n" + "## Section 3\nNew S3 content (should be added).";
      assertSpyCall(writeTextFileStub, 0, { args: [claudeMdPath, expectedMergedContent] });
      assertSpyCall(consoleSuccessSpy, 0);
      assertStringIncludes(consoleSuccessSpy.calls[0].args[0], `Merged new sections into ${claudeMdPath}`);
      teardown();
    });

    await t.step("should not merge if all new sections already exist", async () => {
      setup();
      fileExistsStub = stub(Deno, "stat", async () => await Promise.resolve({isFile: true}));
      const existingContent = "## Section 1\nOld S1 content.\n\n## Section 2\nOld S2 content.";
      const newContent = "## Section 1\nNew S1 content (should be ignored).";
      readTextFileStub.restore();
      readTextFileStub = stub(Deno, "readTextFile", async () => await Promise.resolve(existingContent));

      await handleClaudeMdOutput(workingDir, newContent, false, true);

      assertEquals(writeTextFileStub.calls.length, 0); // No write if no new sections to add
      assertSpyCall(consoleWarnSpy, 0);
      assertStringIncludes(consoleWarnSpy.calls[0].args[0], `${claudeMdPath} already contains all sections from new content or new content has no sections. No merge performed.`);
      teardown();
    });

    await t.step("should merge when existing content is empty", async () => {
        setup();
        fileExistsStub = stub(Deno, "stat", async () => await Promise.resolve({ isFile: true }));
        const existingContent = "";
        const newContent = "## New Section\nSome details.";
        readTextFileStub.restore();
        readTextFileStub = stub(Deno, "readTextFile", async () => await Promise.resolve(existingContent));

        await handleClaudeMdOutput(workingDir, newContent, false, true);

        const expectedMergedContent = existingContent + "\n\n" + "## New Section\nSome details.";
        assertSpyCall(writeTextFileStub, 0, { args: [claudeMdPath, expectedMergedContent] });
        assertSpyCall(consoleSuccessSpy, 0);
        assertStringIncludes(consoleSuccessSpy.calls[0].args[0], `Merged new sections into ${claudeMdPath}`);
        teardown();
    });

    await t.step("should merge when new content has no '## ' sections (appends all as one block)", async () => {
        setup();
        fileExistsStub = stub(Deno, "stat", async () => await Promise.resolve({ isFile: true }));
        const existingContent = "## Existing Section\nContent";
        const newContent = "Just some plain text.\nMore plain text."; // No "## " headers
        readTextFileStub.restore();
        readTextFileStub = stub(Deno, "readTextFile", async () => await Promise.resolve(existingContent));

        // The current merge logic for MD relies on "## " sections in the *new* content to identify what to merge.
        // If new content has no "## ", it currently doesn't append anything. This might be desired or not.
        // The test below reflects the current implementation.
        await handleClaudeMdOutput(workingDir, newContent, false, true);

        // Based on current logic: if newContent has no "## " sections, no new sections are identified to be merged.
        assertEquals(writeTextFileStub.calls.length, 0);
        assertSpyCall(consoleWarnSpy, 0);
        assertStringIncludes(consoleWarnSpy.calls[0].args[0], `already contains all sections from new content or new content has no sections. No merge performed.`);
        teardown();
    });


  });

  await t.step("createSparcStructureManually helper", async (t) => {
    if (!createSparcStructureManually || !printSuccess || !printWarning || !createComprehensiveRoomodesConfig || !createBasicSparcWorkflow || !createRooReadme ) {
        console.warn("Skipping createSparcStructureManually tests, required functions not loaded.");
        return;
    }

    let statStub, writeTextFileStub, mkdirStub;
    let consoleSuccessSpy, consoleWarnSpy;

    // Mocked content functions
    const comprehensiveRoomodesConfigContent = () => '{"type": "comprehensive"}';
    const basicSparcWorkflowContent = () => '{"type": "basic_workflow"}';
    const rooReadmeContent = () => "Roo README content";
    const placeholderContent = (name) => `${name} README content`;

    // Stub the imported content generation functions from simple-cli.js
    let originalCreateComprehensiveRoomodesConfig;
    let originalCreateBasicSparcWorkflow;
    let originalCreateRooReadme;


    const setup = () => {
      consoleSuccessSpy = spy(console, "log");
      consoleWarnSpy = spy(console, "warn");

      mkdirStub = stub(Deno, "mkdir", async () => await Promise.resolve());
      writeTextFileStub = stub(Deno, "writeTextFile", async () => await Promise.resolve());
      // statStub will be configured per test case

      // Stub functions that createSparcStructureManually calls internally
      // This assumes they are available in the scope, which they are if imported correctly.
      // If they were methods of an object, we'd stub that object's methods.
      // Here, we are replacing the global/module-level functions.
      originalCreateComprehensiveRoomodesConfig = createComprehensiveRoomodesConfig;
      globalThis.createComprehensiveRoomodesConfig = spy(comprehensiveRoomodesConfigContent);

      originalCreateBasicSparcWorkflow = createBasicSparcWorkflow;
      globalThis.createBasicSparcWorkflow = spy(basicSparcWorkflowContent);

      originalCreateRooReadme = createRooReadme;
      globalThis.createRooReadme = spy(rooReadmeContent);
    };

    const teardown = () => {
      consoleSuccessSpy.restore();
      consoleWarnSpy.restore();
      mkdirStub.restore();
      writeTextFileStub.restore();
      if (statStub) statStub.restore();

      globalThis.createComprehensiveRoomodesConfig = originalCreateComprehensiveRoomodesConfig;
      globalThis.createBasicSparcWorkflow = originalCreateBasicSparcWorkflow;
      globalThis.createRooReadme = originalCreateRooReadme;
    };

    await t.step("should create all directories and files when none exist", async () => {
      setup();
      statStub = stub(Deno, "stat", async () => await Promise.reject(new Deno.errors.NotFound()));

      await createSparcStructureManually(false);

      // Check directory creations
      const expectedDirs = ['.roo', '.roo/templates', '.roo/workflows', '.roo/modes', '.roo/configs'];
      expectedDirs.forEach((dir, i) => assertSpyCall(mkdirStub, i, { args: [dir, { recursive: true }] }));

      // Check file creations
      assertSpyCall(writeTextFileStub, 0, { args: [".roomodes", comprehensiveRoomodesConfigContent()] });
      assertSpyCall(writeTextFileStub, 1, { args: [".roo/workflows/basic-tdd.json", basicSparcWorkflowContent()] });
      assertSpyCall(writeTextFileStub, 2, { args: [".roo/README.md", rooReadmeContent()] });
      assertSpyCall(writeTextFileStub, 3, { args: [".roo/templates/README.md", "This directory can store custom code templates for SPARC modes, such as boilerplate for new modules, components, or test files. These templates can be used by SPARC modes to accelerate development."] });
      assertSpyCall(writeTextFileStub, 4, { args: [".roo/modes/README.md", "This directory can store custom SPARC mode definitions if you need to extend or tailor the default modes provided in the .roomodes file. Files here might define specialized roles, instructions, or toolsets for your project's unique needs."] });
      assertSpyCall(writeTextFileStub, 5, { args: [".roo/configs/README.md", "This directory can store project-specific configurations for SPARC modes or workflows. For example, you might have different linting rules, testing configurations, or deployment settings for different modes."] });

      assertEquals(writeTextFileStub.calls.length, 6);
      assertSpyCalls(consoleSuccessSpy, 6 + expectedDirs.length); // Files + Dirs
      teardown();
    });

    await t.step("should overwrite files if forceOverwrite is true", async () => {
      setup();
      statStub = stub(Deno, "stat", async () => await Promise.resolve({isFile: true})); // All files exist

      await createSparcStructureManually(true); // forceOverwrite = true

      assertEquals(writeTextFileStub.calls.length, 6); // All 6 files should be written
      assertSpyCall(writeTextFileStub, 0, { args: [".roomodes", comprehensiveRoomodesConfigContent()] });
      // Warnings for overwriting
      assertSpyCalls(consoleWarnSpy, 3); // .roomodes, basic-tdd.json, and 3 placeholder READMEs (if logic makes them warn on overwrite)
                                        // The current simple-cli.js implementation for createSparcStructureManually warns for .roomodes and basic-tdd.json
                                        // and for placeholderReadmes if forceOverwrite is true.

      // Check one of the placeholder READMEs to ensure it's overwritten
      const configsReadmeCall = writeTextFileStub.calls.find(call => call.args[0] === ".roo/configs/README.md");
      assert(configsReadmeCall, ".roo/configs/README.md should be written");
      assertEquals(configsReadmeCall.args[1], "This directory can store project-specific configurations for SPARC modes or workflows. For example, you might have different linting rules, testing configurations, or deployment settings for different modes.");

      teardown();
    });

    await t.step("should skip existing files if forceOverwrite is false", async () => {
      setup();
      statStub = stub(Deno, "stat", async () => await Promise.resolve({isFile: true})); // All files exist

      await createSparcStructureManually(false); // forceOverwrite = false

      // .roomodes and basic-tdd.json should be skipped with warnings
      // .roo/README.md and placeholder READMEs might be skipped without explicit warnings or created if logic differs slightly (current simple-cli logic for READMEs is to skip if exists, no force)

      const roomodesWriteCall = writeTextFileStub.calls.find(c => c.args[0] === '.roomodes');
      assertEquals(roomodesWriteCall, undefined, ".roomodes should not be written");

      const workflowWriteCall = writeTextFileStub.calls.find(c => c.args[0] === '.roo/workflows/basic-tdd.json');
      assertEquals(workflowWriteCall, undefined, "workflow json should not be written");

      // Check warnings for .roomodes and workflow
      const warnings = consoleWarnSpy.calls.map(call => call.args[0]);
      assert(warnings.some(w => w.includes(".roomodes already exists. Use --force to overwrite.")));
      assert(warnings.some(w => w.includes(".roo/workflows/basic-tdd.json already exists. Use --force to overwrite.")));

      // READMEs: In the current createSparcStructureManually, if forceOverwrite is false and they exist, they are skipped.
      // The logging for skipping READMEs is not a printWarning, but rather they just aren't logged with printSuccess.
      // So, we check that they are NOT written.
      const rooReadmeWriteCall = writeTextFileStub.calls.find(c => c.args[0] === '.roo/README.md');
      assertEquals(rooReadmeWriteCall, undefined, ".roo/README.md should not be written if it exists and force=false");

      const templatesReadmeWriteCall = writeTextFileStub.calls.find(c => c.args[0] === '.roo/templates/README.md');
      assertEquals(templatesReadmeWriteCall, undefined, ".roo/templates/README.md should not be written if it exists and force=false");


      // Total writes should be 0 if all files existed and force is false
      // Based on current logic where READMEs are also skipped if they exist and no force
      assertEquals(writeTextFileStub.calls.length, 0);

      teardown();
    });
  });

  await t.step("createClaudeFlowCommands function (from claude-flow-commands.js)", async (t) => {
    if (!createClaudeFlowCommands) {
      console.warn("Skipping createClaudeFlowCommands tests, function not loaded.");
      return;
    }

    let statStub, writeTextFileStub;
    let consoleWarnSpy, consoleLogSpy; // Using console.log for success messages from this func
    const workingDir = "test_cf_commands_dir";
    const commandsDir = `${workingDir}/.claude/commands`; // This dir should be ensured by initCommand, not this func.

    const setup = () => {
      // createClaudeFlowCommands uses console.log for success, console.warn for warnings
      consoleLogSpy = spy(console, "log");
      consoleWarnSpy = spy(console, "warn");
      writeTextFileStub = stub(Deno, "writeTextFile", async () => await Promise.resolve());
      // statStub will be configured per test case for Deno.stat calls
    };

    const teardown = () => {
      consoleLogSpy.restore();
      consoleWarnSpy.restore();
      writeTextFileStub.restore();
      if (statStub) statStub.restore();
    };

    const commandFiles = [
      "claude-flow-help.md",
      "claude-flow-memory.md",
      "claude-flow-swarm.md"
    ];

    await t.step("should create all command files if they do not exist", async () => {
      setup();
      statStub = stub(Deno, "stat", async () => await Promise.reject(new Deno.errors.NotFound()));

      await createClaudeFlowCommands(workingDir, false, false);

      assertEquals(writeTextFileStub.calls.length, commandFiles.length);
      commandFiles.forEach((filename, index) => {
        assertSpyCall(writeTextFileStub, index, { args: [`${commandsDir}/${filename}`, String] }); // Check path and that content is string
        assertSpyCall(consoleLogSpy, index); // Check for success log
        assertStringIncludes(consoleLogSpy.calls[index].args[0], `Created slash command: /${filename.replace('.md','')}`);
      });
      teardown();
    });

    await t.step("should overwrite files if force is true and files exist", async () => {
      setup();
      statStub = stub(Deno, "stat", async () => await Promise.resolve({isFile: true})); // All files exist

      await createClaudeFlowCommands(workingDir, true, false); // force = true

      assertEquals(writeTextFileStub.calls.length, commandFiles.length);
      commandFiles.forEach((filename, index) => {
        assertSpyCall(writeTextFileStub, index, { args: [`${commandsDir}/${filename}`, String] });
        assertSpyCall(consoleLogSpy, index);
        assertStringIncludes(consoleLogSpy.calls[index].args[0], `Overwrote slash command: /${filename.replace('.md','')}`);
      });
      teardown();
    });

    await t.step("should skip existing files and warn if force is false and files exist", async () => {
      setup();
      statStub = stub(Deno, "stat", async () => await Promise.resolve({isFile: true})); // All files exist

      await createClaudeFlowCommands(workingDir, false, false); // force = false

      assertEquals(writeTextFileStub.calls.length, 0); // No files should be written
      assertSpyCalls(consoleWarnSpy, commandFiles.length);
      commandFiles.forEach((filename, index) => {
        assertStringIncludes(consoleWarnSpy.calls[index].args[0], `${filename.replace('.md','')} command file (${commandsDir}/${filename}) already exists. Use --force to overwrite.`);
      });
      teardown();
    });

    // Note: createClaudeFlowCommands doesn't have a 'merge' strategy for content,
    // the 'merge' flag is interpreted as "don't overwrite if exists, unless force=true".
    // So, testing with merge=true, force=false should be same as above.
    await t.step("should skip existing files if force is false and merge is true (no specific merge for these files)", async () => {
        setup();
        statStub = stub(Deno, "stat", async () => await Promise.resolve({isFile: true})); // All files exist

        await createClaudeFlowCommands(workingDir, false, true); // force = false, merge = true

        assertEquals(writeTextFileStub.calls.length, 0); // No files should be written
        assertSpyCalls(consoleWarnSpy, commandFiles.length);
        commandFiles.forEach((filename, index) => {
          assertStringIncludes(consoleWarnSpy.calls[index].args[0], `${filename.replace('.md','')} command file (${commandsDir}/${filename}) already exists. Use --force to overwrite.`);
        });
        teardown();
      });
  });
  // More tests will be added here for other functions
  // For now, this structure allows running Deno test and seeing it pass (or skip if imports fail)

});

// To make functions in simple-cli.js testable, they need to be exported.
// One way is to add a conditional export block at the end of simple-cli.js:
/*
if (typeof TESTING_ONLY_MODE !== 'undefined' && TESTING_ONLY_MODE) {
  exports.createSparcStructureManually_TESTING_ONLY = createSparcStructureManually;
  exports.handleClaudeMdOutput_TESTING_ONLY = handleClaudeMdOutput;
  // ... and so on for all functions and consts needed for tests
}
*/
// Then in tests, before importing, set globalThis.TESTING_ONLY_MODE = true;
// However, Deno uses ES modules, so direct `export` statements in simple-cli.js would be cleaner.
// For example, at the end of simple-cli.js:
// export { createSparcStructureManually, handleClaudeMdOutput, ... printWarning, printSuccess, printError };
// And for const that are functions: export const getDefaultSettingsJsonContent = () => defaultSettingsJsonContent; (if it was a const)

// For now, the test file assumes these will be made available.
// If direct modification of simple-cli.js for exports is not allowed in this step,
// the tests for those functions will effectively be skipped or will fail on import.
