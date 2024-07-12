import * as vscode from 'vscode';
import * as path from 'path';

import { Output, exec } from './exec';

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

export class DocumentShellCommandTreeViewProvider implements vscode.TreeDataProvider<DocumentShellCommandTreeItem>,
	vscode.CodeLensProvider {
	private readonly _onDidChangeTreeData: vscode.EventEmitter<DocumentShellCommandTreeItem | undefined> = new vscode.EventEmitter<DocumentShellCommandTreeItem | undefined>();
	// eslint-disable-next-line @typescript-eslint/member-ordering
	public readonly onDidChangeTreeData: vscode.Event<DocumentShellCommandTreeItem | undefined> = this._onDidChangeTreeData.event;
	// onDidChangeCodeLenses?: vscode.Event<void> | undefined;

	private readonly _onDidChangeCodeLenses: vscode.EventEmitter<void> = new vscode.EventEmitter<void>();
	onDidChangeCodeLenses?: vscode.Event<void> | undefined = this._onDidChangeCodeLenses.event;

	private commands: DocumentShellCommand[] = [];
	private commandTreeItems: DocumentShellCommandTreeItem[] = [];

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
		this.commandTreeItems = this.commands.map(c => {
			return new DocumentShellCommandTreeItem(c.file, c.cmd, c.name, c.labelPosition);
		});
		return this.commandTreeItems;
	}

	public clear() {
		this.commands = [];
		this._onDidChangeTreeData.fire(undefined);
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

	provideCodeLenses(document: vscode.TextDocument, token: vscode.CancellationToken): vscode.ProviderResult<vscode.CodeLens[]> {
		return this.commandTreeItems.filter(c => c.file.path === document.uri.path).map(c => {
			const runCommand: vscode.Command = {
				command: 'shell.documentShellCommandView.run',
				title: 'Run',
				arguments: [
					c
				]
			};

			const copyCommand: vscode.Command = {
				command: 'shell.documentShellCommandView.copy',
				title: 'Copy',
				arguments: [
					c
				]
			};

			return [
				new vscode.CodeLens(
					new vscode.Range(c.labelPosition, c.labelPosition),
					runCommand
				),
				new vscode.CodeLens(
					new vscode.Range(c.labelPosition, c.labelPosition),
					copyCommand
				),
			]
		}).flat(1);
	}
}

export function initializeDocumentShellCommandsTreeView(context: vscode.ExtensionContext) {
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
	vscode.commands.registerCommand('shell.documentShellCommandView.clear', () =>
		treeProvider.clear()
	);
	vscode.commands.registerCommand('shell.documentShellCommandView.run', (item: DocumentShellCommandTreeItem) => {
		const output = vscode.workspace.getConfiguration().get('shell.outputTerminal') as Output;
		exec(item.cmd.join("\n"), path.dirname(item.file.fsPath), { output });
	});
	vscode.commands.registerCommand('shell.documentShellCommandView.runQueue', (item: DocumentShellCommandTreeItem) => {
		const output = vscode.workspace.getConfiguration().get('shell.outputTerminal') as Output;
		exec(item.cmd.join("\n"), path.dirname(item.file.fsPath), { output, stopPrevious: false });
		vscode.window.showInformationMessage(`Command ${item.label} queued`);
	});
	vscode.commands.registerCommand('shell.documentShellCommandView.copy', (item: DocumentShellCommandTreeItem) => {
		vscode.env.clipboard.writeText(item.cmd.join("\n"));
		vscode.window.showInformationMessage(`Command ${item.label} copied to clipboard`);
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
	context.subscriptions.push(
		vscode.languages.registerCodeLensProvider(
			{
				scheme: 'file'
			},
			treeProvider
		)
	);
}