import * as vscode from 'vscode';
import * as path from 'path';
import { CodeAction, Disposable, Range, TextEditor } from 'vscode';
import { promisify } from 'util';

export type DocFun = (editor: TextEditor) => Thenable<void>;

export async function withTestDocument(file: string, diagnosticCount: number, test: DocFun, cleanup?: DocFun): Promise<void> { 
  const before = path.join(__dirname, '../../input', file);
  const editor = await didChangeDiagnostics(before, diagnosticCount, async () => {
    const doc = await vscode.workspace.openTextDocument(before);
    const editor = await vscode.window.showTextDocument(doc);
    return editor;
  });
  try {
    console.log('Now testing...');
    await test(editor);
    console.log('Done testing');
  } finally {
    console.log('Now cleaning up...');
    await cleanup?.(editor);
    await didChangeDiagnostics(before, 0, async () => {
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');
    });
    console.log('Done cleaning');
  }
}

export async function applyQuickFixes(editor : TextEditor): Promise<void> {
  const quickFixes = await vscode.commands.executeCommand<CodeAction[]>(
    'vscode.executeCodeActionProvider',
    editor.document.uri,
    new Range(0, 0, editor.document.lineCount - 1, 0)
  );
  for (const quickFix of quickFixes) {
    await vscode.commands.executeCommand(
      quickFix.command.command,
      ...quickFix.command.arguments
    );
  }
}


export function didChangeDiagnostics<T>(fsPath: string, count: number, action: () => Thenable<T>): Promise<T> {
  console.log(`Waiting for '${count}' on '${fsPath}'`);
  return didEvent(
    vscode.languages.onDidChangeDiagnostics,
    e => {
      console.log(`Event: [${e.uris.map(u => u.fsPath).join(' ; ')}]`);
      const uri = e.uris.find(uri => uri.fsPath === fsPath);
      console.log(`uri: ${uri}`);
      console.log(`Diagnostics: ${vscode.languages.getDiagnostics(uri).length}`);
      return uri && vscode.languages.getDiagnostics(uri).length === count;
    },
    action);
}

export function didEvent<TResult, TEvent>(
  subscribe: (arg: (event: TEvent) => void) => Disposable,
  predicate: (event: TEvent) => Boolean,
  action: () => Thenable<TResult>): Promise<TResult> {
  return new Promise<TResult>(async (resolve, _) => {
    const result = action();
    const disposable = subscribe(async e => {
      if(predicate(e)) {
        disposable.dispose();
        resolve(await result);
      }
    });
  });
}

export async function outputGHCiLog() {
    vscode.window.onDidChangeVisibleTextEditors(editors => {
      for (const editor of editors) {
        if (editor.document.fileName.startsWith('extension-output')) {
          const firstLine = editor.document.lineAt(0).text;
          if (!firstLine || firstLine.startsWith('Starting GHCi with')) {
            console.log(`\nGHCi Output:\n\n${editor.document.getText()}`);
          }
        }
      }
    }, this);
    await vscode.commands.executeCommand('vscode-ghc-simple.openOutput');
}
