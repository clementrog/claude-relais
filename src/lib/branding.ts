import { basename } from 'node:path';

export const PRODUCT_NAME = 'Envoi';
export const LEGACY_PRODUCT_NAME = 'Relais';

export const CLI_NAME = 'envoi';
export const LEGACY_CLI_NAME = 'relais';
export const PACKAGE_NAME = '@ttfw/envoi';

export const CONFIG_FILE_NAME = 'envoi.config.json';
export const LEGACY_CONFIG_FILE_NAME = 'relais.config.json';
export const CONFIG_FILE_CANDIDATES = [CONFIG_FILE_NAME, LEGACY_CONFIG_FILE_NAME] as const;

export const WORKSPACE_DIR_NAME = 'envoi';
export const LEGACY_WORKSPACE_DIR_NAME = 'relais';

const PACKAGE_NAME_CANDIDATES = [PACKAGE_NAME, 'envoi', 'relais'] as const;

export function isLegacyConfigPath(path: string): boolean {
  return basename(path) === LEGACY_CONFIG_FILE_NAME;
}

export function isKnownPackageName(name: string | undefined): boolean {
  return typeof name === 'string' && PACKAGE_NAME_CANDIDATES.includes(name as (typeof PACKAGE_NAME_CANDIDATES)[number]);
}
