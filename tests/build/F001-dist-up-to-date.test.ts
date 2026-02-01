import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import { readdirSync, statSync, existsSync } from 'node:fs';

function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, ent.name);
    if (ent.isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

describe('F001: dist is up-to-date with src', () => {
  it('should not have src files newer than dist files', () => {
    // Catches stale builds when using pnpm link:/workspace installs.
    const repoRoot = process.cwd();
    const srcDir = join(repoRoot, 'src');
    const distDir = join(repoRoot, 'dist');

    const srcFiles = walk(srcDir).filter((f) => f.endsWith('.ts'));
    const distFiles = walk(distDir).filter((f) => f.endsWith('.js'));

    // If either directory is missing, the package layout is unexpected; fail loudly.
    expect(srcFiles.length).toBeGreaterThan(0);
    expect(distFiles.length).toBeGreaterThan(0);

    const srcMax = Math.max(...srcFiles.map((f) => statSync(f).mtimeMs));
    const distMax = Math.max(...distFiles.map((f) => statSync(f).mtimeMs));

    expect(srcMax).toBeLessThanOrEqual(distMax);
  });
});
