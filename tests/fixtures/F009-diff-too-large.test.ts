/**
 * F009: diff_too_large
 * 
 * Verify that exceeding max_lines_changed results in STOP_DIFF_TOO_LARGE.
 */

import { describe, it, expect } from 'vitest';
import { checkDiffLimits, type DiffAnalysis } from '@/lib/diff.js';

describe('F009: diff_too_large', () => {
  it('should detect STOP_DIFF_TOO_LARGE when max_lines_changed exceeded', () => {
    const analysis: DiffAnalysis = {
      files_touched: 1,
      lines_added: 150,
      lines_deleted: 60,
      new_files: 0,
      touched_paths: ['src/file.ts'],
    };

    const limits = {
      max_files_touched: 10,
      max_lines_changed: 20, // Limit is 20, but 210 lines changed
    };

    const result = checkDiffLimits(analysis, limits);

    expect(result.ok).toBe(false);
    expect(result.lines_changed).toBe(210); // 150 + 60
    expect(result.max_lines).toBe(20);
    expect(result.violation).toContain('Lines changed (210) exceeds limit (20)');
  });

  it('should detect violation when max_files_touched exceeded', () => {
    const analysis: DiffAnalysis = {
      files_touched: 25,
      lines_added: 10,
      lines_deleted: 5,
      new_files: 0,
      touched_paths: Array.from({ length: 25 }, (_, i) => `src/file${i}.ts`),
    };

    const limits = {
      max_files_touched: 20,
      max_lines_changed: 100,
    };

    const result = checkDiffLimits(analysis, limits);

    expect(result.ok).toBe(false);
    expect(result.files_touched).toBe(25);
    expect(result.max_files).toBe(20);
    expect(result.violation).toContain('Files touched (25) exceeds limit (20)');
  });

  it('should detect violation when both limits exceeded', () => {
    const analysis: DiffAnalysis = {
      files_touched: 25,
      lines_added: 150,
      lines_deleted: 60,
      new_files: 0,
      touched_paths: Array.from({ length: 25 }, (_, i) => `src/file${i}.ts`),
    };

    const limits = {
      max_files_touched: 20,
      max_lines_changed: 100,
    };

    const result = checkDiffLimits(analysis, limits);

    expect(result.ok).toBe(false);
    // When both limits are exceeded, the violation message includes both
    expect(result.violation).toBeTruthy();
    expect(result.violation).toContain('Files touched (25)');
    expect(result.violation).toContain('exceeds limit (20)');
    expect(result.violation).toContain('lines changed (210)'); // lowercase "lines"
    expect(result.violation).toContain('exceeds limit (100)');
  });

  it('should pass when within limits', () => {
    const analysis: DiffAnalysis = {
      files_touched: 5,
      lines_added: 50,
      lines_deleted: 30,
      new_files: 0,
      touched_paths: ['src/file1.ts', 'src/file2.ts', 'src/file3.ts', 'src/file4.ts', 'src/file5.ts'],
    };

    const limits = {
      max_files_touched: 10,
      max_lines_changed: 100,
    };

    const result = checkDiffLimits(analysis, limits);

    expect(result.ok).toBe(true);
    expect(result.violation).toBeNull();
    expect(result.files_touched).toBe(5);
    expect(result.lines_changed).toBe(80); // 50 + 30
  });

  it('should pass when exactly at limits', () => {
    const analysis: DiffAnalysis = {
      files_touched: 20,
      lines_added: 50,
      lines_deleted: 50,
      new_files: 0,
      touched_paths: Array.from({ length: 20 }, (_, i) => `src/file${i}.ts`),
    };

    const limits = {
      max_files_touched: 20,
      max_lines_changed: 100,
    };

    const result = checkDiffLimits(analysis, limits);

    expect(result.ok).toBe(true);
    expect(result.violation).toBeNull();
  });

  it('should calculate lines_changed correctly as sum of added and deleted', () => {
    const analysis: DiffAnalysis = {
      files_touched: 1,
      lines_added: 100,
      lines_deleted: 50,
      new_files: 0,
      touched_paths: ['src/file.ts'],
    };

    const limits = {
      max_files_touched: 10,
      max_lines_changed: 200,
    };

    const result = checkDiffLimits(analysis, limits);

    expect(result.ok).toBe(true);
    expect(result.lines_changed).toBe(150); // 100 + 50
  });
});
