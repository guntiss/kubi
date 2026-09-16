import * as vscode from 'vscode';
import * as k from './kubectl';

class ContextNode {
  constructor(readonly info: k.ContextInfo) {}
}

class MessageNode {
  constructor(readonly text: string, readonly tooltip?: string) {}
}

export type TreeNode = ContextNode | MessageNode;

export function isContextNode(node: unknown): node is ContextNode {
  return node instanceof ContextNode;
}

/** Sidebar list of kubeconfig contexts; clicking one opens its dashboard. */
export class ContextTreeProvider implements vscode.TreeDataProvider<TreeNode> {
  private readonly emitter = new vscode.EventEmitter<TreeNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  refresh(): void {
    this.emitter.fire(undefined);
  }

  getTreeItem(node: TreeNode): vscode.TreeItem {
    if (node instanceof MessageNode) {
      const item = new vscode.TreeItem(node.text, vscode.TreeItemCollapsibleState.None);
      item.tooltip = node.tooltip;
      item.iconPath = new vscode.ThemeIcon('warning');
      return item;
    }

    const { info } = node;
    const item = new vscode.TreeItem(info.name, vscode.TreeItemCollapsibleState.None);
    item.contextValue = 'k8scontext';

    // Whatever kubeconfig already says; the list never probes the cluster.
    const lines = [`**${info.name}**`, '', `Cluster: ${info.cluster || 'unknown'}`, `User: ${info.user || 'unknown'}`];
    if (info.namespace) {
      lines.push(`Namespace: ${info.namespace}`);
    }
    item.tooltip = new vscode.MarkdownString(lines.join('\n\n'));

    item.command = {
      command: 'kubi.openContext',
      title: 'Open',
      arguments: [node]
    };
    return item;
  }

  async getChildren(node?: TreeNode): Promise<TreeNode[]> {
    if (node) {
      return [];
    }
    let contexts: k.ContextInfo[];
    try {
      contexts = await k.listContexts();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return [new MessageNode('Cannot read kubeconfig', message)];
    }
    if (contexts.length === 0) {
      return [new MessageNode('No contexts found', 'Check your kubeconfig.')];
    }
    // Current context first, then alphabetical.
    return [...contexts]
      .sort((a, b) => Number(b.current) - Number(a.current) || a.name.localeCompare(b.name))
      .map((info) => new ContextNode(info));
  }
}
