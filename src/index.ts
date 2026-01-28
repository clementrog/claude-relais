#!/usr/bin/env node

import { Command } from "commander";
import { execSync } from "node:child_process";
import { loadConfig, findConfigFile, validateConfig, ConfigError, CONFIG_FILE_NAME } from "./lib/config.js";
import { atomicReadJson } from "./lib/fs.js";
import type { RelaisConfig } from "./types/config.js";

const program = new Command();

// Global config option
let globalConfigPath: string | undefined;

program
  .name("relais")
  .description("Deterministic orchestration runner for Claude Code")
  .version("1.0.0")
  .option("-c, --config <path>", "Path to configuration file")
  .hook("preAction", (thisCommand) => {
    globalConfigPath = thisCommand.opts().config;
  });

program
  .command("init")
  .description("Initialize relais workspace in current directory")
  .action(() => {
    console.log("relais init - not yet implemented");
  });

program
  .command("status")
  .description("Show current relais state")
  .option("--preflight", "Run preflight checks")
  .action(async (options) => {
    try {
      const config = await loadConfig(globalConfigPath);
      console.log(`relais status (${config.product_name} v${config.version})`);
      console.log(`  workspace: ${config.workspace_dir}`);
      if (options.preflight) {
        console.log("  preflight checks - not yet implemented");
      }
    } catch (error) {
      if (error instanceof ConfigError) {
        console.error(`Configuration error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  });

program
  .command("run")
  .description("Execute one tick of the relais loop")
  .action(async () => {
    try {
      const config = await loadConfig(globalConfigPath);
      console.log(`relais run (${config.product_name}) - not yet implemented`);
    } catch (error) {
      if (error instanceof ConfigError) {
        console.error(`Configuration error: ${error.message}`);
        process.exit(1);
      }
      throw error;
    }
  });

program
  .command("doctor")
  .description("Diagnose relais configuration and environment")
  .action(async () => {
    console.log("relais doctor - checking configuration and environment\n");

    const issues: string[] = [];
    let config: RelaisConfig | null = null;

    // Check 1: Config file exists
    const configPath = globalConfigPath || await findConfigFile();
    if (configPath) {
      console.log(`[OK] Config file found: ${configPath}`);

      // Check 2: Config is valid JSON
      try {
        const rawConfig = await atomicReadJson<unknown>(configPath);
        console.log("[OK] Config file is valid JSON");

        // Check 3: Config structure is valid
        if (validateConfig(rawConfig)) {
          console.log("[OK] Config structure is valid");
          config = rawConfig;
        } else {
          console.log("[FAIL] Config structure is invalid");
          issues.push("Configuration file structure does not match expected schema");
        }
      } catch (error) {
        console.log("[FAIL] Config file is not valid JSON");
        issues.push(`Failed to parse config file: ${error instanceof Error ? error.message : String(error)}`);
      }
    } else {
      console.log(`[FAIL] Config file not found (expected ${CONFIG_FILE_NAME})`);
      issues.push(`Configuration file ${CONFIG_FILE_NAME} not found in current directory`);
    }

    // Check 4: Git availability (if require_git is true)
    const requireGit = config?.runner?.require_git ?? true;
    if (requireGit) {
      try {
        execSync("git --version", { stdio: "pipe" });
        console.log("[OK] Git is available");

        // Check if we're in a git repository
        try {
          execSync("git rev-parse --git-dir", { stdio: "pipe" });
          console.log("[OK] Current directory is a git repository");
        } catch {
          console.log("[WARN] Current directory is not a git repository");
          issues.push("Current directory is not a git repository (require_git is true)");
        }
      } catch {
        console.log("[FAIL] Git is not available");
        issues.push("Git is not installed or not in PATH (require_git is true)");
      }
    } else {
      console.log("[SKIP] Git check (require_git is false)");
    }

    // Check 5: Claude Code CLI availability
    if (config) {
      const cliCommand = config.claude_code_cli.command;
      try {
        execSync(`${cliCommand} --version`, { stdio: "pipe" });
        console.log(`[OK] Claude Code CLI (${cliCommand}) is available`);
      } catch {
        console.log(`[WARN] Claude Code CLI (${cliCommand}) is not available`);
        issues.push(`Claude Code CLI command '${cliCommand}' is not installed or not in PATH`);
      }
    }

    // Summary
    console.log("\n--- Summary ---");
    if (issues.length === 0) {
      console.log("All checks passed. Relais is ready to run.");
    } else {
      console.log(`Found ${issues.length} issue(s):\n`);
      for (const issue of issues) {
        console.log(`  - ${issue}`);
      }
      process.exit(1);
    }
  });

export async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
