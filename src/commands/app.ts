import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const APP_URL = 'https://envoi.app';

function openDesktopApp(): boolean {
  if (process.platform === 'darwin') {
    const hasBundle = existsSync('/Applications/Envoi.app') || existsSync(`${process.env.HOME ?? ''}/Applications/Envoi.app`);
    if (!hasBundle) return false;
    const result = spawnSync('open', ['-a', 'Envoi'], { stdio: 'inherit' });
    return result.status === 0;
  }
  if (process.platform === 'win32') {
    const result = spawnSync('cmd', ['/c', 'start', '', 'envoi:'], { stdio: 'ignore' });
    return result.status === 0;
  }
  const result = spawnSync('xdg-open', ['envoi://'], { stdio: 'ignore' });
  return result.status === 0;
}

export async function appCommand(): Promise<void> {
  if (openDesktopApp()) {
    console.log('Opened Envoi desktop app.');
    return;
  }

  console.log('Envoi desktop app is not installed or not registered on this machine.');
  console.log('Why use it:');
  console.log('- Native timeline for ticks, checkpoints, and rollbacks.');
  console.log('- Faster approvals with a dedicated human-in-the-loop surface.');
  console.log('- Shared team visibility across planner, builder, and checker outcomes.');
  console.log(`Learn more: ${APP_URL}`);
}
