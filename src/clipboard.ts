import * as vscode from 'vscode';
import { commandOutput } from './exec';

let clipboardHookDisposable: vscode.Disposable;

interface ClipboardItem {
	content: string;
	source: string;
}

let clipboardHistory: ClipboardItem[] = [];
let treeProvider: ClipboardHistoryTreeViewProvider | undefined;

export class ClipboardHistoryTreeItem extends vscode.TreeItem {
	public override collapsibleState = vscode.TreeItemCollapsibleState.None;
	public override contextValue = 'shell.ClipboardHistoryTreeItem';
	public override description = 'Command';
	public override iconPath = new vscode.ThemeIcon("terminal");

	constructor(
		public item: ClipboardItem,
	) {
		super(item.content);
		this.label = item.content.slice(0, 100);
		this.description = item.source.slice(0, 100);
		this.command = {
			command: 'shell.ClipboardHistoryView.show',
			title: 'Show in file',
			arguments: [
			],
		};
	}
}

export class ClipboardHistoryTreeViewProvider implements vscode.TreeDataProvider<ClipboardHistoryTreeItem> {
	private readonly _onDidChangeTreeData: vscode.EventEmitter<ClipboardHistoryTreeItem | undefined> = new vscode.EventEmitter<ClipboardHistoryTreeItem | undefined>();
	// eslint-disable-next-line @typescript-eslint/member-ordering
	public readonly onDidChangeTreeData: vscode.Event<ClipboardHistoryTreeItem | undefined> = this._onDidChangeTreeData.event;

	constructor() {
		this.refresh();
	}

	public async refresh(e?: ClipboardHistoryTreeItem): Promise<void> {
		// let uniqueFiles = new Set(this.commands.map(c => c.file));
		this._onDidChangeTreeData.fire(e);
	}

	public getTreeItem(element: ClipboardHistoryTreeItem): vscode.TreeItem {
		return element;
	}

	public getChildren(element?: ClipboardHistoryTreeItem): (ClipboardHistoryTreeItem)[] {
		if (element) {
			return [];
		}
		let copy = Array.from(clipboardHistory).reverse();
		return copy.map(item => {
			return new ClipboardHistoryTreeItem(item);
		});
	}
}

async function clipboardCopyHook(context: vscode.ExtensionContext) {
	clipboardHookDisposable.dispose();      // must dispose to avoid endless loops
	await vscode.commands.executeCommand('editor.action.clipboardCopyAction');

	const clipboardText = await vscode.env.clipboard.readText();
	// commandOutput?.appendLine(clipboardText);

	// re-register to continue intercepting copy commands
	clipboardHookDisposable = vscode.commands.registerCommand('editor.action.clipboardCopyAction', async (_arg: any) => clipboardCopyHook(context));
	context.subscriptions.push(clipboardHookDisposable);

	const filename = vscode.window.activeTextEditor?.document.fileName;
	clipboardHistory.push({ content: clipboardText, source: filename || ''  });
	treeProvider?.refresh();
}

export function initializeClipboard(context: vscode.ExtensionContext) {
	treeProvider = new ClipboardHistoryTreeViewProvider();
	context.subscriptions.push(
		vscode.window.createTreeView('shell.clipboardHistoryView', {
			treeDataProvider: treeProvider,
			showCollapseAll: true,
		})
	);

	clipboardHookDisposable = vscode.commands.registerCommand('editor.action.clipboardCopyAction', async (_arg: any) => clipboardCopyHook(context));
	context.subscriptions.push(clipboardHookDisposable);
}

export function deactivateClipboard() {
	clipboardHookDisposable.dispose();      // must dispose to avoid endless loops
}