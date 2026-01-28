/**
 * Builder result type definition matching builder_result.schema.json.
 *
 * This represents the structure output by the builder after executing a task.
 */

/**
 * Builder result structure output by the builder.
 *
 * This matches the structure defined in builder_result.schema.json.
 */
export interface BuilderResult {
  /** Summary of what was done */
  summary: string;
  /** Files the builder intended to modify */
  files_intended: string[];
  /** Commands executed during the build */
  commands_ran: string[];
  /** Additional notes */
  notes: string[];
}
