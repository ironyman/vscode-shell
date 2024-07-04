import * as vscode from 'vscode';
import * as path from 'path';

var spawnCMD = require('spawn-command');
var treeKill = require('tree-kill');

var process: ReturnType<typeof spawnCMD> = null;
var commandOutput: vscode.OutputChannel | null = null;
var commandHistory: CommandHistory | null = null;
var lastTerminal: vscode.Terminal | undefined;

export interface Command {
	cmd: string;
	cwd: string;
}

export enum Output {
	Terminal = 'Terminal',
	OutputChannel = 'Output Channel',
	Editor = 'Editor',
};

export class CommandHistory {
	private history: Command[] = [];

	public dispose() {
	}

	public enqueue(cmd: string, cwd: string) {
		var last = this.last();
		if (last === undefined || (last.cmd !== cmd || last.cwd !== cwd)) {
			this.history.push({ cmd: cmd, cwd: cwd });
		}
	}

	public commands() {
		return this.history;
	}

	public last() {
		if (this.history.length === 0) {
			return undefined;
		}
		return this.history[this.history.length - 1];
	}
}

function run(cmd: string, cwd: string, outputHandler: (data: NodeJS.ReadStream) => void) {
	return new Promise((accept, reject) => {
		var opts: any = {};
		opts.cwd = cwd;
		process = spawnCMD(cmd, opts);
		process.stdout.on('data', outputHandler);
		process.stderr.on('data', outputHandler);
		process.on('close', (status: number) => {
			if (status) {
				reject(`Command \`${cmd}\` exited with status code ${status}.`);
			} else {
				accept(/* unused */true);
			}
			process = null;
		});
	});
}

function term() {
	treeKill(process.pid, 'SIGTERM', function (err: Error) {
		if (err) {
			vscode.window.showErrorMessage(`Failed to kill process with PID ${process.pid}.`);
		} else {
			process = null;
		}
	});
}

function execShellCMD(cwd: string) {
	if (process) {
		const msg = 'There is an active running shell command right now. Terminate it before executing another shell command.';
		vscode.window.showWarningMessage(msg, 'Terminate')
			.then((choice) => {
				if (choice === 'Terminate') {
					term();
				}
			});
	} else {
		var lastCmd = commandHistory?.last();
		var options = {
			placeHolder: 'Type your shell command here.',
			value: lastCmd ? lastCmd.cmd : undefined
		};
		vscode.window.showInputBox(options).then((cmd) => {
			if (cmd) {
				exec(cmd, cwd);
			}
		});
	}
}

function showHistory() {
	return new Promise((accept, reject) => {
		let items: vscode.QuickPickItem[] = (commandHistory?.commands() || []).map((cmd) => {
			return { label: cmd.cmd, detail: cmd.cwd, cmd: cmd, description: undefined };
		});
		vscode.window.showQuickPick(items).then((value: any) => {
			if (value) {
				exec(value.cmd.cmd, value.cmd.cwd);
			}
		});
	});
}

export async function exec(cmd: string, cwd: string, output?: Output) {
	if (!cmd) { return; }

	commandHistory?.enqueue(cmd, cwd);

	if (!output || output === Output.OutputChannel) {
		commandOutput?.clear();
		commandOutput?.show(true);
		commandOutput?.appendLine(`> Running command \`${cmd}\`...`);
		function printOutput(data: NodeJS.ReadStream) { commandOutput?.append(data.toString()); }
		run(cmd, cwd, printOutput).then(() => {
			commandOutput?.appendLine(`> Command \`${cmd}\` ran successfully.`);
		}).catch((reason) => {
			commandOutput?.appendLine(`> ERROR: ${reason}`);
			vscode.window.showErrorMessage(reason, 'Show Output')
				.then((action) => { commandOutput?.show(); });
		});
	} else if (output === Output.Terminal) {
		const reuseTerminal = vscode.workspace.getConfiguration().get<boolean>('shell.reuseTerminal');
		let term;
		if (reuseTerminal && lastTerminal !== undefined && lastTerminal?.exitStatus === undefined) {
			term = lastTerminal;
			if (vscode.workspace.getConfiguration().get<boolean>('shell.stopPreviousProcess')) {
				term.show(true);
				vscode.commands.executeCommand('workbench.action.terminal.sendSequence', {
					text: '\u0003'
				});
			}
		} else {
			// term = vscode.window.createTerminal('Shell', 'cmd.exe');
			term = vscode.window.createTerminal(<vscode.TerminalOptions>{
				name: 'Shell',
				cwd,
				shellPath: vscode.workspace.getConfiguration().get('shell.shell') || 'cmd.exe',
				location: vscode.TerminalLocation.Panel,
			});
		}
		term.show(true);
		term.sendText(`${cmd}\n`);
		lastTerminal = term;
	} else if (output === Output.Editor && vscode.window.activeTextEditor) {
		let insertOffset = vscode.window.activeTextEditor.document.offsetAt(
			new vscode.Position(vscode.window.activeTextEditor!.selection.active.line + 1, 0));
		// let previousEdit: Thenable<boolean> = Promise.resolve(true);
		let previousEdit = vscode.window.activeTextEditor!.edit((editBuilder: vscode.TextEditorEdit) => {
			editBuilder.insert(vscode.window.activeTextEditor!.selection.active, '\n');
			insertOffset += 1;
		});

		async function printOutput(data: NodeJS.ReadStream) {
			await previousEdit;
			previousEdit = vscode.window.activeTextEditor!.edit((editBuilder: vscode.TextEditorEdit) => {
				editBuilder.insert(vscode.window.activeTextEditor!.selection.active, data.toString());
				insertOffset += data.toString().length;
			});
		}

		run(cmd, cwd, printOutput).then(() => {
			commandOutput?.appendLine(`> Command \`${cmd}\` ran successfully.`);
		}).catch((reason) => {
			commandOutput?.appendLine(`> ERROR: ${reason}`);
			vscode.window.showErrorMessage(reason, 'Show Output')
				.then((action) => { commandOutput?.show(); });
		});
	}
}

