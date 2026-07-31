#!/usr/bin/env node
import { Command, CommanderError } from 'commander';
import { printInit, runInit } from './commands/init.js';
import { printStats, runStats } from './commands/stats.js';
import { notImplemented } from './commands/notImplemented.js';
import { isCanonlintError } from './util/errors.js';
import { log } from './util/logger.js';
import { VERSION } from './version.js';

export function buildProgram(): Command {
  const program = new Command();

  program
    .name('canonlint')
    .description(
      'A continuity engine and linter for fictional universes.\n' +
        'Build a canon database from your stories, then lint new drafts against it.',
    )
    .version(VERSION, '-v, --version')
    .option('--provider <name>', 'anthropic | ollama (overrides config and env)')
    .option('--model <id>', 'model id (overrides config and env)');

  program
    .command('init')
    .description('create .canonlint/ and an empty canon database in this directory')
    .option('--force', 're-apply migrations to an existing database', false)
    .action((options: { force: boolean }) => {
      const globals = program.opts<{ provider?: string; model?: string }>();
      printInit(
        runInit({
          force: options.force,
          ...(globals.provider ? { provider: globals.provider } : {}),
          ...(globals.model ? { model: globals.model } : {}),
        }),
      );
    });

  program
    .command('stats')
    .description('summarise the canon database')
    .option('--json', 'emit machine-readable JSON', false)
    .action((options: { json: boolean }) => {
      const globals = program.opts<{ provider?: string; model?: string }>();
      const stats = runStats(globals);
      if (options.json) {
        log.info(JSON.stringify(stats, null, 2));
      } else {
        printStats(stats);
      }
    });

  program
    .command('ingest')
    .argument('<path>', 'file or directory of .txt / .md story text')
    .option('--work <title>', 'title of the work being ingested')
    .option('--order <n>', 'publication order index', Number)
    .option('--review', 'review proposed claims interactively before promoting', false)
    .description('extract claims from a corpus into the canon database')
    .action(() => notImplemented('ingest'));

  program
    .command('check')
    .argument('<draft>', 'draft file to lint')
    .description('lint a draft against canon and write a continuity report')
    .action(() => notImplemented('check'));

  program
    .command('merge')
    .argument('<draft>', 'draft whose new facts should become canon')
    .description('approve a draft’s new facts into the canon database')
    .action(() => notImplemented('merge'));

  program
    .command('entity')
    .argument('<name>', 'entity name')
    .description('show everything canon knows about an entity, with citations')
    .action(() => notImplemented('entity'));

  return program;
}

export async function main(argv: string[] = process.argv): Promise<number> {
  const program = buildProgram();
  program.exitOverride();

  try {
    await program.parseAsync(argv);
    return 0;
  } catch (err) {
    if (err instanceof CommanderError) {
      // --help and --version are reported as errors by exitOverride.
      return err.exitCode;
    }
    if (isCanonlintError(err)) {
      log.error(err.message);
      return 1;
    }
    log.error(err instanceof Error ? err.message : String(err));
    if (err instanceof Error && err.stack && process.env.CANONLINT_DEBUG) {
      log.info(err.stack);
    } else {
      log.detail('Re-run with CANONLINT_DEBUG=1 for a stack trace.');
    }
    return 1;
  }
}

// Only run when invoked as a binary, so tests can import `main` freely.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().then((code) => {
    process.exitCode = code;
  });
}
