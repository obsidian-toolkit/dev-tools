#!/usr/bin/env node
import { Command } from 'commander';
import { findUpSync } from 'find-up-simple';
import path from 'node:path';
import { release } from './commands/release';
import { startObsidian } from './commands/start-obsidian';
const root = findUpSync('package.json');
if (!root) {
    process.exit(1);
}
else {
    process.chdir(path.dirname(root));
}
const program = new Command();
program
    .name('obsidian-cli')
    .description('CLI for Obsidian plugin development')
    .version('1.0.0');
program
    .command('start')
    .description('Start Obsidian')
    .action(async () => {
    try {
        await startObsidian();
    }
    catch (error) {
        console.error(error);
        process.exit(1);
    }
});
program
    .command('release')
    .description('Release the plugin')
    .option('--dry-run', 'Show what would be done without making changes', false)
    .action(async (options) => {
    try {
        await release(options.dryRun);
    }
    catch (error) {
        console.error(error);
        process.exit(1);
    }
});
program.parse();
