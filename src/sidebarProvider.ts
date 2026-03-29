import * as vscode from "vscode";
import { BUILD_TYPE_OPTIONS, BUILD_TYPE_STATE_KEY, DEPLOY_TARGET_STATE_KEY, MBED_CE_DOCS_URL, TARGET_STATE_KEY, UPLOAD_METHOD_STATE_KEY } from "./constants";
import { SidebarCommand, WorkspaceInspection } from "./types";
import { escapeHtml, getNonce, renderActionButton, renderIconButton, renderSelectOptions } from "./webviewHelpers";

type WorkspaceStateUpdater = <T>(key: string, value: T) => Promise<void>;

type SidebarDependencies = {
  inspectWorkspace: () => Promise<WorkspaceInspection>;
  updateWorkspaceState: WorkspaceStateUpdater;
  getSelectedTarget: (projectInfo?: WorkspaceInspection) => Promise<string | undefined>;
  getSelectedBuildType: () => string;
  getSelectedUploadMethod: (projectInfo?: WorkspaceInspection) => string;
  getSelectedDeployTarget: (projectInfo: WorkspaceInspection) => string;
  getIsInitializingWorkspace: () => boolean;
  getShowStartPage: () => boolean;
  getActiveOperationLabel: () => string | undefined;
};

function renderProjectSelectionPanel(statusText: string, includeBackToCurrentProject: boolean): string {
  const backAction = includeBackToCurrentProject
    ? '<button class="linklike" data-command="mbedCe.showProjectPage">Back To Current Project</button>'
    : '';

  return `
    <section class="panel panel-start">
      <h2>Project Selection</h2>
      ${renderActionButton("mbedCe.checkRequirements", "Check Requirements", "check")}
      ${renderActionButton("mbedCe.newProject", "New Project", "new")}
      ${renderActionButton("mbedCe.loadProject", "Load Project", "folder")}
      ${backAction}
      <div class="status">${escapeHtml(statusText)}</div>
    </section>
  `;
}

