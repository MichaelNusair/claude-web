const vscode = require('vscode');

/**
 * Makes code-server usable on a phone while running the *real* Claude Code
 * extension UI.
 *
 * The extension's own webview is a proprietary bundle, so it can't be
 * reimplemented — but it doesn't need to be. It's already installed here. What
 * makes VS Code unusable on a 6-inch screen is the surrounding chrome:
 * activity bar, side bar, status bar, tabs, minimap. This strips all of that and
 * puts the Claude panel front and centre, so the phone shows the genuine
 * interface — real diffs, real tool cards — and nothing else.
 *
 * Everything here drives documented VS Code APIs (settings + built-in commands);
 * nothing reaches into the Claude extension's internals.
 */

/**
 * The Claude Code extension's own VS Code settings, taken from the keys it
 * declares in `contributes.configuration` — the supported way to preconfigure
 * it. (Note there are two systems: these `claudeCode.*` VS Code settings, and
 * the CLI's separate ~/.claude/settings.json. Permission mode is here.)
 *
 * This is a single-user personal instance, so bypass mode is the default and
 * the confirmation gate is opened — on a phone that dialog is a dead end.
 */
const CLAUDE_SETTINGS = {
  // Both are required: the second permits the mode, the first selects it.
  'claudeCode.allowDangerouslySkipPermissions': true,
  'claudeCode.initialPermissionMode': 'bypassPermissions',
  // Note: `preferredLocation` only accepts 'sidebar' | 'panel', and both are
  // narrow strips on a phone. Deliberately left unset — the shell opens Claude
  // in the editor area via `claude-vscode.editor.open` instead, which gets the
  // full viewport.
  'claudeCode.hideOnboarding': true,
  'claudeCode.disableLoginPrompt': true,
  'claudeCode.autosave': true,
  // Enter sends; a phone keyboard's return key should submit, not newline.
  'claudeCode.useCtrlEnterToSend': false,
};

/** Settings that make the editor feel like an app rather than an IDE. */
const MOBILE_SETTINGS = {
  // VS Code 1.131 ships its own AI chat ("Ask about your code" / "Set BYOK")
  // *in the workbench core*, not just in the bundled Copilot extension — so
  // removing that extension isn't enough; the pane still renders and claims the
  // secondary side bar where Claude should be. This single setting turns the
  // whole built-in AI surface off.
  'chat.disableAIFeatures': true,
  'chat.commandCenter.enabled': false,
  'chat.agent.enabled': false,
  'chat.experimental.offerSetup': false,
  'chat.setupFromDialog': false,
  'github.copilot.enable': { '*': false },
  // Keep the secondary side bar shut; it's where the built-in chat appears.
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'workbench.secondarySideBar.showLabels': false,
  // Sidebar and secondary bar must stay shut; on a phone either one halves the
  // usable width.
  'workbench.sideBar.location': 'left',
  'workbench.panel.defaultLocation': 'right',
  'workbench.view.alwaysShowHeaderActions': false,
  'workbench.activityBar.location': 'hidden',
  'workbench.statusBar.visible': false,
  'workbench.editor.showTabs': 'none',
  'workbench.editor.editorActionsLocation': 'hidden',
  'workbench.layoutControl.enabled': false,
  'workbench.tips.enabled': false,
  // Modal-ish prompts are unusable on a phone and block the view.
  'extensions.ignoreRecommendations': true,
  'extensions.showRecommendationsOnlyOnDemand': true,
  'workbench.welcomePage.walkthroughs.openOnInstall': false,
  'update.showReleaseNotes': false,
  'git.openRepositoryInParentFolders': 'never',
  'workbench.startupEditor': 'none',
  'editor.minimap.enabled': false,
  'editor.lineNumbers': 'off',
  'editor.glyphMargin': false,
  'editor.folding': false,
  'editor.renderLineHighlight': 'none',
  'editor.occurrencesHighlight': 'off',
  'editor.selectionHighlight': false,
  'editor.overviewRulerBorder': false,
  'editor.hideCursorInOverviewRuler': true,
  'editor.scrollbar.vertical': 'auto',
  // Touch targets and readability.
  'editor.fontSize': 15,
  'editor.lineHeight': 1.6,
  'terminal.integrated.fontSize': 13,
  'window.menuBarVisibility': 'hidden',
  'breadcrumbs.enabled': false,
  'zenMode.hideLineNumbers': true,
  // Trust prompts are unusable on a phone and pointless for your own repos.
  'security.workspace.trust.enabled': false,
};

