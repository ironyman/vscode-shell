import * as vscode from 'vscode';
import { commandOutput } from './exec';
import RingBuffer from 'ringbufferjs';

let clipboardHookDisposable: vscode.Disposable;

interface ClipboardItem {
	content: string;
	source: string;
}

const CLIPBOARD_HISTORY_ITEMS_NR = 99
let clipboardHistory = new RingBuffer(CLIPBOARD_HISTORY_ITEMS_NR);
let treeProvider: ClipboardHistoryTreeViewProvider | undefined;

export class ClipboardHistoryTreeItem extends vscode.TreeItem {
	public override collapsibleState = vscode.TreeItemCollapsibleState.None;
	public override contextValue = 'shell.clipboardHistoryTreeItem';
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

		let copy = Array.from(clipboardHistory.peekN(clipboardHistory.size())).reverse() as ClipboardItem[];
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
	clipboardHistory.enq({ content: clipboardText, source: filename || ''  });
	treeProvider?.refresh();
}

export function initializeClipboard(context: vscode.ExtensionContext) {
	// Need to add this to package.json if you want to renable this.
			// "contributes": {
			// "views": {
			// "explorer": [
			// {
			// 	"id": "shell.clipboardHistoryView",
			// 	"name": "Clipboard"
			// }
	treeProvider = new ClipboardHistoryTreeViewProvider();
	context.subscriptions.push(
		vscode.window.createTreeView('shell.clipboardHistoryView', {
			treeDataProvider: treeProvider,
			showCollapseAll: true,
		})
	);

	clipboardHookDisposable = vscode.commands.registerCommand('editor.action.clipboardCopyAction', async (_arg: any) => clipboardCopyHook(context));
	context.subscriptions.push(clipboardHookDisposable);

	vscode.commands.registerCommand('shell.clipboardHistoryView.refresh', () =>
		treeProvider?.refresh()
	);
	vscode.commands.registerCommand('shell.clipboardHistoryView.clear', () => {
		clipboardHistory.deqN(clipboardHistory.size());
		treeProvider?.refresh();
	});

	vscode.commands.registerTextEditorCommand('shell.clipboardHistoryView.paste',
		(textEditor: vscode.TextEditor, edit: vscode.TextEditorEdit, item: ClipboardHistoryTreeItem, ...args: any[]) => {
			const pasteStart = textEditor.selection.start;

			textEditor.edit((editor) => {
				editor.delete(textEditor.selection);    // Delete anything currently selected
				editor.insert(textEditor.selection.start, item.item.content);
			}).then(() => {
				// This would work if you used editor.action.clipboardPasteAction
				// const pasteEnd = textEditor.selection.end;
				const pasteEnd = textEditor.document.positionAt(textEditor.document.offsetAt(pasteStart) + item.item.content.length);
				textEditor.selection = new vscode.Selection(pasteStart.line, pasteStart.character, pasteEnd.line, pasteEnd.character);
				vscode.commands.executeCommand('editor.action.formatSelection').then(() => {
					textEditor.selection = new vscode.Selection(pasteEnd.line, pasteEnd.character, pasteEnd.line, pasteEnd.character);
				});
			});
		}
	);

	vscode.commands.registerCommand('shell.clipboardHistoryView.delete', () => {
		clipboardHistory.deqN(clipboardHistory.size());
		treeProvider?.refresh();
	});
	vscode.commands.registerCommand('shell.clipboardHistoryView.edit', () => {
		clipboardHistory.deqN(clipboardHistory.size());
		treeProvider?.refresh();
	});
}

export function deactivateClipboard() {
	clipboardHookDisposable.dispose();      // must dispose to avoid endless loops
}