// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
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

enum Output {
	Terminal = 'Terminal',
	OutputChannel = 'Output Channel',
	Editor = 'Editor',
};

async function exec(cmd: string, cwd: string, output?: Output) {
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

interface DocumentShellCommand {
	file: vscode.Uri,
	cmd: string[],
	name: string,
	labelPosition: vscode.Position,
}

export class DocumentShellCommandTreeItem extends vscode.TreeItem implements DocumentShellCommand {
	public override collapsibleState = vscode.TreeItemCollapsibleState.None;
	public override contextValue = 'shell.documentShellCommandTreeItem';
	public override description = 'Command';
	public override iconPath = new vscode.ThemeIcon("terminal");
	//   vscode.Uri.joinPath(context.extensionUri, "resources", "icon-dark.svg"),
	// public override iconPath = vscode.ThemeIcon.File;

	constructor(
		public file: vscode.Uri,
		public cmd: string[],
		public name: string,
		public labelPosition: vscode.Position,
	) {
		super(name);
		this.label = name;
		this.description = path.basename(file.path);
		this.command = {
			command: 'shell.documentShellCommandView.show',
			title: 'Show in file',
			arguments: [
				this.file,
				this.labelPosition,
			],
		};
	}
}

export class DocumentShellCommandTreeViewProvider implements vscode.TreeDataProvider<DocumentShellCommandTreeItem> {
	private readonly _onDidChangeTreeData: vscode.EventEmitter<DocumentShellCommandTreeItem | undefined> = new vscode.EventEmitter<DocumentShellCommandTreeItem | undefined>();
	// eslint-disable-next-line @typescript-eslint/member-ordering
	public readonly onDidChangeTreeData: vscode.Event<DocumentShellCommandTreeItem | undefined> = this._onDidChangeTreeData.event;

	private commands: DocumentShellCommand[] = [];

	constructor() {
		this.refresh();
	}

	public async refresh(e?: DocumentShellCommandTreeItem): Promise<void> {
		// let uniqueFiles = new Set(this.commands.map(c => c.file));
		vscode.workspace.textDocuments.map(e => this.onDidOpenTextDocument(e, true));
		this._onDidChangeTreeData.fire(e);
	}

	public getTreeItem(element: DocumentShellCommandTreeItem): vscode.TreeItem {
		return element;
	}

	public getChildren(element?: DocumentShellCommandTreeItem): (DocumentShellCommandTreeItem)[] {
		if (element) {
			return [];
		}
		return this.commands.map(c => {
			return new DocumentShellCommandTreeItem(c.file, c.cmd, c.name, c.labelPosition);
		});
	}

	// Parse things like
	// $ # List files
	// $ dir `
	// $   \users
	public onDidOpenTextDocument(e: vscode.TextDocument, deferRefresh?: boolean): any {
		const docText = e.getText();
		const docLines = docText.split('\n');
		let newCommands = [];

		let currentLabel = undefined;
		let currentCommands = [];
		let labelPosition = undefined;

		for (let i = 0; i < docLines.length; ++i) {
			const l = docLines[i];

			if (currentLabel === undefined) {
				const labelStart = l.indexOf('$ #');

				if (labelStart === -1) {
					continue;
				}

				currentLabel = l.slice(labelStart + 3).trim();
				labelPosition = new vscode.Position(i, 0);
				continue;
			}

			const commandStart = l.indexOf('$');
			if (commandStart !== -1) {
				currentCommands.push(l.slice(commandStart + 1).trim());
			} else {
				if (currentCommands.length > 0) {
					newCommands.push(<DocumentShellCommand>{
						file: e.uri,
						cmd: currentCommands,
						name: currentLabel,
						labelPosition,
					});
				}
				currentCommands = [];
				currentLabel = undefined;
				labelPosition = undefined;
			}
		}

		if (currentCommands.length > 0) {
			newCommands.push(<DocumentShellCommand>{
				file: e.uri,
				cmd: currentCommands,
				name: currentLabel,
				labelPosition,
			});
		}

		this.commands = this.commands.filter(c => c.file.fsPath !== e.uri.fsPath).concat(newCommands);
		if (deferRefresh === undefined || deferRefresh === false) {
			this._onDidChangeTreeData.fire(undefined);
		}
	}
}

// This method is called when your extension is activated
// Your extension is activated the very first time the command is executed
export function activate(context: vscode.ExtensionContext) {
	// Use the console to output diagnostic information (console.log) and errors (console.error)
	// This line of code will only be executed once when your extension is activated
	console.log('Congratulations, your extension "shell" is now active!');

	// The command has been defined in the package.json file
	// Now provide the implementation of the command with registerCommand
	// The commandId parameter must match the command field in package.json
	const disposable = vscode.commands.registerCommand('shell.helloWorld', () => {
		// The code you place here will be executed every time your command is executed
		// Display a message box to the user
		vscode.window.showInformationMessage('Hello World from shell!');
	});

	context.subscriptions.push(disposable);

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

	const treeProvider = new DocumentShellCommandTreeViewProvider();
	context.subscriptions.push(
		vscode.workspace.onDidOpenTextDocument(treeProvider.onDidOpenTextDocument, treeProvider)
	);
	context.subscriptions.push(
		vscode.workspace.onDidSaveTextDocument(treeProvider.onDidOpenTextDocument, treeProvider)
	);
	vscode.commands.registerCommand('shell.documentShellCommandView.refresh', () =>
		treeProvider.refresh()
	);
	vscode.commands.registerCommand('shell.documentShellCommandView.run', (item: DocumentShellCommandTreeItem) => {
		const output = vscode.workspace.getConfiguration().get('shell.outputTerminal') as Output;
		exec(item.cmd.join("\n"), path.dirname(item.file.fsPath), output);
	});
	vscode.commands.registerCommand('shell.documentShellCommandView.show', (file: vscode.Uri, position: vscode.Position) => {
		vscode.workspace.openTextDocument(file).then(editor => {
			return vscode.window.showTextDocument(editor);
		}).then(editor => {
			editor.revealRange(new vscode.Range(position, position));
			editor.selection = new vscode.Selection(position, position);
		});
	});
	context.subscriptions.push(
		vscode.window.createTreeView('shell.documentShellCommandView', {
			treeDataProvider: treeProvider,
			showCollapseAll: true,
		})
	);
}

// This method is called when your extension is deactivated
export function deactivate() {
	if (process) {
		treeKill(process.pid, 'SIGTERM', function (err: Error) {
			if (err) {
				treeKill(process.pid, 'SIGKILL');
			}
			process = null;
		});
	}
}