/**
 * Write the settings that are not already what we want, and nothing else.
 *
 * Every one of these is global, so after the first activation they are all
 * already set — and writing a setting is not free: each `update()` rewrites
 * settings.json and fires a configuration-change event through the whole
 * workbench, which on this surface means ~45 rounds of relayout while the window
 * is still starting. Skipping the no-ops makes the second and every later load
 * write nothing at all.
 */
async function applySettings() {
  const config = vscode.workspace.getConfiguration();
  let written = 0;
  for (const [key, value] of Object.entries({ ...CLAUDE_SETTINGS, ...MOBILE_SETTINGS })) {
    try {
      // Compare against the *global* value specifically: matching the effective
      // value would skip keys that only look right because a workspace or a
      // default is currently supplying them.
      if (JSON.stringify(config.inspect(key)?.globalValue) === JSON.stringify(value)) continue;
      await config.update(key, value, vscode.ConfigurationTarget.Global);
      written += 1;
    } catch {
      // A setting may not exist in this build; skip rather than abort the rest.
    }
  }
  return written;
}

const run = async (command, ...args) => {
  try {
    await vscode.commands.executeCommand(command, ...args);
    return true;
  } catch {
    return false; // command unavailable in this build
  }
};

/**
 * Tab kinds that are safe to close when the layout has to be rescued.
 *
 * Deliberately an allowlist of *file* tabs rather than "everything that isn't
 * Claude". The Claude panel is a webview, and closing a webview disposes it —
 * which on this surface ends the conversation running inside it. Misjudging in
 * this direction leaves a file open, which is merely untidy; misjudging in the
 * other direction throws away work. So the uncertainty is spent where it costs
 * least, and files and diffs are exactly what Claude opens at you anyway.
 *
 * The classes are probed rather than assumed: an older build that lacks one
 * would otherwise throw on the `instanceof` and take the whole rescue with it.
 */
const FILE_TAB_KINDS = [
  'TabInputText',
  'TabInputTextDiff',
  'TabInputTextMultiDiff',
  'TabInputNotebook',
  'TabInputNotebookDiff',
];

function isFileTab(tab) {
  return FILE_TAB_KINDS.some((name) => vscode[name] && tab.input instanceof vscode[name]);
}

/**
 * The Claude panel's own tab.
 *
 * It is a webview, and the API reports webview tabs by `viewType` — which VS Code
 * namespaces internally (`mainThreadWebview-claudeVSCodePanel`), so this matches
 * loosely rather than on an exact id, and falls back to the tab's label for a
 * build that reports the type differently.
 */
function isClaudeTab(tab) {
  const type = vscode.TabInputWebview && tab.input instanceof vscode.TabInputWebview
    ? String(tab.input.viewType)
    : '';
  return /claude/i.test(type) || /claude/i.test(String(tab.label));
}

/**
 * Is the window already showing what the rescue would produce?
 *
 * This is the gate that keeps the startup schedule from being a nuisance. The
 * layout commands are not free and not invisible: `joinAllGroups` moves editors
 * between groups, and moving a webview re-parents its iframe, which re-creates
 * the Claude panel and discards whatever was typed into it and not sent. Running
 * them once is a rescue; running them every second on a window that is already
 * fine is the flicker-and-lose-my-message bug.
 *
 * So the check is deliberately conservative — one group, Claude in front, no
 * files — and everything it cannot see (side bar, panel, activity bar) is left to
 * the single unconditional pass at activation, when there is nothing to lose.
 */
function layoutIsSettled() {
  const groups = vscode.window.tabGroups.all;
  if (groups.length !== 1) return false;
  const { tabs, activeTab } = groups[0];
  if (!activeTab || !isClaudeTab(activeTab)) return false;
  return !tabs.some(isFileTab);
}

