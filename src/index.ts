#!/usr/bin/env node
import { findUpSync } from 'find-up-simple';
import path from 'node:path';

import { release } from './commands/release';
import { startObsidian } from './commands/start-obsidian';

const root = findUpSync('package.json');

if (!root) {
    process.exit(1);
} else {
    process.chdir(path.dirname(root));
}

(async () => {
    const command = process.argv[2];

    try {
        switch (command) {
            case 'start':
                await startObsidian();
                break;
            case 'release':
                await release();
                break;
            default:
                console.log('Usage: obsidian-cli <start|release>');
        }
    } catch (error) {
        console.error(error);
        process.exit(1);
    }
})();
