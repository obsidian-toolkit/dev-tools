import { confirm, input, select } from '@inquirer/prompts';
import chalk from 'chalk';
import { readFileSync } from 'fs';
import { Content, Root } from 'mdast';
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import prettier from 'prettier';
import { remark } from 'remark';
import semver from 'semver';

const MANIFEST_PATH = 'manifest.json';
const PACKAGE_PATH = 'package.json';
const README_PATH = 'README.md';
const CHANGELOG_PATH = 'CHANGELOG.md';
const DIST_PATH = 'dist';
const MAIN_BRANCHES = ['main', 'master'];

interface JsonFile {
    version: string;
}

let isDryRun = false;

function logAction(action: string, details?: string) {
    const prefix = isDryRun ? chalk.blue('[DRY RUN]') : chalk.green('[EXEC]');
    console.log(`${prefix} ${action}${details ? `: ${details}` : ''}`);
}

function execCommand(command: string, options: any = {}) {
    if (isDryRun) {
        logAction('Would execute', command);
        return '';
    }
    return execSync(command, options);
}

/**
 * Checking the availability of gh CLI
 */
function checkGhCli() {
    try {
        execSync('gh --version', { stdio: 'ignore' });
    } catch (error) {
        console.error(
            chalk.red(
                'Github Cli (GH) was not found. Install it: https://cli.github.com/'
            )
        );
        process.exit(1);
    }
}

/**
 * Cleaning and building
 */
async function buildProject() {
    logAction('Cleaning and building');

    // Clearing dist
    if (fs.existsSync(DIST_PATH)) {
        if (isDryRun) {
            logAction('Would remove dist folder');
        } else {
            fs.rmSync(DIST_PATH, { recursive: true, force: true });
            console.log('The dist folder is cleared');
        }
    }

    // Build
    try {
        execCommand('npm run build', { stdio: 'inherit' });
        if (!isDryRun) {
            console.log(chalk.green('The build is completed'));
        }
    } catch (error) {
        if (!isDryRun) {
            console.error(chalk.red(`Build error: ${error}`));
            process.exit(1);
        }
    }
}

async function traverse(version: string): Promise<string | null> {
    const changelog = readFileSync('CHANGELOG.md', 'utf-8');
    let found = false;

    function inner() {
        return (tree: Root) => {
            const nodes = tree.children;

            for (let i = 0; i < nodes.length; i++) {
                const node = nodes[i];

                if (node.type !== 'heading') continue;
                if (node.depth !== 1) continue;
                if (node.position?.start.line !== 1) continue;

                const foundVersion = node.children[0];
                if (foundVersion.type !== 'text') continue;
                const versionText = foundVersion.value.trim();

                if (!semver.valid(versionText)) continue;
                if (!semver.eq(versionText, version)) continue;

                const sectionContent: Content[] = [];

                for (let j = i + 1; j < nodes.length; j++) {
                    const nextNode = nodes[j];
                    if (nextNode.type === 'heading' && nextNode.depth <= 1) {
                        break;
                    }
                    sectionContent.push(nextNode);
                }

                tree.children = sectionContent;
                found = true;
                break;
            }
        };
    }

    const result = await remark().use(inner).process(changelog);

    return found ? String(result) : null;
}

async function extractMatchedVersionSection(
    version: string
): Promise<null | string> {
    const result = await traverse(version);

    if (!result) {
        return null;
    }

    return result;
}

/**
 * Getting the Repository URL
 */
function getRepoUrl(): string {
    try {
        const repoInfo = execSync('gh repo view --json url', { stdio: 'pipe' })
            .toString()
            .trim();
        const parsed = JSON.parse(repoInfo);
        return parsed.url;
    } catch (error) {
        console.error('Error getting the repo URL:', error);
        process.exit(1);
    }
}

/**
 * Creating a GitHub release
 */