/**
 * Close the files and diffs cluttering the editor area.
 *
 * Dirty tabs are left alone on purpose. Closing one raises a modal save prompt,
 * and a modal is a dead end on a phone — the thing this whole extension exists
 * to avoid. Unsaved work also deserves better than being swept up by a layout
 * button. Say what was skipped instead, and let "Show tabs & bars" handle it.
 *
 * `notify` is off for the startup passes, which re-check as the workbench
 * settles: nobody asked for those, and a warning about the same file each time is
 * worse than none.
 */
async function closeFileTabs(notify) {
  const files = vscode.window.tabGroups.all.flatMap((g) => g.tabs).filter(isFileTab);
  const closable = files.filter((t) => !t.isDirty);
  const dirty = files.length - closable.length;

  if (closable.length) {
    try {
      // preserveFocus: focusClaude() decides where focus lands, a moment later.
      await vscode.window.tabGroups.close(closable, true);
    } catch {
      // A tab that refuses to close is not a reason to skip the refocus below.
    }
  }
  if (dirty && notify) {
    vscode.window.showWarningMessage(
      `Left ${dirty} unsaved file${dirty === 1 ? '' : 's'} open. Save or discard, then try again.`,
    );
  }
  return closable.length;
}

/**
 * Put the real Claude Code UI in the center of the screen, alone.
 *
 * Order matters: open Claude first so it becomes the active editor, *then*
 * collapse the surrounding panels. Closing them first lets VS Code restore
 * layout when the new editor opens, which is why the panel kept ending up
 * off-center or hidden.
 */
async function focusClaude() {
  // Open Claude in the *editor area* rather than a side bar. On a phone the
  // side bars are narrow strips (text wraps a letter per line), and hiding them
  // to reclaim width would hide Claude along with them. The editor area is the
  // full viewport, so this avoids the tradeoff entirely.
  //
  // `openLast` reuses the existing tab; `open` always adds another, which
  // stacks duplicates on every reload. Skipped entirely when the panel is
  // already open — VS Code restores it across a reload, and asking for it again
  // is what used to make it flash.
  if (!vscode.window.tabGroups.all.some((g) => g.tabs.some(isClaudeTab))) {
    if (!(await run('claude-vscode.editor.openLast'))) {
      await run('claude-vscode.editor.open');
    }
  }

  // With Claude in the editor, everything around it can go: the explorer and
  // the auxiliary bar each claim roughly half the width. These are idempotent —
  // "close", not "toggle" — so they cost nothing when already shut.
  await run('workbench.action.closeSidebar');
  await run('workbench.action.closeAuxiliaryBar');
  await run('workbench.action.closePanel');
  // Single group, full width — no split leftovers. Only when there is actually
  // something to join: this command moves editors between groups, and moving a
  // webview re-creates it, taking an unsent message with it.
  if (vscode.window.tabGroups.all.length > 1) {
    await run('workbench.action.joinAllGroups');
  }
  await run('claude-vscode.focus');
}

/**
 * The escape hatch: close the files, give the whole window back to Claude.
 *
 * Tapping a file in the transcript opens it in the editor area, and with tabs,
 * the activity bar and the status bar all hidden there is then nothing on screen
 * that closes it again — the panel is squeezed into whatever width is left, for
 * good. Reaching this from a phone is what `claudeMobile.backToClaude` is for;
 * the overlay's Layout button triggers it through the keybinding below.
 */
async function backToClaude(notify) {
  await closeFileTabs(notify);
  await focusClaude();
}

/** The shell this extension opened, while it is still alive. */
let mobileTerminal = null;
// Named, not left to default to the shell's own name, so a terminal restored
// after a reload can be recognised as the one this button opened.
const TERMINAL_NAME = 'Terminal';

const isTerminalTab = (tab) =>
  Boolean(vscode.TabInputTerminal) && tab.input instanceof vscode.TabInputTerminal;

/**
 * A shell, on a surface with no status bar to open one from.
 *
 * In the **editor area**, not the panel: `workbench.panel.defaultLocation` is
 * `right` here, so a panel terminal is a narrow column beside Claude — fine on a
 * desktop, useless on a phone, where the soft keyboard then takes half of what is
 * left. An editor terminal gets the whole window, exactly like Claude does, and
 * with tabs hidden the two simply take turns.
 *
 * One button, both directions: pressing it while the terminal is in front is how
 * you get back, so the phone does not need a second control for that. Terminals
 * are shown rather than created wherever possible — code-server keeps shells
 * running across a page reload while the extension host does not, so creating one
 * per press would stack a new shell on every reload and leave the old ones
 * running.
 *
 * Note what this deliberately is not: it is not `cc`. A shell in the editor dies
 * with its tab; long work still belongs in tmux (see `scripts/cc-session.sh`).
 */
