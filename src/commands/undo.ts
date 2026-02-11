import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { join } from 'node:path';
import { access } from 'node:fs/promises';
import { atomicReadJson } from '../lib/fs.js';
import { rollbackToCommit } from '../lib/rollback.js';
import { CLI_NAME } from '../lib/branding.js';

interface UndoOptions {
  workspaceDir: string;
  yes?: boolean;
}

interface ReportLike {
  base_commit?: string;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

async function confirmUndo(baseCommit: string): Promise<boolean> {
  if (!input.isTTY) return false;
  const rl = readline.createInterface({ input, output });
  try {
    const answer = (await rl.question(`Rollback tracked files to ${baseCommit}? [y/N]: `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

export async function undoCommand(options: UndoOptions): Promise<void> {
  const reportPath = join(options.workspaceDir, 'REPORT.json');
  if (!(await fileExists(reportPath))) {
    throw new Error(`No REPORT.json found at ${reportPath}. Run '${CLI_NAME} tick' first.`);
  }

  const report = await atomicReadJson<ReportLike>(reportPath);
  const baseCommit = report.base_commit;
  if (!baseCommit || typeof baseCommit !== 'string') {
    throw new Error(`REPORT.json is missing a valid base_commit: ${reportPath}`);
  }

  if (!options.yes) {
    if (!input.isTTY) {
      throw new Error(`Non-interactive mode requires --yes for '${CLI_NAME} undo'.`);
    }
    const proceed = await confirmUndo(baseCommit);
    if (!proceed) {
      console.log('Undo canceled. Waiting for you.');
      return;
    }
  }

  const rollback = rollbackToCommit(baseCommit);
  if (!rollback.ok) {
    throw new Error(rollback.error ?? `Rollback failed for commit ${baseCommit}.`);
  }

  console.log(`ROLLED_BACK: restored tracked files to ${rollback.restoredCommit}`);
  if (rollback.removedFiles.length > 0) {
    console.log(`Removed untracked paths: ${rollback.removedFiles.join(', ')}`);
  }
  console.log(`Next: ${CLI_NAME} status --preflight`);
}