// The sidebar is intentionally driven by a tiny dependency bag so the UI can stay separate from extension activation.
export class MbedCeSidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly dependencies: SidebarDependencies
  ) {}

  refresh(): void {
    void this.render();
  }

  async resolveWebviewView(webviewView: vscode.WebviewView): Promise<void> {
    this.view = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        this.extensionUri,
        vscode.Uri.joinPath(this.extensionUri, "node_modules", "@vscode", "codicons", "dist")
      ]
    };
    webviewView.webview.onDidReceiveMessage(async (message: { type?: string; command?: SidebarCommand; value?: string }) => {
      await this.handleMessage(message);
    });
    await this.render();
  }

  // Webview events either forward commands or persist the current selectors back to workspace state.
  private async handleMessage(message: { type?: string; command?: SidebarCommand; value?: string }): Promise<void> {
    switch (message.type) {
      case "command":
        if (message.command) {
          await vscode.commands.executeCommand(message.command);
        }
        break;
      case "setTarget":
        if (message.value) {
          await this.dependencies.updateWorkspaceState(TARGET_STATE_KEY, message.value);
          const refreshed = await this.dependencies.inspectWorkspace();
          await this.dependencies.updateWorkspaceState(UPLOAD_METHOD_STATE_KEY, this.dependencies.getSelectedUploadMethod(refreshed));
        }
        break;
      case "setBuildType":
        if (message.value) {
          await this.dependencies.updateWorkspaceState(BUILD_TYPE_STATE_KEY, message.value);
        }
        break;
      case "setUploadMethod":
        if (message.value) {
          await this.dependencies.updateWorkspaceState(UPLOAD_METHOD_STATE_KEY, message.value);
        }
        break;
      case "setDeployTarget":
        if (message.value) {
          await this.dependencies.updateWorkspaceState(DEPLOY_TARGET_STATE_KEY, message.value);
        }
        break;
    }

    await vscode.commands.executeCommand("mbedCe.refresh");
  }

  private async render(): Promise<void> {
    if (!this.view) {
      return;
    }

    this.view.webview.html = await this.getHtml();
  }

  // The sidebar intentionally stays in one of three states: loading, start, or project workflow.
  private async getHtml(): Promise<string> {
    const nonce = getNonce();

    if (this.dependencies.getIsInitializingWorkspace()) {
      return this.wrapHtml(nonce, `
        <section class="panel panel-center">
          <div class="spinner"></div>
          <h2>Mbed CE extension loading</h2>
          <p>Please wait while the workspace is prepared.</p>
        </section>
      `);
    }

    const projectInfo = await this.dependencies.inspectWorkspace();
    const selectedTarget = await this.dependencies.getSelectedTarget(projectInfo);
    const selectedBuildType = this.dependencies.getSelectedBuildType();
    const selectedUploadMethod = this.dependencies.getSelectedUploadMethod(projectInfo);
    const selectedDeployTarget = this.dependencies.getSelectedDeployTarget(projectInfo);
    const activeOperationLabel = this.dependencies.getActiveOperationLabel();
    const actionStatus = activeOperationLabel
      ? `
        <div class="action-status action-status-busy">
          <span class="action-status-text">${escapeHtml(activeOperationLabel)}</span>
          ${renderIconButton("mbedCe.stop", "close", "Stop current action")}
        </div>`
      : `
        <div class="action-status">
          <span class="action-status-text">Ready</span>
        </div>`;

    if (!projectInfo.workspaceFolder || !projectInfo.isMbedCeProject) {
      const statusText = projectInfo.workspaceFolder ? projectInfo.summary : "No workspace folder is open.";
      return this.wrapHtml(nonce, renderProjectSelectionPanel(statusText, false));
    }

    if (this.dependencies.getShowStartPage()) {
      const statusText = `Current project: ${projectInfo.workspaceFolder.name}`;
      return this.wrapHtml(nonce, renderProjectSelectionPanel(statusText, true));
    }

    const targetOptions = renderSelectOptions(projectInfo.targets, selectedTarget);
    const buildTypeOptions = renderSelectOptions([...BUILD_TYPE_OPTIONS], selectedBuildType);
    const uploadOptions = renderSelectOptions(projectInfo.uploadMethodInfo?.available ?? ["NONE"], selectedUploadMethod);
    const deployTargetOptions = renderSelectOptions(projectInfo.deployTargets, selectedDeployTarget);
    const hasTargets = projectInfo.targets.length > 0;
    const deployTargetField = projectInfo.deployTargets.length > 1 ? `
        <label class="field">
          <span>Deploy Target</span>
          <select id="deploy-target-select">${deployTargetOptions}</select>
        </label>` : "";
    const hasDeployTarget = projectInfo.deployTargets.length > 0;
    const deployAction = hasDeployTarget ? renderActionButton("mbedCe.buildDeploy", "Deploy", "deploy") : "";
    const projectLabel = escapeHtml(projectInfo.workspaceFolder.name);
    const blockedState = !hasTargets
      ? `
        <div class="action-status action-status-blocked">
          <span class="action-status-text">No targets are currently available. Add .vscode/mbed-ce-targets.json5 or provide custom_targets.json5 or mbed-os/targets/targets.json5 so the extension can generate it.</span>
        </div>`
      : "";
    const workflowFields = hasTargets
      ? `
        <label class="field">
          <span>Board</span>
          <select id="target-select">${targetOptions}</select>
        </label>
        <label class="field">
          <span>Profile</span>
          <select id="build-type-select">${buildTypeOptions}</select>
        </label>
        <label class="field">
          <span>Upload Method</span>
          <select id="upload-method-select">${uploadOptions}</select>
        </label>${deployTargetField}
        <div class="actions">
          ${renderActionButton("mbedCe.configure", "Configure", "gear")}
          ${renderActionButton("mbedCe.cleanBuild", "Clean Build", "clean")}
          ${renderActionButton("mbedCe.build", "Build", "build")}
          ${deployAction}
        </div>`
      : "";

    return this.wrapHtml(nonce, `
      <section class="panel panel-project">
        <h2>Workflow</h2>
        ${workflowFields}
        ${blockedState}
        ${actionStatus}
        <button class="linklike" data-command="mbedCe.showStartPage">Change Project</button>
        <div class="status">Project: ${projectLabel}</div>
      </section>
    `);
  }

  // Keeping the webview markup local makes it easier to tweak UI without touching activation logic.
  private wrapHtml(nonce: string, body: string): string {
    const codiconStylesUri = this.view
      ? this.view.webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, "node_modules", "@vscode", "codicons", "dist", "codicon.css"))
      : undefined;
    const cspSource = this.view?.webview.cspSource ?? "";

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource} 'unsafe-inline'; font-src ${cspSource}; img-src ${cspSource} https: data:; script-src 'nonce-${nonce}';" />
  ${codiconStylesUri ? `<link href="${codiconStylesUri}" rel="stylesheet" />` : ""}
  <style>
    :root {
      color-scheme: light dark;
      --text: var(--vscode-foreground);
      --muted: var(--vscode-descriptionForeground);
      --button-bg: var(--vscode-button-background);
      --button-hover: var(--vscode-button-hoverBackground);
      --button-text: var(--vscode-button-foreground);
      --input-bg: var(--vscode-dropdown-background);
      --input-border: var(--vscode-dropdown-border);
      --input-text: var(--vscode-dropdown-foreground);
      --border: color-mix(in srgb, var(--vscode-panel-border) 65%, transparent);
      --status-bg: color-mix(in srgb, var(--vscode-editor-inactiveSelectionBackground) 45%, transparent);
      --status-busy-border: color-mix(in srgb, var(--vscode-button-background) 65%, var(--border));
    }
    body {
      margin: 0;
      padding: 12px;
      color: var(--text);
      font-family: var(--vscode-font-family);
      background: transparent;
      min-height: calc(100vh - 24px);
      box-sizing: border-box;
      display: flex;
      flex-direction: column;
    }
    .panel {
      display: grid;
      gap: 10px;
      align-content: start;
    }
    .panel-center {
      min-height: 180px;
      place-content: center;
      text-align: center;
    }
    .spinner {
      width: 24px;
      height: 24px;
      margin: 0 auto 8px;
      border: 3px solid color-mix(in srgb, var(--text) 20%, transparent);
      border-top-color: var(--text);
      border-radius: 999px;
      animation: spin 1s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    h2 { margin: 0; font-size: 16px; }
    p { margin: 0; color: var(--muted); }
    .status {
      font-size: 12px;
      color: var(--muted);
      padding: 4px 2px;
    }
    .action {
      width: 100%;
      padding: 10px 12px;
      border-radius: 6px;
      border: 1px solid transparent;
      font: inherit;
      cursor: pointer;
      text-align: left;
      transition: background 120ms ease;
      display: flex;
      align-items: center;
      gap: 10px;
      background: var(--button-bg);
      color: var(--button-text);
    }
    .action:hover { background: var(--button-hover); }
    .button-icon {
      width: 16px;
      height: 16px;
      flex: 0 0 16px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
    }
    .button-icon .codicon,
    .icon-button .codicon {
      font-size: 16px;
      line-height: 16px;
    }
    .button-label {
      line-height: 1.2;
    }
    .field {
      display: grid;
      gap: 6px;
      font-size: 12px;
      color: var(--muted);
    }
    .linklike {
      padding: 0;
      background: transparent;
      border: 0;
      color: var(--vscode-textLink-foreground);
      cursor: pointer;
      font: inherit;
      text-align: left;
    }
    .linklike:hover {
      color: var(--vscode-textLink-activeForeground);
      text-decoration: underline;
    }
    select {
      width: 100%;
      padding: 8px 10px;
      border-radius: 6px;
      border: 1px solid var(--input-border);
      background: var(--input-bg);
      color: var(--input-text);
      font: inherit;
    }
    .actions {
      display: grid;
      gap: 8px;
      margin-top: 4px;
    }
    .action-status {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      padding: 8px 10px;
      border-radius: 8px;
      border: 1px solid var(--border);
      background: var(--status-bg);
    }
    .action-status-busy {
      border-color: var(--status-busy-border);
    }
    .action-status-text {
      font-size: 12px;
      color: var(--text);
    }
    .icon-button {
      width: 26px;
      height: 26px;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      border-radius: 999px;
      border: 1px solid var(--border);
      background: transparent;
      color: var(--text);
      cursor: pointer;
      padding: 0;
      flex: 0 0 auto;
    }
    .icon-button:hover {
      background: color-mix(in srgb, var(--vscode-button-background) 18%, transparent);
    }
    .footer {
      margin-top: auto;
      padding-top: 10px;
      border-top: 1px solid var(--border);
    }
  </style>
</head>
<body>
  ${body}
  <div class="footer">
    <a class="linklike" href="${MBED_CE_DOCS_URL}" target="_blank" rel="noreferrer">Mbed CE Docs</a>
  </div>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    document.querySelectorAll('[data-command]').forEach((button) => {
      button.addEventListener('click', () => {
        vscode.postMessage({ type: 'command', command: button.dataset.command });
      });
    });
    const target = document.getElementById('target-select');
    if (target) target.addEventListener('change', (event) => vscode.postMessage({ type: 'setTarget', value: event.target.value }));
    const buildType = document.getElementById('build-type-select');
    if (buildType) buildType.addEventListener('change', (event) => vscode.postMessage({ type: 'setBuildType', value: event.target.value }));
    const upload = document.getElementById('upload-method-select');
    if (upload) upload.addEventListener('change', (event) => vscode.postMessage({ type: 'setUploadMethod', value: event.target.value }));
    const deployTarget = document.getElementById('deploy-target-select');
    if (deployTarget) deployTarget.addEventListener('change', (event) => vscode.postMessage({ type: 'setDeployTarget', value: event.target.value }));
  </script>
</body>
</html>`;
  }
}