async function executeSelection(context: vscode.ExtensionContext, opts?: { delete?: boolean, outputInPlace?: boolean }) {
	const activeEditor = vscode.window.activeTextEditor;
	if (!activeEditor) {
		vscode.window.showInformationMessage(
			'Could not detect an active editor.'
		);
		return;
	}

	let commandText = '';
	let selectedRange = null;

	if (activeEditor.selection.isEmpty) {
		// const tokens: vscode.SemanticTokens | undefined = await vscode.commands.executeCommand('vscode.provideDocumentSemanticTokens', activeEditor.document.uri);
		// if (!tokens) {
		// 	vscode.window.showInformationMessage(
		// 		'Could not detect executable command.'
		// 	);
		// 	return;
		// }
		// // https://vscode-api.js.org/interfaces/vscode.DocumentSemanticTokensProvider.html
		// interface LanguageProviderToken {
		// 	line: number;
		// 	column: number;
		// 	length: number;
		// 	tokenType: string;
		// 	tokenModifier: string;
		// };
		// for (let i = 0; i < tokens.data.length; ++i) {
		// }
		// const result3: vscode.SemanticTokensLegend = await vscode.commands.executeCommand('vscode.provideDocumentRangeSemanticTokensLegend', activeEditor.document.uri);
		// console.log(tokens);
		// console.log(result3);
		const docText = activeEditor.document.getText();
		let cursorOffset = activeEditor.document.offsetAt(activeEditor.selection.start);

		// Start from character preceding cursor.
		if (cursorOffset > 0) {
			cursorOffset--;
		}

		// Use '$' to denote start of command
		while (cursorOffset > 0 && (docText[cursorOffset] !== '$' && docText[cursorOffset] !== '\n')) {
			cursorOffset--;
		}
		if (cursorOffset < 0) {
			return;
		}

		selectedRange = new vscode.Range(activeEditor.document.positionAt(cursorOffset),
			/* will replace later */activeEditor.document.positionAt(docText.length));
		// Exclude the '\n' or '$' from command text
		const startSelection = cursorOffset + 1;
		let endSelection = docText.indexOf('\n', startSelection);
		endSelection = endSelection === -1 ? docText.length : endSelection;

		selectedRange = new vscode.Range(selectedRange.start,
			activeEditor.document.positionAt(endSelection));

		commandText = docText.slice(startSelection, endSelection).trim();
	} else {
		selectedRange = activeEditor.selection;
		commandText = activeEditor.document.getText(activeEditor.selection);
	}

	if (opts?.delete) {
		await activeEditor.edit((editBuilder: vscode.TextEditorEdit) => {
			editBuilder.delete(selectedRange);
		});
	}

	if (opts?.outputInPlace) {
		exec(commandText, path.dirname(activeEditor.document.uri.fsPath), Output.Editor);
	} else {
		const output = vscode.workspace.getConfiguration().get('shell.outputTerminal') as Output;
		exec(commandText, path.dirname(activeEditor.document.uri.fsPath), output);
	}
}

export function initializeExec(context: vscode.ExtensionContext) {
	commandOutput = vscode.window.createOutputChannel('Shell');
	context.subscriptions.push(commandOutput);

	context.subscriptions.push(vscode.commands.registerCommand('shell.showCommandLog', () => {
		commandOutput?.show();
	}));

	commandHistory = new CommandHistory();
	context.subscriptions.push(commandHistory);

	context.subscriptions.push(vscode.commands.registerCommand('shell.showHistory', showHistory));

	context.subscriptions.push(vscode.commands.registerCommand('shell.runCommand', () => {
		if (vscode.window.activeTextEditor?.document.uri.scheme === 'file') {
			execShellCMD(path.dirname(vscode.window.activeTextEditor.document.uri.fsPath));
		} else if ((vscode.workspace.workspaceFolders?.length || 0) > 0) {
			execShellCMD(vscode.workspace.workspaceFolders![0].uri.fsPath);
		} else {
			execShellCMD("\\");
		}
	}));

	context.subscriptions.push(vscode.commands.registerCommand('shell.terminateCommand', () => {
		if (process) {
			term();
		} else {
			vscode.window.showErrorMessage('No running command.');
		}
	}));

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'shell.executeSelection',
			async () => {
				executeSelection(context);
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'shell.executeSelectionDelete',
			async () => {
				executeSelection(context, { delete: true });
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'shell.executeSelectionOutputInPlace',
			async () => {
				executeSelection(context, { outputInPlace: true });
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'shell.executeSelectionOutputReplace',
			async () => {
				executeSelection(context, { delete: true, outputInPlace: true });
			}
		)
	);

	context.subscriptions.push(
		vscode.commands.registerCommand(
			'shell.executeLastCommand',
			async () => {
				var lastCmd = commandHistory?.last();
				if (lastCmd === undefined) {
					return;
				}
				const output = vscode.workspace.getConfiguration().get('shell.outputTerminal') as Output;
				exec(lastCmd.cmd, lastCmd.cwd, output);
			}
		)
	);
}

export function deactivateExec() {
    if (process) {
		treeKill(process.pid, 'SIGTERM', function (err: Error) {
			if (err) {
				treeKill(process.pid, 'SIGKILL');
			}
			process = null;
		});
	}
}