#!/usr/bin/env node

import { Command } from "commander";
import { execSync } from "node:child_process";
import { join } from "node:path";
import { loadConfig, findConfigFile, validateConfig, ConfigError, CONFIG_FILE_NAME } from "./lib/config.js";
import { atomicReadJson } from "./lib/fs.js";
import { readWorkspaceState } from "./lib/workspace_state.js";
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
  .option("-f, --force", "Overwrite existing files")
  .action(async (options) => {
    try {
      const { initCommand } = await import('./commands/init.js');
      await initCommand({ force: options.force });
    } catch (error) {
      console.error(`Failed to initialize workspace: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Show current relais state")
  .option("--preflight", "Run preflight checks")
  .option("--json", "Output in JSON format")
  .action(async (options) => {
    try {
      const config = await loadConfig(globalConfigPath);
      
      if (options.json) {
        const output: any = {
          product_name: config.product_name,
          version: config.version,
          workspace_dir: config.workspace_dir,
        };
        if (options.preflight) {
          const { runPreflight } = await import('./lib/preflight.js');
          output.preflight = await runPreflight(config);
        }
        console.log(JSON.stringify(output, null, 2));
        return;
      }
      
      console.log(`relais status (${config.product_name} v${config.version})`);
      console.log(`  workspace: ${config.workspace_dir}`);
      if (options.preflight) {
        const { runPreflight } = await import('./lib/preflight.js');
        const result = await runPreflight(config);
        console.log('\nPreflight checks:');
        console.log(`  Status: ${result.ok ? 'PASS' : 'FAIL'}`);
        if (!result.ok) {
          console.log(`  Blocked: ${result.blocked_code}`);
          console.log(`  Reason: ${result.blocked_reason}`);
        }
        if (result.warnings.length > 0) {
          console.log('  Warnings:');
          for (const w of result.warnings) {
            console.log(`    - ${w}`);
          }
        }
        if (result.base_commit) {
          console.log(`  Base commit: ${result.base_commit}`);
        }
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
  .option("--dry-run", "Show what would happen without executing")
  .option("--continue", "Resume from BLOCKED state if possible")
  .action(async (options) => {
    try {
      const config = await loadConfig(globalConfigPath);

      // Handle --dry-run flag
      if (options.dryRun) {
        const { runPreflight } = await import('./lib/preflight.js');
        const result = await runPreflight(config);
        console.log('Dry run - preflight results:');
        console.log(`  ok: ${result.ok}`);
        if (!result.ok) {
          console.log(`  blocked: ${result.blocked_code}`);
          console.log(`  reason: ${result.blocked_reason}`);
        }
        if (result.warnings.length > 0) {
          console.log('  warnings:', result.warnings);
        }
        return;
      }

      // Handle --continue flag
      if (options.continue) {
        const statePath = join(config.workspace_dir, 'STATE.json');
        try {
          const state = await atomicReadJson(statePath);
          console.log('Continue mode - checking state...');
          // For now just print state info
          console.log(`  Current state: ${JSON.stringify(state, null, 2)}`);
        } catch {
          console.log('No previous state found. Running fresh tick.');
        }
      }

      // Set up interrupt handling
      const abortController = new AbortController();
      let sigintCount = 0;

      const signalHandler = (signal: string) => {
        sigintCount++;
        if (sigintCount === 1) {
          console.log(`\n${signal} received, aborting current operation...`);
          abortController.abort();
        } else {
          console.log(`\nForce exit`);
          process.exit(130);
        }
      };

      const sigintHandler = () => signalHandler('SIGINT');
      const sigtermHandler = () => signalHandler('SIGTERM');

      process.on('SIGINT', sigintHandler);
      process.on('SIGTERM', sigtermHandler);

      const { runTick } = await import('./runner/tick.js');
      const report = await runTick(config, abortController.signal);

      // Cleanup signal handlers
      process.off('SIGINT', sigintHandler);
      process.off('SIGTERM', sigtermHandler);

      // Print summary
      console.log(`\n--- Tick Complete ---`);
      console.log(`Run ID: ${report.run_id}`);
      console.log(`Verdict: ${report.verdict}`);
      console.log(`Code: ${report.code}`);
      console.log(`Duration: ${report.duration_ms}ms`);

      // Set exit code for interrupt case
      if (report.code === 'STOP_INTERRUPTED') {
        process.exitCode = 130;
      } else if (report.verdict === 'blocked' || report.verdict === 'stop') {
        process.exit(1);
      }
    } catch (error) {
      if (error instanceof ConfigError) {
        console.error(`Configuration error: ${error.message}`);
        process.exit(1);
      }
      console.error(`Fatal error during tick execution:`, error);
      process.exit(1);
    }
  });

program
  .command("loop")
  .description("Run relais loop (multiple ticks)")
  .requiredOption("--mode <mode>", "Loop mode: milestone or autonomous")
  .option("--max-ticks <n>", "Maximum number of ticks to run", (v: string) => parseInt(v, 10))
  .action(async (options) => {
    try {
      if (options.mode !== "milestone" && options.mode !== "autonomous") {
        console.error(`Invalid mode: ${options.mode}. Must be 'milestone' or 'autonomous'.`);
        process.exit(1);
      }
      const config = await loadConfig(globalConfigPath);
      const { runLoop } = await import("./runner/loop.js");
      const result = await runLoop(config, {
        mode: options.mode as "milestone" | "autonomous",
        max_ticks: options.maxTicks,
      });
      console.log("\n--- Loop Complete ---");
      console.log(`Ticks executed: ${result.ticks_executed}`);
      console.log(`Final verdict: ${result.final_verdict}`);
      console.log(`Stop reason: ${result.stop_reason}`);
      if (result.stop_reason === "blocked" || result.stop_reason === "verdict") {
        process.exit(1);
      }
    } catch (error) {
      if (error instanceof ConfigError) {
        console.error(`Configuration error: ${error.message}`);
        process.exit(1);
      }
      console.error("Fatal error during loop execution:", error);
      process.exit(1);
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

    // Check 6: Workspace directory exists
    if (config) {
      const { existsSync } = await import('node:fs');
      const workspaceDir = config.workspace_dir;
      
      if (existsSync(workspaceDir)) {
        console.log(`[OK] Workspace directory exists: ${workspaceDir}`);
        
        // Check prompts directory
        const promptsDir = join(workspaceDir, 'prompts');
        if (existsSync(promptsDir)) {
          console.log('[OK] Prompts directory exists');
        } else {
          console.log('[WARN] Prompts directory missing');
          issues.push(`Prompts directory not found: ${promptsDir}`);
        }
        
        // Check schemas directory
        const schemasDir = join(workspaceDir, 'schemas');
        if (existsSync(schemasDir)) {
          console.log('[OK] Schemas directory exists');
        } else {
          console.log('[WARN] Schemas directory missing');
          issues.push(`Schemas directory not found: ${schemasDir}`);
        }
        
        // Check STATE.json
        const statePath = join(workspaceDir, 'STATE.json');
        if (existsSync(statePath)) {
          try {
            await atomicReadJson(statePath);
            console.log('[OK] STATE.json exists and is valid JSON');
          } catch {
            console.log('[WARN] STATE.json exists but is not valid JSON');
            issues.push('STATE.json is not valid JSON');
          }
          // Show budget ledger summary
          try {
            const wsState = await readWorkspaceState(config.workspace_dir);
            const caps = config.budgets.per_milestone;
            console.log('\n[INFO] Budget ledger:');
            console.log(`  Milestone: ${wsState.milestone_id ?? '(none)'}`);
            console.log(`  Ticks: ${wsState.budgets.ticks} / ${caps.max_ticks}`);
            console.log(`  Orchestrator calls: ${wsState.budgets.orchestrator_calls} / ${caps.max_orchestrator_calls}`);
            console.log(`  Builder calls: ${wsState.budgets.builder_calls} / ${caps.max_builder_calls}`);
            console.log(`  Verify runs: ${wsState.budgets.verify_runs} / ${caps.max_verify_runs}`);
            if (wsState.budget_warning) {
              console.log('  [WARN] Budget warning active - approaching limit');
            }
          } catch {
            console.log('[WARN] Could not read budget ledger');
          }
        } else {
          console.log('[INFO] STATE.json not found (will be created on first run)');
        }
      } else {
        console.log(`[FAIL] Workspace directory not found: ${workspaceDir}`);
        issues.push(`Workspace directory not found: ${workspaceDir}`);
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
