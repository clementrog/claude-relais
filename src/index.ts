#!/usr/bin/env node

import { Command } from "commander";
import { execSync } from "node:child_process";
import { basename, join } from "node:path";
import { loadConfig, findConfigFile, validateConfig, ConfigError, CONFIG_FILE_NAME, chdirToRepoRoot } from "./lib/config.js";
import { checkCursorAgent } from "./lib/doctor.js";
import { atomicReadJson } from "./lib/fs.js";
import { readWorkspaceState } from "./lib/workspace_state.js";
import type { EnvoiConfig } from "./types/config.js";
import { CLI_NAME, LEGACY_CLI_NAME, PRODUCT_NAME } from "./lib/branding.js";
import { formatDisplayState } from "./lib/verdict_labels.js";

const program = new Command();

// Global config option
let globalConfigPath: string | undefined;

function isCodexHostRuntime(): boolean {
  return Boolean(
    process.env.CODEX_CI ||
    process.env.CODEX_THREAD_ID ||
    process.env.CODEX_SANDBOX ||
    process.env.CODEX_MANAGED_BY_NPM
  );
}

function assertClaudeOnlyOnboarding(command: 'install' | 'start' | 'brief'): void {
  if (!isCodexHostRuntime()) return;
  throw new Error(
    `The '${command}' onboarding flow is currently Claude Code-only. Run this command in Claude Code, then continue with Envoi from your preferred tools.`
  );
}

program
  .name(CLI_NAME)
  .description(`${PRODUCT_NAME} orchestration CLI`)
  .version("1.0.0")
  .option("-c, --config <path>", "Path to configuration file")
  .hook("preAction", (thisCommand) => {
    globalConfigPath = thisCommand.opts().config;
    const invokedBinary = basename(process.argv[1] ?? '');
    if (invokedBinary.includes(LEGACY_CLI_NAME)) {
      console.warn(`[DEPRECATED] Legacy CLI alias is kept for compatibility. Prefer '${CLI_NAME}'.`);
    }
  });

