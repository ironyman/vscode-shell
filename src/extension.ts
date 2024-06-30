// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as path from 'path';
var spawnCMD = require('spawn-command');
var treeKill = require('tree-kill');


var process: ReturnType<typeof spawnCMD> = null;
var commandOutput: vscode.OutputChannel | null = null;
var commandHistory: CommandHistory | null = null;

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


function run(cmd: string, cwd: string) {
	return new Promise((accept, reject) => {
		var opts: any = {};
		if (vscode.workspace) {
			opts.cwd = cwd;
		}
		process = spawnCMD(cmd, opts);
		function printOutput(data: NodeJS.ReadStream) { commandOutput?.append(data.toString()); }
		process.stdout.on('data', printOutput);
		process.stderr.on('data', printOutput);
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

function exec(cmd: string, cwd: string) {
	if (!cmd) { return; }
	commandHistory?.enqueue(cmd, cwd);
	commandOutput?.clear();
	commandOutput?.appendLine(`> Running command \`${cmd}\`...`)
	run(cmd, cwd).then(() => {
		commandOutput?.appendLine(`> Command \`${cmd}\` ran successfully.`);
	}).catch((reason) => {
		commandOutput?.appendLine(`> ERROR: ${reason}`);
		vscode.window.showErrorMessage(reason, 'Show Output')
			.then((action) => { commandOutput?.show(); });
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
		})
	});
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

	commandHistory = new CommandHistory();
	context.subscriptions.push(commandHistory);

	commandOutput = vscode.window.createOutputChannel('Shell');
	context.subscriptions.push(commandOutput);

	let shellCMD = vscode.commands.registerCommand('shell.runCommand', () => {
		if ((vscode.workspace.workspaceFolders?.length || 0) > 0) {
			execShellCMD(vscode.workspace.workspaceFolders![0].uri.fsPath);
		}
	});
	context.subscriptions.push(shellCMD);

	let cwdShellCMD = vscode.commands.registerTextEditorCommand('shell.runCommandAtFileLocation', () => {
		if (vscode.window.activeTextEditor?.document.uri.scheme !== 'file') {
			vscode.window.showErrorMessage('Current document is not a local file.');
		} else {
			execShellCMD(path.dirname(vscode.window.activeTextEditor.document.uri.fsPath));
		}
	});
	context.subscriptions.push(cwdShellCMD);

	let shellHistory = vscode.commands.registerCommand('shell.showHistory', showHistory);
	context.subscriptions.push(shellHistory);

	let shellTerm = vscode.commands.registerCommand('shell.terminateCommand', () => {
		if (process) {
			term();
		} else {
			vscode.window.showErrorMessage('No running command.');
		}
	});
	context.subscriptions.push(shellTerm);

	let shellOutput = vscode.commands.registerCommand('shell.showCommandLog', () => {
		commandOutput?.show();
	});
	context.subscriptions.push(shellOutput);
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
