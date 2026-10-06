import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

const RELOAD = 'Reload Window';

/**
 * Offers to reload the window once a newer Kubi has been installed under the
 * one running.
 *
 * VS Code installs an update beside the running version rather than over it:
 * this extension host keeps the old code loaded, and every open dashboard
 * keeps talking to it, until the window reloads. VS Code's own prompt for that
 * is a button in the Extensions view, which nobody looking at a dashboard is
 * going to see, so this raises it where they are looking. A reload brings the
 * dashboards back through the panel serializer, on the new version and on the
 * page each was left on.
 *
 * What is installed is read from the `extensions.json` VS Code keeps for the
 * profile, not from the version folders: an old folder lingers until the next
 * restart cleans it up, so a folder's presence says nothing, while the list
 * names the one version each extension is installed at.
 *
 * Only a newer version is offered, and each one once. An older one is a
 * deliberate downgrade, which VS Code's own prompt already covers, and if
 * this ever reads the wrong list it is better to say nothing than to nag.
 */
export function watchForUpdate(context: vscode.ExtensionContext): vscode.Disposable {
  // A development host runs the working tree, which no install replaces.
  if (context.extensionMode !== vscode.ExtensionMode.Production) {
    return new vscode.Disposable(() => undefined);
  }
  const list = installedList(context);
  const id = context.extension.id.toLowerCase();
  /** The newest version known about: the running one, then each one offered. */
  let offered = String(context.extension.packageJSON.version ?? '');
  let timer: NodeJS.Timeout | undefined;

  const check = async (): Promise<void> => {
    const installed = await installedVersion(list, id);
    if (!installed || compareVersions(installed, offered) <= 0) {
      return;
    }
    offered = installed;
    const choice = await vscode.window.showInformationMessage(
      `Kubi ${installed} has been installed. Reload the window to start using it.`,
      RELOAD
    );
    if (choice === RELOAD) {
      await vscode.commands.executeCommand('workbench.action.reloadWindow');
    }
  };

  // The directory rather than the file: VS Code may replace the list rather
  // than write into it, which would leave a watch on the old file deaf.
  // Changes come in bursts while an install writes, so they are let settle.
  let watcher: fs.FSWatcher | undefined;
  try {
    watcher = fs.watch(path.dirname(list), (_event, file) => {
      if (file && file.toString() !== path.basename(list)) {
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => void check(), 1000);
    });
    // Losing the watch only loses the prompt; nothing else depends on it.
    watcher.on('error', () => watcher?.close());
  } catch {
    // No such directory: an install layout this does not know. Stay quiet.
  }
  // An update installed before Kubi activated in this window still left the
  // old version to run.
  void check();

  return new vscode.Disposable(() => {
    clearTimeout(timer);
    watcher?.close();
  });
}

/**
 * The `extensions.json` that lists this profile's extensions. A profile with
 * extensions of its own keeps its list in its own folder, beside its global
 * storage; the default profile, and any profile sharing its extensions, use
 * the one in the extensions directory, beside this extension's own folder.
 */
function installedList(context: vscode.ExtensionContext): string {
  const profile = path.dirname(path.dirname(context.globalStorageUri.fsPath));
  const own = path.join(profile, 'extensions.json');
  return fs.existsSync(own) ? own : path.join(path.dirname(context.extensionPath), 'extensions.json');
}

/** The version `list` says extension `id` is installed at, if it can tell. */
async function installedVersion(list: string, id: string): Promise<string | undefined> {
  try {
    const entries: unknown = JSON.parse(await fs.promises.readFile(list, 'utf8'));
    if (!Array.isArray(entries)) {
      return undefined;
    }
    const entry = entries.find((e) => String(e?.identifier?.id ?? '').toLowerCase() === id);
    return typeof entry?.version === 'string' ? entry.version : undefined;
  } catch {
    // Caught mid-write, or not there at all. A write in progress ends in
    // another change, which reads it again.
    return undefined;
  }
}

/** Orders two `major.minor.patch` versions; anything after the patch is ignored. */
function compareVersions(a: string, b: string): number {
  const parts = (v: string) => v.split(/[.+-]/).slice(0, 3).map((n) => Number.parseInt(n, 10) || 0);
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    if ((x[i] ?? 0) !== (y[i] ?? 0)) {
      return (x[i] ?? 0) - (y[i] ?? 0);
    }
  }
  return 0;
}