program
  .command("update")
  .description("Update envoi installation (auto-detect linked dev vs registry install)")
  .option("--mode <mode>", "Update strategy: auto|linked|registry")
  .option("--manager <manager>", "Package manager override: pnpm|npm|yarn|bun")
  .option("--dry-run", "Show strategy and commands without executing")
  .option("--yes", "Skip confirmation prompt")
  .action(async (options) => {
    try {
      const { updateCommand } = await import('./commands/update.js');
      await updateCommand({
        mode: options.mode,
        manager: options.manager,
        dryRun: options.dryRun,
        yes: options.yes,
      });
    } catch (error) {
      console.error(`Failed to update envoi: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

program
  .command("pr-note")
  .description("Print an Envoi attribution line for PR descriptions")
  .option("--format <format>", "Output format: markdown|text")
  .option("--url <url>", "Override project URL")
  .action(async (options) => {
    try {
      const { prNoteCommand } = await import('./commands/pr-note.js');
      await prNoteCommand({
        format: options.format,
        url: options.url,
      });
    } catch (error) {
      console.error(`Failed to render PR note: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

program
  .command("app")
  .description("Open Envoi desktop app or show quick benefits")
  .action(async () => {
    try {
      const { appCommand } = await import('./commands/app.js');
      await appCommand();
    } catch (error) {
      console.error(`Failed to open app bridge: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

program
  .command("install")
  .description("Scaffold + guided onboarding (optional global install)")
  .option("-f, --force", "Overwrite existing scaffold files")
  .option("--manager <manager>", "Package manager override for global install: pnpm|npm|yarn|bun")
  .option("--global-install", "Also install envoi globally after onboarding")
  .option("--skip-global-install", "[deprecated] No-op (global install is now opt-in via --global-install)")
  .option("--prd-file <path>", "Path to PRD markdown file (otherwise prompts or reads stdin)")
  .option("--mode <mode>", "Default loop mode: task|milestone|autonomous")
  .option("--builder <builder>", "Default builder: cursor")
  .option("--planner-provider <provider>", "Planner provider: claude_code|chatgpt")
  .option("--reviewer <reviewer>", "Reviewer mode: codex|none")
  .option("--orchestrator-model <model>", "Planner model override (legacy; ex: opus|gpt-5.3)")
  .option("--builder-model <model>", "Deprecated (cursor builder is enforced)")
  .option("--reviewer-model <model>", "Reviewer model (ex: gpt-5|o3|gpt-5-mini)")
  .option("--answers-json <json>", "Onboarding answers JSON (non-TTY resume)")
  .option("--answers-file <path>", "Path to onboarding answers JSON file")
  .option("--json", "Emit machine-readable onboarding payloads in non-TTY mode")
  .option("--verbose-onboarding", "Emit verbose onboarding logs in non-TTY mode")
  .option("--onboarding-output <mode>", "Non-TTY onboarding output: compact|json|verbose")
  .option("--strict-exit", "Return exit code 20 when onboarding input is still required")
  .option("--reconfigure", "Force onboarding questionnaire even if a completed session exists")
  .option("--no-auto-run", "Do not start execution after onboarding")
  .action(async (options) => {
    try {
      assertClaudeOnlyOnboarding('install');
      const { installCommand } = await import('./commands/install.js');
      await installCommand({
        configPath: globalConfigPath,
        force: options.force,
        manager: options.manager,
        globalInstall: options.globalInstall,
        skipGlobalInstall: options.skipGlobalInstall,
        prdFile: options.prdFile,
        mode: options.mode,
        builder: options.builder,
        plannerProvider: options.plannerProvider,
        reviewer: options.reviewer,
        orchestratorModel: options.orchestratorModel,
        builderModel: options.builderModel,
        reviewerModel: options.reviewerModel,
        answersJson: options.answersJson,
        answersFile: options.answersFile,
        json: options.json,
        verboseOnboarding: options.verboseOnboarding,
        onboardingOutput: options.onboardingOutput,
        strictExit: options.strictExit,
        reconfigure: options.reconfigure,
        autoRun: options.autoRun,
      });
    } catch (error) {
      console.error('Failed to install envoi: ' + (error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

program
  .command("start")
  .alias("init")
  .description("Scaffold + guided onboarding in one command")
  .option("-f, --force", "Overwrite existing scaffold files")
  .option("--setup-only", "Only scaffold files, skip guided onboarding")
  .option("--prd-file <path>", "Path to PRD markdown file (otherwise prompts or reads stdin)")
  .option("--mode <mode>", "Default loop mode: task|milestone|autonomous")
  .option("--builder <builder>", "Default builder: cursor")
  .option("--planner-provider <provider>", "Planner provider: claude_code|chatgpt")
  .option("--reviewer <reviewer>", "Reviewer mode: codex|none")
  .option("--orchestrator-model <model>", "Planner model override (legacy; ex: opus|gpt-5.3)")
  .option("--builder-model <model>", "Deprecated (cursor builder is enforced)")
  .option("--reviewer-model <model>", "Reviewer model (ex: gpt-5|o3|gpt-5-mini)")
  .option("--answers-json <json>", "Onboarding answers JSON (non-TTY resume)")
  .option("--answers-file <path>", "Path to onboarding answers JSON file")
  .option("--json", "Emit machine-readable onboarding payloads in non-TTY mode")
  .option("--verbose-onboarding", "Emit verbose onboarding logs in non-TTY mode")
  .option("--onboarding-output <mode>", "Non-TTY onboarding output: compact|json|verbose")
  .option("--strict-exit", "Return exit code 20 when onboarding input is still required")
  .option("--reconfigure", "Force onboarding questionnaire even if a completed session exists")
  .option("--no-auto-run", "Do not start execution after onboarding")
  .action(async (options) => {
    try {
      assertClaudeOnlyOnboarding('start');
      if (options.setupOnly) {
        const { initCommand } = await import('./commands/init.js');
        await initCommand({ force: options.force, showNextSteps: true });
        return;
      }

      const { onboardCommand } = await import('./commands/onboard.js');
      await onboardCommand({
        configPath: globalConfigPath,
        forceInit: options.force,
        prdFile: options.prdFile,
        mode: options.mode,
        builder: options.builder,
        plannerProvider: options.plannerProvider,
        reviewer: options.reviewer,
        orchestratorModel: options.orchestratorModel,
        builderModel: options.builderModel,
        reviewerModel: options.reviewerModel,
        answersJson: options.answersJson,
        answersFile: options.answersFile,
        json: options.json,
        verboseOnboarding: options.verboseOnboarding,
        onboardingOutput: options.onboardingOutput,
        strictExit: options.strictExit,
        reconfigure: options.reconfigure,
        showTourPrompt: true,
        autoRun: options.autoRun,
      });
    } catch (error) {
      console.error('Failed to start envoi: ' + (error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

program
  .command("brief")
  .alias("onboard")
  .description("Run guided onboarding and save defaults")
  .option("-f, --force-init", "Force re-run init (overwrite existing files)")
  .option("--prd-file <path>", "Path to PRD markdown file (otherwise prompts or reads stdin)")
  .option("--mode <mode>", "Default loop mode: task|milestone|autonomous")
  .option("--builder <builder>", "Default builder: cursor")
  .option("--planner-provider <provider>", "Planner provider: claude_code|chatgpt")
  .option("--reviewer <reviewer>", "Reviewer mode: codex|none")
  .option("--orchestrator-model <model>", "Planner model override (legacy; ex: opus|gpt-5.3)")
  .option("--builder-model <model>", "Deprecated (cursor builder is enforced)")
  .option("--reviewer-model <model>", "Reviewer model (ex: gpt-5|o3|gpt-5-mini)")
  .option("--answers-json <json>", "Onboarding answers JSON (non-TTY resume)")
  .option("--answers-file <path>", "Path to onboarding answers JSON file")
  .option("--json", "Emit machine-readable onboarding payloads in non-TTY mode")
  .option("--verbose-onboarding", "Emit verbose onboarding logs in non-TTY mode")
  .option("--onboarding-output <mode>", "Non-TTY onboarding output: compact|json|verbose")
  .option("--strict-exit", "Return exit code 20 when onboarding input is still required")
  .option("--reconfigure", "Force onboarding questionnaire even if a completed session exists")
  .option("--no-auto-run", "Do not start execution after onboarding")
  .action(async (options) => {
    try {
      assertClaudeOnlyOnboarding('brief');
      const { onboardCommand } = await import('./commands/onboard.js');
      await onboardCommand({
        configPath: globalConfigPath,
        forceInit: options.forceInit,
        prdFile: options.prdFile,
        mode: options.mode,
        builder: options.builder,
        plannerProvider: options.plannerProvider,
        reviewer: options.reviewer,
        orchestratorModel: options.orchestratorModel,
        builderModel: options.builderModel,
        reviewerModel: options.reviewerModel,
        answersJson: options.answersJson,
        answersFile: options.answersFile,
        json: options.json,
        verboseOnboarding: options.verboseOnboarding,
        onboardingOutput: options.onboardingOutput,
        strictExit: options.strictExit,
        reconfigure: options.reconfigure,
        showTourPrompt: false,
        autoRun: options.autoRun,
      });
    } catch (error) {
      console.error('Failed to capture brief: ' + (error instanceof Error ? error.message : String(error)));
      process.exit(1);
    }
  });

program
  .command("mode")
  .description("Set or prompt for default loop mode (task|milestone|autonomous)")
  .option("--set <mode>", "Set mode without prompting")
  .option("--json", "Output in JSON format")
  .action(async (options) => {
    try {
      await chdirToRepoRoot(globalConfigPath);
      const { modeCommand } = await import('./commands/mode.js');
      await modeCommand({ configPath: globalConfigPath, set: options.set, json: options.json });
    } catch (error) {
      console.error(`Failed to set mode: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

program
  .command("builder")
  .description("Set or configure cursor builder")
  .option("--set <builder>", "Set builder without prompting")
  .option("--json", "Output in JSON format")
  .action(async (options) => {
    try {
      await chdirToRepoRoot(globalConfigPath);
      const { builderCommand } = await import('./commands/builder.js');
      await builderCommand({ configPath: globalConfigPath, set: options.set, json: options.json });
    } catch (error) {
      console.error(`Failed to set builder: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

program
  .command("autonomy")
  .description("Set autonomy profile for approval friction (strict|balanced|fast)")
  .option("--set <profile>", "Set profile without prompting")
  .option("--trust-add <prefix...>", "Add trusted command prefix entries")
  .option("--trust-remove <prefix...>", "Remove trusted command prefix entries")
  .option("--trust-list", "List trusted command prefix entries")
  .option("--json", "Output in JSON format")
  .action(async (options) => {
    try {
      await chdirToRepoRoot(globalConfigPath);
      const { autonomyCommand } = await import('./commands/autonomy.js');
      await autonomyCommand({
        configPath: globalConfigPath,
        set: options.set,
        trustAdd: options.trustAdd,
        trustRemove: options.trustRemove,
        trustList: options.trustList,
        json: options.json,
      });
    } catch (error) {
      console.error(`Failed to set autonomy profile: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

program
  .command("idea")
  .description("Capture a new product idea for orchestrator planning")
  .argument("[text...]", "Idea text (optional; prompts when omitted)")
  .option("--target-by <date>", "Optional target date or milestone hint")
  .option("--testability <need>", "Delivery urgency: soon|later|unknown")
  .option("--source <source>", "Source tag: interactive|cli|api")
  .option("--json", "Output in JSON format")
  .action(async (text: string[] | undefined, options) => {
    try {
      await chdirToRepoRoot(globalConfigPath);
      const config = await loadConfig(globalConfigPath);
      const { ideaCommand } = await import('./commands/idea.js');
      await ideaCommand(
        {
          text: Array.isArray(text) ? text.join(' ').trim() : '',
          targetBy: options.targetBy,
          testability: options.testability,
          source: options.source,
          json: options.json,
        },
        config.workspace_dir
      );
    } catch (error) {
      console.error(`Failed to capture idea: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

program
  .command("answer")
  .description("Answer onboarding prompts or resolve open orchestrator product questions")
  .argument("[text...]", "Answer text (optional; prompts when omitted in TTY)")
  .option("--session <id>", "Onboarding compatibility mode: session id")
  .option("--id <question_id>", "Onboarding compatibility mode: question id (ex: mode)")
  .option("--value <value>", "Onboarding compatibility mode: answer value")
  .option("--question-id <id>", "Resolve a specific open question ID (defaults to latest open question)")
  .option("--source <source>", "Source tag: interactive|cli|api")
  .option("--json", "Output in JSON format")
  .action(async (text: string[] | undefined, options) => {
    try {
      await chdirToRepoRoot(globalConfigPath);
      const config = await loadConfig(globalConfigPath);
      const { answerCommand } = await import('./commands/answer.js');
      await answerCommand(
        {
          text: Array.isArray(text) ? text.join(' ').trim() : '',
          sessionId: options.session,
          id: options.id,
          value: options.value,
          questionId: options.questionId,
          source: options.source,
          json: options.json,
        },
        config.workspace_dir
      );
    } catch (error) {
      console.error(`Failed to record answer: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

program
  .command("status")
  .description("Show current envoi state")
  .option("--preflight", "Run preflight checks")
  .option("--json", "Output in JSON format")
  .action(async (options) => {
    try {
      await chdirToRepoRoot(globalConfigPath);
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
      
      console.log(`${CLI_NAME} status (${config.product_name} v${config.version})`);
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
  .command("undo")
  .description("Rollback to last safe snapshot")
  .option("--yes", "Skip confirmation prompt")
  .action(async (options) => {
    try {
      await chdirToRepoRoot(globalConfigPath);
      const config = await loadConfig(globalConfigPath);
      const { undoCommand } = await import('./commands/undo.js');
      await undoCommand({
        workspaceDir: config.workspace_dir,
        yes: options.yes,
      });
    } catch (error) {
      console.error(`Failed to undo: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  });

program
  .command("tick")
  .alias("run")
  .description("Execute one bounded cycle (plan -> edit -> verify -> stop)")
  .option("--dry-run", "Show what would happen without executing")
  .option("--continue", "Resume from BLOCKED state if possible")
  .action(async (options) => {
    try {
      await chdirToRepoRoot(globalConfigPath);
      const config = await loadConfig(globalConfigPath);
      const { refreshLinkedInstallIfStale } = await import('./lib/self_update.js');
      const refresh = refreshLinkedInstallIfStale();
      if (refresh.error) {
        console.warn(`Linked install refresh failed: ${refresh.error}`);
      } else if (refresh.refreshed) {
        console.log(
          `Linked install refreshed from ${refresh.linkedRoot} using ${refresh.manager}.`
        );
      }

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
      console.log(`State: ${formatDisplayState(report.verdict, report.code)}`);
      console.log(`Duration: ${report.duration_ms}ms`);
      console.log(`Next: ${CLI_NAME} tick   (one more bounded cycle)`);
      console.log(`Or:   ${CLI_NAME} loop   (multi-tick; uses default or --mode)`);
      console.log(`Tips: ${CLI_NAME} mode  /  ${CLI_NAME} builder`);
      if (report.verdict !== 'success') {
        console.log('Waiting for you: accept, adjust, or undo.');
      }

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
  .description("Run envoi loop (multiple ticks)")
  .option("--mode <mode>", "Loop mode: task, milestone, or autonomous (defaults to runner.default_loop_mode)")
  .option("--max-ticks <n>", "Maximum number of ticks to run", (v: string) => parseInt(v, 10))
  .action(async (options) => {
    try {
      await chdirToRepoRoot(globalConfigPath);
      const config = await loadConfig(globalConfigPath);
      const { refreshLinkedInstallIfStale } = await import('./lib/self_update.js');
      const refresh = refreshLinkedInstallIfStale();
      if (refresh.error) {
        console.warn(`Linked install refresh failed: ${refresh.error}`);
      } else if (refresh.refreshed) {
        console.log(
          `Linked install refreshed from ${refresh.linkedRoot} using ${refresh.manager}.`
        );
      }
      const mode = options.mode ?? config.runner.default_loop_mode;
      if (!mode) {
        console.error(`No loop mode provided. Set a default via '${CLI_NAME} mode' or pass --mode task|milestone|autonomous.`);
        process.exit(1);
      }
      if (mode !== "task" && mode !== "milestone" && mode !== "autonomous") {
        console.error(`Invalid mode: ${mode}. Must be 'task', 'milestone', or 'autonomous'.`);
        process.exit(1);
      }
      const { runLoop } = await import("./runner/loop.js");
      const result = await runLoop(config, {
        mode: mode as "task" | "milestone" | "autonomous",
        max_ticks: options.maxTicks,
      });
      console.log("\n--- Loop Complete ---");
      console.log(`Ticks executed: ${result.ticks_executed}`);
      const lastReport = result.reports[result.reports.length - 1];
      if (lastReport) {
        console.log(`Final state: ${formatDisplayState(lastReport.verdict, lastReport.code)}`);
      } else {
        console.log(`Final verdict: ${result.final_verdict}`);
      }
      console.log(`Stop reason: ${result.stop_reason}`);
      if (result.stop_reason === 'orchestrator_stop' && result.orchestrator_stop_reason) {
        console.log(`Completion: ${result.orchestrator_stop_reason}`);
      }
      if (result.stop_reason === 'self_update') {
        console.log(`Linked install was refreshed during loop. Re-run '${CLI_NAME} loop' to continue with the latest code.`);
      }
      if (mode === 'task') {
        console.log(`Follow-up path (task): STANDBY at task boundary. Your call: continue with '${CLI_NAME} tick' when ready.`);
      } else if (mode === 'milestone') {
        console.log(`Follow-up path (milestone): STANDBY at milestone boundary. Your call: continue with '${CLI_NAME} loop --mode milestone'.`);
      } else {
        console.log(`Follow-up path (autonomous): continues automatically until BLOCKED, LIMIT_HIT, max ticks, or signal.`);
      }

      const boundaryStop =
        result.stop_reason === 'orchestrator_stop' || result.stop_reason === 'milestone_change';
      if (boundaryStop && process.stdin.isTTY) {
        const { ideaCommand } = await import('./commands/idea.js');
        await ideaCommand({ source: 'interactive' }, config.workspace_dir);
      }

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
  .command("check")
  .alias("doctor")
  .description("Check environment + constraints health")
  .action(async () => {
    console.log(`${CLI_NAME} check - checking configuration and environment\n`);

    const issues: string[] = [];
    let config: EnvoiConfig | null = null;

    // Change to repo root before checking config
    try {
      await chdirToRepoRoot(globalConfigPath);
    } catch (error) {
      // If we can't find config, continue with checks below
    }

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

    // Check 5b: Cursor Agent availability (only if cursor builder is configured or selected)
    if (config && (config.builder.default_mode === "cursor" || !!config.builder.cursor)) {
      const cursorModeSelected = config.builder.default_mode === "cursor";
      const needsCursorAgent = config.builder.cursor?.driver_kind !== "external";

      try {
        const result = await checkCursorAgent(config);
        const versionSuffix = result.version ? ` (${result.version})` : "";

        if (!result.cli_available) {
          const msg = `Cursor CLI '${result.command}' not available in PATH`;
          console.log(`[${cursorModeSelected ? "FAIL" : "WARN"}] ${msg}`);
          if (result.details) console.log(`       ${result.details.split("\n")[0]}`);
          if (cursorModeSelected) {
            issues.push(`${msg}. Install Cursor and ensure '${result.command}' is executable, or set builder.cursor.command.`);
          } else {
            issues.push(`${msg} (cursor builder configured but not selected).`);
          }
        } else if (!result.agent_available) {
          const msg = `Cursor CLI is available${versionSuffix} but 'agent' subcommand is not`;
          console.log(`[${cursorModeSelected ? "FAIL" : "WARN"}] ${msg}`);
          if (result.details) console.log(`       ${result.details.split("\n")[0]}`);
          issues.push(`${msg}. Update Cursor to a version that supports 'cursor agent'.`);
        } else {
          console.log(`[OK] Cursor agent is available${versionSuffix}`);
          if (needsCursorAgent) {
            if (result.auth_status === "authenticated") {
              console.log("[OK] Cursor agent auth: authenticated");
            } else if (result.auth_status === "api_key_present") {
              console.log("[OK] Cursor agent auth: CURSOR_API_KEY is set");
            } else if (result.auth_status === "unauthenticated") {
              console.log("[WARN] Cursor agent auth: not authenticated");
              if (result.details) console.log(`       ${result.details.split("\n")[0]}`);
              issues.push(
                "Cursor agent is not authenticated. Run 'cursor agent login' (OAuth) or set CURSOR_API_KEY in your environment."
              );
            } else {
              console.log("[WARN] Cursor agent auth: unknown");
              issues.push("Cursor agent authentication status is unknown; run 'cursor agent whoami' to verify.");
            }
          } else {
            console.log("[SKIP] Cursor auth check (driver_kind is external)");
          }
        }
      } catch (error) {
        console.log("[WARN] Cursor agent check failed");
        issues.push(`Cursor agent check failed: ${error instanceof Error ? error.message : String(error)}`);
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
      console.log(`All checks passed. ${PRODUCT_NAME} is ready.`);
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
