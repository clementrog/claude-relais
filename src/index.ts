#!/usr/bin/env node

import { Command } from "commander";

const program = new Command();

program
  .name("relais")
  .description("Deterministic orchestration runner for Claude Code")
  .version("1.0.0");

program
  .command("init")
  .description("Initialize relais workspace in current directory")
  .action(() => {
    console.log("relais init - not yet implemented");
  });

program
  .command("status")
  .description("Show current relais state")
  .option("--preflight", "Run preflight checks")
  .action((options) => {
    console.log("relais status - not yet implemented");
    if (options.preflight) {
      console.log("  (with preflight checks)");
    }
  });

program
  .command("run")
  .description("Execute one tick of the relais loop")
  .action(() => {
    console.log("relais run - not yet implemented");
  });

program
  .command("doctor")
  .description("Diagnose relais configuration and environment")
  .action(() => {
    console.log("relais doctor - not yet implemented");
  });

export async function main(): Promise<void> {
  await program.parseAsync(process.argv);
}

main().catch((error) => {
  console.error("Fatal error:", error);
  process.exit(1);
});
