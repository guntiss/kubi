import * as vscode from 'vscode';
import * as k from './kubectl';
import { DashboardPanel } from './panel';
import { ContextTreeProvider, TreeNode, isContextNode } from './tree';

export function activate(context: vscode.ExtensionContext): void {
  const tree = new ContextTreeProvider();
  const view = vscode.window.createTreeView('kubi.contexts', { treeDataProvider: tree });
  context.subscriptions.push(view);

  // Registered synchronously during activation: VS Code holds the panels it
  // restored only until activation settles, so a serializer registered after
  // an await arrives too late and the panels are dropped.
  //
  // Reaching this at all after a window reload depends on the
  // `onWebviewPanel:kubi.dashboard` activation event in package.json.
  // Restoring a webview does not activate the extension by itself: VS Code
  // brings the frame back immediately and then waits for the serializer,
  // so without that event a reloaded dashboard sits blank until something
  // else — opening the Contexts view, running a command — activates us.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer(DashboardPanel.viewType, {
      deserializeWebviewPanel: (panel, state) => DashboardPanel.revive(panel, context, state)
    })
  );

  const register = (id: string, handler: (...args: any[]) => any) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));

  register('kubi.refreshContexts', () => tree.refresh());

  // Pointing the extension at a different kubeconfig changes which contexts
  // exist, so the sidebar has to be re-read; left alone it would go on listing
  // the previous file's contexts until something else refreshed it. Open
  // dashboards are deliberately not touched: each is pinned to a named context
  // and refreshes on its own, and closing someone's tabs out from under them
  // on a settings change would be a worse surprise than a tab that errors.
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('kubi.kubeconfigPath')) tree.refresh();
    })
  );

  register('kubi.openContext', (node?: TreeNode) => {
    if (isContextNode(node)) {
      DashboardPanel.show(context, node.info.name, node.info);
    }
  });

  // Palette entry: pick a context, then open it.
  register('kubi.open', async () => {
    try {
      const contexts = await k.listContexts();
      if (contexts.length === 0) {
        vscode.window.showWarningMessage('Kubi: no contexts found in kubeconfig.');
        return;
      }
      const picked = await vscode.window.showQuickPick(
        contexts.map((c) => ({
          label: c.name,
          description: c.current ? 'current' : '',
          detail: c.cluster,
          value: c.name,
          info: c
        })),
        { placeHolder: 'Select a Kubernetes context' }
      );
      if (picked) {
        DashboardPanel.show(context, picked.value, picked.info);
      }
    } catch (err) {
      vscode.window.showErrorMessage(`Kubi: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  register('kubi.setCurrentContext', async (node?: TreeNode) => {
    if (!isContextNode(node)) {
      return;
    }
    try {
      await k.run(['config', 'use-context', node.info.name]);
      vscode.window.showInformationMessage(`Kubi: switched kubeconfig to "${node.info.name}".`);
      tree.refresh();
    } catch (err) {
      vscode.window.showErrorMessage(`Kubi: ${err instanceof Error ? err.message : String(err)}`);
    }
  });
}

export function deactivate(): void {
  // Disposables registered above handle cleanup.
}
