import * as cp from 'child_process';
import * as path from 'path';
import { env } from 'process';

import {
  runTests,
  downloadAndUnzipVSCode,
  resolveCliPathFromVSCodeExecutablePath
} from 'vscode-test';

async function main(): Promise<void> {
  try {
    // The folder containing the Extension Manifest package.json
    // Passed to `--extensionDevelopmentPath`
    const extensionDevelopmentPath = path.resolve(__dirname, '../../');

    // The path to the extension test runner script
    // Passed to --extensionTestsPath
    const extensionTestsPath = __dirname;
    const vscodeVersion = env['CODE_VERSION'];
    const vscodeExecutablePath = await downloadAndUnzipVSCode(vscodeVersion);
    const cliPath = resolveCliPathFromVSCodeExecutablePath(vscodeExecutablePath);

    // Install dependent extensions
    const dependencies = [
      'justusadam.language-haskell'
    ];

    const extensionsDir = path.resolve(path.dirname(cliPath), '..', 'extensions');
    const userDataDir = path.resolve(extensionsDir, '..', '..', 'udd');

    for(const extension of dependencies) {
      cp.spawnSync(cliPath, ['--extensions-dir', extensionsDir, '--install-extension', extension], {
        encoding: 'utf-8',
        stdio: 'inherit'
      });
    }

    const disabledExtensions = [
      'vscode.git',
      'vscode.github'
    ];

    // Download VS Code, unzip it and run the integration test
    process.exit(await runTests({
      vscodeExecutablePath,
      extensionDevelopmentPath,
      extensionTestsPath,
      launchArgs: [
        '--user-data-dir', userDataDir,
        '--extensions-dir', extensionsDir,
        '--new-window',
        '--disable-gpu',
        '--disable-updates',
        '--logExtensionHostCommunication',
        '--skip-getting-started',
        '--skip-release-notes',
        '--disable-restore-windows',
        '--disable-telemetry',
        '--do-not-sync'
      ].concat(disabledExtensions.flatMap(ex => ['--disable-extension', ex]))
    }));
  } catch (err) {
    console.error('Failed to run tests:');
    console.error(err);
		process.exit(-1);
  }
}

main();
