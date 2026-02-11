import { access, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { atomicWriteJson } from './fs.js';
import type { EnvoiConfig } from '../types/config.js';
import {
  CONFIG_FILE_NAME,
  LEGACY_WORKSPACE_DIR_NAME,
  PRODUCT_NAME,
  WORKSPACE_DIR_NAME,
  isLegacyConfigPath,
} from './branding.js';

interface MigrationResult {
  config: EnvoiConfig;
  configPath: string;
  migrated: boolean;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function rewriteString(value: string, oldWorkspace: string, newWorkspace: string): string {
  if (value === oldWorkspace) return newWorkspace;
  if (value.startsWith(`${oldWorkspace}/`)) {
    return `${newWorkspace}/${value.slice(oldWorkspace.length + 1)}`;
  }
  if (value.startsWith('relais/')) {
    return `envoi/${value.slice('relais/'.length)}`;
  }
  return value.replace(/\brelais\//g, 'envoi/');
}

function rewriteValue(value: unknown, oldWorkspace: string, newWorkspace: string): unknown {
  if (typeof value === 'string') {
    return rewriteString(value, oldWorkspace, newWorkspace);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => rewriteValue(entry, oldWorkspace, newWorkspace));
  }
  if (value && typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      output[key] = rewriteValue(entry, oldWorkspace, newWorkspace);
    }
    return output;
  }
  return value;
}

function buildMigratedConfig(config: EnvoiConfig): EnvoiConfig {
  const oldWorkspace = config.workspace_dir || LEGACY_WORKSPACE_DIR_NAME;
  const newWorkspace = oldWorkspace === LEGACY_WORKSPACE_DIR_NAME ? WORKSPACE_DIR_NAME : oldWorkspace;
  const rewritten = rewriteValue(config, oldWorkspace, newWorkspace) as EnvoiConfig;
  return {
    ...rewritten,
    product_name: PRODUCT_NAME.toLowerCase(),
    workspace_dir: newWorkspace,
  };
}

export async function migrateLegacyLayoutIfNeeded(
  configPath: string,
  config: EnvoiConfig
): Promise<MigrationResult> {
  if (!isLegacyConfigPath(configPath)) {
    return { config, configPath, migrated: false };
  }

  const repoRoot = dirname(configPath);
  const targetConfigPath = join(repoRoot, CONFIG_FILE_NAME);
  const migratedConfig = buildMigratedConfig(config);

  if (config.workspace_dir === LEGACY_WORKSPACE_DIR_NAME) {
    const legacyWorkspacePath = join(repoRoot, LEGACY_WORKSPACE_DIR_NAME);
    const newWorkspacePath = join(repoRoot, WORKSPACE_DIR_NAME);
    if ((await exists(legacyWorkspacePath)) && !(await exists(newWorkspacePath))) {
      await rename(legacyWorkspacePath, newWorkspacePath);
    }
  }

  if (!(await exists(targetConfigPath))) {
    await atomicWriteJson(targetConfigPath, migratedConfig);
  }

  return {
    config: migratedConfig,
    configPath: targetConfigPath,
    migrated: true,
  };
}