async function createGitHubRelease(
    version: string,
    previousVersion: string,
    repoUrl: string
) {
    logAction('Creating GitHub release', version);

    // Get a changelog for the version
    const changelogSection = await extractMatchedVersionSection(version);

    // Create a release body
    const fullChangelogUrl = `${repoUrl}/compare/${previousVersion}...${version}`;
    const releaseBody = `${changelogSection}\n\n**Full Changelog**: ${fullChangelogUrl}`;

    if (isDryRun) {
        logAction(
            'Would create release with body',
            releaseBody.substring(0, 100) + '...'
        );
        console.log(
            chalk.blue(
                `[DRY RUN] Release ${version} would be created and published`
            )
        );
        return;
    }

    // Get all files from dist
    const distFiles = fs
        .readdirSync(DIST_PATH)
        .map((file) => path.join(DIST_PATH, file))
        .join(' ');

    try {
        const releaseCommand = `gh release create ${version} ${distFiles} --title "Release ${version}" --notes "${releaseBody.replace(/"/g, '\\"')}"`;
        execSync(releaseCommand, { stdio: 'inherit' });
        console.log(chalk.green(`Release ${version} created and published`));
    } catch (error) {
        console.error('Release creation error:', error);
        process.exit(1);
    }
}

async function changeReleaseInJson(jsonPath: string, release: string) {
    try {
        const json = fs.readFileSync(jsonPath, 'utf8');
        const data: JsonFile = JSON.parse(json);
        data.version = release;

        const formatted = await prettier.format(JSON.stringify(data), {
            parser: 'json',
        });

        if (isDryRun) {
            logAction(`Would update ${jsonPath}`, `version: ${release}`);
        } else {
            fs.writeFileSync(jsonPath, formatted);
        }
    } catch (err: any) {
        console.error('Error reading JSON file:', err);
        process.exit(1);
    }
}

/**
 * Get operations via gh
 */
async function performGitOperations(version: string, branch: string) {
    try {
        execCommand('git reset', { stdio: 'ignore' });
        execCommand(`git add ${PACKAGE_PATH} ${MANIFEST_PATH}`, {
            stdio: 'ignore',
        });
        execCommand(
            `git commit -m 'chore: update plugin version to ${version}'`,
            {
                stdio: 'ignore',
            }
        );
        execCommand(`git push origin ${branch}`, { stdio: 'ignore' });

        if (!isDryRun) {
            console.log(chalk.green('The changes are running in the repo'));
        }
    } catch (error) {
        if (!isDryRun) {
            console.error('Error of git operations:', error);
            process.exit(1);
        }
    }
}

async function getNewVersion(
    previousVersions: string[],
    currentVersion: string,
    isFirstEnter: boolean
) {
    const answer = await input({
        message: 'Enter new version number or press Enter to exit: ',
        required: false,
        validate: (value) => {
            if (value === '') {
                return true;
            }
            if (!semver.valid(value)) {
                return 'Invalid version format. Please try again. It should be semantic versioning (e.g., 1.2.3)';
            }
            if (previousVersions.includes(value)) {
                return 'Version already exists. Please try again.';
            }
            if (!isFirstEnter && semver.lt(value, currentVersion)) {
                return `Version must be greater than current version. Current version is: ${currentVersion}. Please try again.`;
            }
            return true;
        },
    });

    if (!answer.trim()) {
        console.log('See you later!');
        process.exit(0);
    }

    return answer;
}

async function versionMenu(
    previousVersions: string[],
    currentVersion: string
): Promise<string> {
    process.on('SIGINT', () => {
        console.log('\nProcess terminated. Exiting gracefully...');
        process.exit(0);
    });

    while (true) {
        const [major, minor, patch] = currentVersion.split('.').map(Number);

        const answer = await select({
            message: `Update current version ${currentVersion} or perform other actions:`,
            choices: [
                {
                    name: `Patch (bug fixes): ${major}.${minor}.${patch + 1}`,
                    value: '1',
                },
                {
                    name: `Minor (new functionality): ${major}.${minor + 1}.0`,
                    value: '2',
                },
                {
                    name: `Major (significant changes): ${major + 1}.0.0`,
                    value: '3',
                },
                { name: 'Manual update (enter version)', value: '4' },
                { name: 'View previous versions', value: '5' },
                { name: 'Exit', value: '6' },
            ],
        });

        if (answer === '1') {
            return `${major}.${minor}.${patch + 1}`;
        } else if (answer === '2') {
            return `${major}.${minor + 1}.0`;
        } else if (answer === '3') {
            return `${major + 1}.0.0`;
        } else if (answer === '4') {
            return getNewVersion(previousVersions, currentVersion, false);
        } else if (answer === '5') {
            console.log('Previous versions:');
            console.log(`- ${previousVersions.join('\n- ')}`);
            await input({
                message: 'Press Enter to go back to the menu...',
                required: false,
                transformer: () => '',
            });
        } else if (answer === '6') {
            console.log('See you later!');
            process.exit(0);
        }
    }
}

