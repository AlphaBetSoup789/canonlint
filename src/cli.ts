#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command, CommanderError } from 'commander';
import { printCheck, runCheck } from './commands/check.js';
import { printEntity, runEntity } from './commands/entity.js';
import { printInit, runInit } from './commands/init.js';
import { printIngest, runIngest } from './commands/ingest.js';
import { printMerge, runMerge } from './commands/merge.js';
import { printStats, runStats } from './commands/stats.js';
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
    .option('--provider <name>', 'anthropic | ollama | mock (overrides config and env)')
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
    .option(
      '--max-spend <usd>',
      'abort if the pre-run estimate exceeds this USD amount',
      Number,
    )
    .description('extract claims from a corpus into the canon database')
    .action(
      async (
        path: string,
        options: {
          work?: string;
          order?: number;
          review: boolean;
          maxSpend?: number;
        },
      ) => {
        const globals = program.opts<{ provider?: string; model?: string }>();
        printIngest(
          await runIngest({
            path,
            work: options.work,
            order: options.order,
            review: options.review,
            ...(options.maxSpend !== undefined
              ? { maxSpendUsd: options.maxSpend }
              : {}),
            ...(globals.provider ? { provider: globals.provider } : {}),
            ...(globals.model ? { model: globals.model } : {}),
          }),
        );
      },
    );

  program
    .command('check')
    .argument('<draft>', 'draft file to lint')
    .option('--json', 'emit machine-readable JSON', false)
    .option('--out <file>', 'also write a markdown report to this path')
    .option(
      '--max-spend <usd>',
      'abort if the pre-run estimate exceeds this USD amount',
      Number,
    )
    .description('lint a draft against canon and write a continuity report')
    .action(
      async (
        draft: string,
        options: { json: boolean; out?: string; maxSpend?: number },
      ) => {
        const globals = program.opts<{ provider?: string; model?: string }>();
        const result = await runCheck({
          draft,
          out: options.out,
          ...(options.maxSpend !== undefined ? { maxSpendUsd: options.maxSpend } : {}),
          ...(globals.provider ? { provider: globals.provider } : {}),
          ...(globals.model ? { model: globals.model } : {}),
        });
        printCheck(result, options.json);
      },
    );

  program
    .command('merge')
    .argument('<draft>', 'draft whose new facts should become canon')
    .option('--run <id>', 'check run id to merge from (default: latest)', Number)
    .option('--proposed', 'store merged claims as proposed instead of canon', false)
    .description("approve a draft's new facts into the canon database")
    .action((draft: string, options: { run?: number; proposed: boolean }) => {
      const globals = program.opts<{ provider?: string; model?: string }>();
      printMerge(
        runMerge({
          draft,
          proposed: options.proposed,
          ...(options.run !== undefined ? { runId: options.run } : {}),
          ...(globals.provider ? { provider: globals.provider } : {}),
          ...(globals.model ? { model: globals.model } : {}),
        }),
      );
    });

  program
    .command('entity')
    .argument('<name>', 'entity name')
    .option('--json', 'emit machine-readable JSON', false)
    .description('show everything canon knows about an entity, with citations')
    .action((name: string, options: { json: boolean }) => {
      const globals = program.opts<{ provider?: string; model?: string }>();
      const result = runEntity({
        name,
        ...(globals.provider ? { provider: globals.provider } : {}),
        ...(globals.model ? { model: globals.model } : {}),
      });
      if (options.json) {
        log.info(
          JSON.stringify(
            {
              id: result.entity.id,
              name: result.entity.name,
              kind: result.entity.kind,
              aliases: result.aliases,
              claims: result.claims,
            },
            null,
            2,
          ),
        );
      } else {
        printEntity(result);
      }
    });

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

/**
 * True when this module is the process entry point, rather than an import.
 *
 * Comparing `import.meta.url` against a hand-built `file://${argv[1]}` string
 * looks equivalent and is not: on Windows the real URL is `file:///C:/...`
 * while the concatenation yields `file://C:\...`, so the guard never matched
 * and the CLI exited 0 having done nothing at all.
 *
 * `realpathSync` additionally resolves the symlink npm creates for a global
 * `bin` install, which would otherwise make the two paths differ.
 */
function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(fileURLToPath(import.meta.url)) === realpathSync(entry);
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  main().then((code) => {
    process.exitCode = code;
  });
}
