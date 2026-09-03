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

async function applySettings() {
  const config = vscode.workspace.getConfiguration();
  for (const [key, value] of Object.entries({ ...CLAUDE_SETTINGS, ...MOBILE_SETTINGS })) {
    try {
      await config.update(key, value, vscode.ConfigurationTarget.Global);
    } catch {
      // A setting may not exist in this build; skip rather than abort the rest.
    }
  }
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
  // stacks duplicates on every reload.
  if (!(await run('claude-vscode.editor.openLast'))) {
    await run('claude-vscode.editor.open');
  }

  // With Claude in the editor, everything around it can go: the explorer and
  // the auxiliary bar each claim roughly half the width.
  await run('workbench.action.closeSidebar');
  await run('workbench.action.closeAuxiliaryBar');
  await run('workbench.action.closePanel');
  // Single group, full width — no split leftovers.
  await run('workbench.action.joinAllGroups');
  await run('claude-vscode.focus');
}

function activate(context) {
  // Settings must land before the panel opens, or Claude starts a conversation
  // in the old permission mode.
  applySettings().then(async () => {
    await focusClaude();
    // VS Code restores its saved layout shortly after startup, at a time that
    // varies with load, so re-assert on a short schedule rather than betting on
    // a single delay.
    for (const delay of [800, 2000, 4000]) {
      setTimeout(focusClaude, delay);
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
