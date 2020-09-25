import * as vscode from 'vscode';
import { withTestDocument } from './utils';
import { promisify } from 'util';
import { Selection } from 'vscode';

const configs = {
  'telemetry.enableTelemetry': false,
  // 'ghcSimple.replCommand': 'ghci -Wall',
  // 'ghcSimple.replScope': 'file',
};

suite('', () => {
  suiteSetup(async () => {
    const config = vscode.workspace.getConfiguration();
    for (const setting in configs) { 
      await config.update(setting, configs[setting], true);
    }
  });
  
  test('Go to Definition', () => {
    return withTestDocument('OK.hs', 1, async editor => {
      editor.selection = new Selection(8, 14, 8, 14);
      await vscode.commands.executeCommand('editor.action.revealDefinition');
      await promisify(setTimeout)(1000);
    });
  });

  test('Compillation errors', () => {
    return withTestDocument('Errors.hs', 3, async _ => {
      await promisify(setTimeout)(1000);
    });
  });

  test('Inline Repl', () => {
    return withTestDocument('OK.hs', 1, async _ => {
      await vscode.commands.executeCommand('vscode-ghc-simple.inline-repl-run-all');
      await promisify(setTimeout)(1000);
    });
  });


  suiteTeardown(async () => {
    const config = vscode.workspace.getConfiguration();
    for (const setting in configs) { 
      await config.update(setting, undefined, true);
    }
  });
});