/**
 * Getting versions via gh
 */
async function getVersion(): Promise<{
    version: string;
    previousVersion: string;
}> {
    try {
        const releasesOutput = isDryRun
            ? '1.0.0\t...'
            : execSync('gh release list --limit 100', { stdio: 'pipe' })
                  .toString()
                  .trim();

        const releases = releasesOutput
            ? releasesOutput.split('\n').map((line) => line.split('\t')[0])
            : [];

        const currentVersion = releases[0];

        if (releases.length === 0) {
            const version = await getNewVersion(releases, currentVersion, true);
            return { version, previousVersion: '' };
        }

        const version = await versionMenu(releases, currentVersion);
        return { version, previousVersion: currentVersion };
    } catch (error) {
        // Fallback on git tags if gh does not work
        const tagOutput = isDryRun
            ? ''
            : execSync('git tag', { stdio: 'pipe' }).toString().trim();
        const tags = tagOutput ? tagOutput.split('\n') : [];
        const currentVersion = tags[tags.length - 1];

        if (tags.length === 0) {
            const version = await getNewVersion(tags, currentVersion, true);
            return { version, previousVersion: '' };
        }

        const version = await versionMenu(tags, currentVersion);
        return { version, previousVersion: currentVersion };
    }
}

export async function release(isDryRunOption: boolean): Promise<void> {
    isDryRun = isDryRunOption;

    checkGhCli();

    while (true) {
        const { version: RELEASE_VERSION, previousVersion } =
            await getVersion();

        const confirmation = await select({
            message: `You entered version ${RELEASE_VERSION}. Continue?`,
            choices: [
                { name: 'Yes', value: 'y' },
                { name: 'No', value: 'n' },
                { name: 'Retry', value: 'r' },
            ],
        });

        switch (confirmation) {
            case 'y':
                break;
            case 'n':
                console.log('See you later!');
                process.exit(0);
                break;
            case 'r':
                continue;
        }

        const hasUpdatedChangelog =
            !!(await extractMatchedVersionSection(RELEASE_VERSION));

        if (!hasUpdatedChangelog) {
            console.log(
                chalk.yellow(
                    `Changelog section for ${RELEASE_VERSION} not found. Please update the changelog.`
                )
            );
            return;
        }

        await changeReleaseInJson(PACKAGE_PATH, RELEASE_VERSION);
        await changeReleaseInJson(MANIFEST_PATH, RELEASE_VERSION);

        if (isDryRun) {
            console.log(
                chalk.blue(
                    `[DRY RUN] Version would be updated to ${RELEASE_VERSION} in package.json and manifest.json`
                )
            );
        } else {
            console.log(
                chalk.green(
                    `Version updated to ${RELEASE_VERSION} in package.json and manifest.json`
                )
            );
        }

        if (!isDryRun) {
            const confirmContinue = await confirm({
                message: 'Continue with git operations and release?',
                default: true,
            });

            if (!confirmContinue) {
                console.log('See you later!');
                process.exit(0);
            }
        }

        const currentBranch = isDryRun
            ? 'main'
            : execSync('git rev-parse --abbrev-ref HEAD', { stdio: 'pipe' })
                  .toString()
                  .trim();

        console.log(`Working with a branch: ${currentBranch}`);

        if (!MAIN_BRANCHES.includes(currentBranch)) {
            console.log(
                chalk.red(
                    `Expected one of branches: ${MAIN_BRANCHES.join(', ')}, got branch: ${currentBranch}`
                )
            );
            if (!isDryRun) {
                process.exit(1);
            }
        }

        await performGitOperations(RELEASE_VERSION, currentBranch);

        await buildProject();

        const repoUrl = getRepoUrl();

        await createGitHubRelease(RELEASE_VERSION, previousVersion, repoUrl);

        if (isDryRun) {
            console.log(
                chalk.blue(
                    `🔍 DRY RUN COMPLETE: Release ${RELEASE_VERSION} would be successfully created and published!`
                )
            );
        } else {
            console.log(
                chalk.green(
                    `Release ${RELEASE_VERSION} has been successfully created and published!`
                )
            );
        }

        break;
    }
}
