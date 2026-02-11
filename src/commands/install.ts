import { spawn } from 'node:child_process';

import { CLI_NAME, PACKAGE_NAME } from '../lib/branding.js';
import { buildUpdatePlan } from './update.js';
import { onboardCommand } from './onboard.js';

interface InstallOptions {
  configPath?: string;
  force?: boolean;
  manager?: string;
  prdFile?: string;
  mode?: string;
  builder?: string;
  plannerProvider?: string;
  reviewer?: string;
  orchestratorModel?: string;
  builderModel?: string;
  reviewerModel?: string;
  answersJson?: string;
  answersFile?: string;
  json?: boolean;
  verboseOnboarding?: boolean;
  onboardingOutput?: string;
  strictExit?: boolean;
  reconfigure?: boolean;
  autoRun?: boolean;
  globalInstall?: boolean;
  skipGlobalInstall?: boolean;
}

const GLOBAL_INSTALL_STALL_WARNING_MS = 20_000;

function renderCommand(cmd: string, args: string[]): string {
  return [cmd, ...args].join(' ');
}

async function runCommandOrThrow(cmd: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const rendered = renderCommand(cmd, args);
    const child = spawn(cmd, args, { stdio: 'inherit' });
    const warningTimer = setTimeout(() => {
      console.warn(`[WARN] Still working (20s): ${rendered}`);
    }, GLOBAL_INSTALL_STALL_WARNING_MS);
    const clearTimer = () => clearTimeout(warningTimer);

    child.once('error', (error) => {
      clearTimer();
      reject(new Error(`Command failed to start: ${rendered} (${error.message})`));
    });

    child.once('close', (code, signal) => {
      clearTimer();
      if (code === 0) {
        resolve();
        return;
      }
      if (typeof code === 'number') {
        reject(new Error(`Command failed (${code}): ${rendered}`));
        return;
      }
      reject(new Error(`Command terminated by signal ${signal ?? 'unknown'}: ${rendered}`));
    });
  });
}

export async function installCommand(options: InstallOptions): Promise<void> {
  if (options.globalInstall && options.skipGlobalInstall) {
    throw new Error("Conflicting options: use either '--global-install' or '--skip-global-install'.");
  }
  if (options.skipGlobalInstall) {
    console.warn("[DEPRECATED] '--skip-global-install' is no longer needed; global install is now opt-in via '--global-install'.");
  }

  const shouldRunGlobalInstall = Boolean(options.globalInstall) && !options.skipGlobalInstall;
  let globalInstallSucceeded = false;

  console.log('Phase 1/3: scaffold workspace');

  console.log('Phase 2/3: guided onboarding');
  const onboarding = await onboardCommand({
    configPath: options.configPath,
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

  if (onboarding?.needsInput) {
    return;
  }

  if (shouldRunGlobalInstall) {
    console.log('Phase 3/3: global install');
    try {
      const plan = await buildUpdatePlan({
        mode: 'registry',
        manager: options.manager,
      });
      for (const command of plan.commands) {
        await runCommandOrThrow(command.cmd, command.args);
      }
      globalInstallSucceeded = true;
      console.log(`Global install complete (${PACKAGE_NAME}).`);
    } catch (error) {
      console.warn(
        `[WARN] Global install failed: ${error instanceof Error ? error.message : String(error)}`
      );
      console.warn(
        `Onboarding completed. You can retry global install later with '${CLI_NAME} update --mode registry --yes'.`
      );
    }
  } else {
    console.log(`Phase 3/3: optional global install (skipped; run '${CLI_NAME} install --global-install' when ready)`);
  }

  if (globalInstallSucceeded) {
    console.log(`\nReady. Use '${CLI_NAME} start' or '${CLI_NAME} --help' from now on.`);
  } else {
    console.log(`\nOnboarding is complete. Continue with 'npx -y ${PACKAGE_NAME}@latest ...' or install globally later.`);
  }
}