async function toggleTerminal() {
  const active = vscode.window.tabGroups.activeTabGroup?.activeTab;
  if (active && isTerminalTab(active)) {
    await focusClaude();
    return;
  }
  if (mobileTerminal && vscode.window.terminals.includes(mobileTerminal)) {
    mobileTerminal.show();
    return;
  }
  mobileTerminal = vscode.window.terminals.find((t) => t.name === TERMINAL_NAME)
    || vscode.window.createTerminal({
      name: TERMINAL_NAME,
      // Probed: an older build without editor terminals gets a panel one, which
      // is worse but still a shell.
      location: vscode.TerminalLocation ? vscode.TerminalLocation.Editor : undefined,
    });
  mobileTerminal.show();
}

function activate(context) {
  // Settings must land before the panel opens, or Claude starts a conversation
  // in the old permission mode.
  applySettings().then(async () => {
    /*
     * Reloading the page is the one recovery that is always available on a
     * phone, and restored editors are what stopped it working: VS Code brings
     * back the file that wedged the layout, so the reload changed nothing and
     * the editor stayed stuck until someone reached the box. Clearing them here
     * makes a refresh mean what the user expects.
     *
     * Nothing in the first few seconds of a cold workbench was opened by hand,
     * so there is nothing of the user's to lose in this window. Someone who
     * wants their restored tabs back — at a desk, using this as an IDE — turns
     * `claudeMobile.closeFilesOnStartup` off.
     */
    const closeFiles = vscode.workspace
      .getConfiguration()
      .get('claudeMobile.closeFilesOnStartup', true);
    // Silent: the warning about unsaved files belongs to the button, not to a
    // pass the user never asked for.
    const rescue = () => (closeFiles ? backToClaude(false) : focusClaude());

    // One unconditional pass, at the only moment when nothing on screen can
    // belong to the user yet: this is also the only pass that can shut the side
    // bar and the panel, since the API reports neither.
    await rescue();
    // VS Code restores its saved layout shortly after startup, at a time that
    // varies with load, so keep watching for a few seconds rather than betting on
    // a single delay — but only act when the layout is actually wrong. Re-running
    // the sequence regardless, which is what this used to do, re-created the
    // Claude panel up to four times per load: the view visibly refreshing a few
    // times after picking a project, and a message typed in between silently
    // gone.
    for (const delay of [800, 2000, 4000]) {
      setTimeout(() => {
        if (!layoutIsSettled()) rescue();
      }, delay);
    }
    // Last resort: if nothing is showing after everything has settled, the
    // layout ended up in a state that hides Claude. Reopen the side bar so the
    // screen is never blank — a visible explorer beats a gray void.
    setTimeout(async () => {
      if (!vscode.window.tabGroups.all.some((g) => g.tabs.length > 0)) {
        await run('workbench.action.focusSideBar');
        vscode.window.showWarningMessage(
          'Claude panel did not open. Run "Mobile: Open Claude full screen" to retry.',
        );
      }
    }, 9000);
  });

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeMobile.focusClaude', focusClaude),
    // Asked for by hand, so this one reports what it had to skip.
    vscode.commands.registerCommand('claudeMobile.backToClaude', () => backToClaude(true)),
    vscode.commands.registerCommand('claudeMobile.toggleTerminal', toggleTerminal),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('claudeMobile.toggleChrome', async () => {
      const config = vscode.workspace.getConfiguration();
      const hidden = config.get('workbench.activityBar.location') === 'hidden';
      const target = vscode.ConfigurationTarget.Global;
      await config.update('workbench.activityBar.location', hidden ? 'default' : 'hidden', target);
      await config.update('workbench.statusBar.visible', hidden, target);
      await config.update('workbench.editor.showTabs', hidden ? 'multiple' : 'none', target);
      vscode.window.showInformationMessage(
        hidden ? 'Editor chrome shown' : 'Editor chrome hidden',
      );
    }),
  );
}

function deactivate() {}

module.exports = { activate, deactivate };
