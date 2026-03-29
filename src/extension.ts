import * as vscode from "vscode";
import * as path from "path";

import {
  BUILD_TYPE_STATE_KEY,
  CPPTOOLS_CONFIGURATION_PROVIDER_ID,
  DEPLOY_TARGET_STATE_KEY,
  REVEAL_SIDEBAR_AFTER_PROJECT_OPEN_STATE_KEY,
  TARGET_STATE_KEY,
  UPLOAD_METHOD_STATE_KEY
} from "./constants";
import { ProjectAction, RunningExecution, WorkspaceInspection } from "./types";
import { CppToolsProviderHandle, registerCppToolsProvider } from "./cppToolsProvider";
import { createNewProject, loadProject } from "./projectCommands";
import { checkRequirementsCommand } from "./requirements";
import {
  resolveSelectedBuildType,
  resolveSelectedTarget,
  resolveSelectedUploadMethod,
  selectBuildTypeCommand,
  selectTargetCommand,
  selectUploadMethodCommand
} from "./selectionState";
import { MbedCeSidebarProvider } from "./sidebarProvider";
import { initializeWorkspace as initializeWorkspaceFlow } from "./workspaceLifecycle";
import { runProjectAction } from "./workflowActions";
import { getSelectedDeployTarget as resolveSelectedDeployTarget, inspectWorkspace as inspectWorkspaceDetails } from "./workspaceProject";

// Shared extension state stays here so the smaller workflow modules can stay mostly pure.
let extensionContext: vscode.ExtensionContext | undefined;
let activeOperationLabel: string | undefined;
let currentTaskExecution: RunningExecution | undefined;
let stopRequested = false;
let requirementsOutputChannel: vscode.OutputChannel | undefined;
let extensionLogChannel: vscode.OutputChannel | undefined;
let statusBarItems: vscode.StatusBarItem[] = [];
let stopStatusBarItem: vscode.StatusBarItem | undefined;
let isInitializingWorkspace = true;
let showStartPage = false;
let workspaceInitializationPromise: Promise<void> | undefined;
let cppToolsProviderHandle: CppToolsProviderHandle = { hasActiveConfiguration: async () => false, refresh: async () => undefined, dispose: () => undefined };
const FULL_REINITIALIZATION_SETTINGS = [
  "mbedCe.projectRootPath",
  "mbedCe.mbedOsPath",
  "mbedCe.customTargetsPath"
] as const;
const REFRESH_ONLY_SETTINGS = [
  "mbedCe.buildDirectory",
  "mbedCe.defaultBuildType",
  "mbedCe.configureCommand",
  "mbedCe.buildCommand",
  "mbedCe.deployCommand"
] as const;

export function activate(context: vscode.ExtensionContext): void {
  extensionLogChannel = vscode.window.createOutputChannel("Mbed CE");
  statusBarItems = createStatusBarItems();
  stopStatusBarItem = createStopStatusBarItem();
  context.subscriptions.push(...statusBarItems);
  if (stopStatusBarItem) {
    context.subscriptions.push(stopStatusBarItem);
  }
  context.subscriptions.push(extensionLogChannel);
  extensionLogChannel.appendLine("Activating Mbed CE extension.");

  try {
    extensionContext = context;
    const sidebarProvider = new MbedCeSidebarProvider(context.extensionUri, {
      inspectWorkspace,
      updateWorkspaceState,
      getSelectedTarget,
      getSelectedBuildType,
      getSelectedUploadMethod,
      getSelectedDeployTarget,
      getIsInitializingWorkspace: () => isInitializingWorkspace,
      getShowStartPage: () => showStartPage,
      getActiveOperationLabel: () => activeOperationLabel
    });
    const refreshExtensionUi = (): void => {
      sidebarProvider.refresh();
      void updateStatusBarItems();
      void cppToolsProviderHandle.refresh().then(async () => {
        await syncCppToolsConfigurationProvider();
      });
    };

    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider("mbedCe.sidebar", sidebarProvider),
      vscode.commands.registerCommand("mbedCe.refresh", () => refreshExtensionUi()),
      vscode.commands.registerCommand("mbedCe.newProject", async () => { showStartPage = false; await createNewProject(queueSidebarRevealAfterProjectOpen); refreshExtensionUi(); }),
      vscode.commands.registerCommand("mbedCe.loadProject", async () => { showStartPage = false; await loadProject(queueSidebarRevealAfterProjectOpen); refreshExtensionUi(); }),
      vscode.commands.registerCommand("mbedCe.showStartPage", () => { showStartPage = true; sidebarProvider.refresh(); }),
      vscode.commands.registerCommand("mbedCe.showProjectPage", () => { showStartPage = false; sidebarProvider.refresh(); }),
      vscode.commands.registerCommand("mbedCe.checkRequirements", async () => { await checkRequirements(); refreshExtensionUi(); }),
      vscode.commands.registerCommand("mbedCe.selectTarget", async () => { await selectTarget(); refreshExtensionUi(); }),
      vscode.commands.registerCommand("mbedCe.selectBuildType", async () => { await selectBuildType(); refreshExtensionUi(); }),
      vscode.commands.registerCommand("mbedCe.selectUploadMethod", async () => { await selectUploadMethod(); refreshExtensionUi(); }),
      vscode.commands.registerCommand("mbedCe.configure", async () => { await runAction("configure", refreshExtensionUi); refreshExtensionUi(); }),
      vscode.commands.registerCommand("mbedCe.cleanBuild", async () => { await runAction("cleanBuild", refreshExtensionUi); refreshExtensionUi(); }),
      vscode.commands.registerCommand("mbedCe.build", async () => { await runAction("build", refreshExtensionUi); refreshExtensionUi(); }),
      vscode.commands.registerCommand("mbedCe.buildDeploy", async () => { await runAction("buildDeploy", refreshExtensionUi); refreshExtensionUi(); }),
      vscode.commands.registerCommand("mbedCe.stop", async () => {
        await stopActiveAction();
        refreshExtensionUi();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(async () => {
        isInitializingWorkspace = true;
        sidebarProvider.refresh();
        await initializeWorkspace();
        isInitializingWorkspace = false;
        refreshExtensionUi();
      }),
      vscode.workspace.onDidChangeConfiguration(async (event) => {
        if (event.affectsConfiguration("mbedCe.manageCppToolsProvider")) {
          await syncCppToolsConfigurationProvider();
          refreshExtensionUi();
          return;
        }

        if (FULL_REINITIALIZATION_SETTINGS.some((setting) => event.affectsConfiguration(setting))) {
          isInitializingWorkspace = true;
          refreshExtensionUi();
          await initializeWorkspace();
          isInitializingWorkspace = false;
          refreshExtensionUi();
          return;
        }

        if (REFRESH_ONLY_SETTINGS.some((setting) => event.affectsConfiguration(setting))) {
          refreshExtensionUi();
        }
      }),
      vscode.workspace.onDidSaveTextDocument(async (document) => {
        if (!shouldRefreshForSavedDocument(document)) {
          return;
        }
        refreshExtensionUi();
      })
    );

    extensionLogChannel.appendLine("Webview provider registered.");

    void registerCppToolsProvider({
      inspectWorkspace,
      getSelectedTarget,
      getSelectedBuildType,
      getSelectedUploadMethod
    }).then(async (handle) => {
      cppToolsProviderHandle = handle;
      context.subscriptions.push({ dispose: () => handle.dispose() });
      await handle.refresh();
      await syncCppToolsConfigurationProvider();
    });

    void initializeWorkspace()
      .catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        extensionLogChannel?.appendLine(`Workspace initialization failed: ${message}`);
        void vscode.window.showErrorMessage(`Mbed CE initialization failed: ${message}`);
      })
      .finally(() => {
        isInitializingWorkspace = false;
        refreshExtensionUi();
        void maybeRevealSidebarAfterProjectOpen();
      });
  } catch (error) {
    const message = error instanceof Error ? error.stack ?? error.message : String(error);
    extensionLogChannel.appendLine(`Activation failed: ${message}`);
    void vscode.window.showErrorMessage("Mbed CE activation failed. Check the 'Mbed CE' output channel for details.");
    throw error;
  }
}

export function deactivate(): void {}

function createStatusBarItems(): vscode.StatusBarItem[] {
  const statusBarSpecs = [
    { text: "$(gear) Configure", command: "mbedCe.configure", tooltip: "Configure Mbed CE project", priority: -101 },
    { text: "$(trash) Clean", command: "mbedCe.cleanBuild", tooltip: "Clean build Mbed CE project", priority: -102 },
    { text: "$(build) Build", command: "mbedCe.build", tooltip: "Build Mbed CE project", priority: -103 },
    { text: "$(download) Deploy", command: "mbedCe.buildDeploy", tooltip: "Build and deploy Mbed CE project", priority: -104 }
  ] as const;

  return statusBarSpecs.map((spec) => {
    const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, spec.priority);
    item.name = "Mbed CE: " + spec.tooltip;
    item.text = spec.text;
    item.command = spec.command;
    item.tooltip = spec.tooltip;
    return item;
  });
}

function createStopStatusBarItem(): vscode.StatusBarItem {
  const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, -105);
  item.name = "Mbed CE: Stop current action";
  item.text = "$(debug-stop) Stop";
  item.command = "mbedCe.stop";
  item.tooltip = "Stop the running Mbed CE action";
  item.hide();
  return item;
}

function updateStatusBarVisibility(item: vscode.StatusBarItem, shouldShow: boolean): void {
  if (shouldShow) {
    item.show();
  } else {
    item.hide();
  }
}

async function updateStatusBarItems(): Promise<void> {
  if (statusBarItems.length === 0) {
    return;
  }

  const projectInfo = await inspectWorkspace();
  const shouldShow = !!projectInfo.workspaceFolder && projectInfo.isMbedCeProject && projectInfo.targets.length > 0;
  const hasDeployTarget = projectInfo.deployTargets.length > 0;

  for (const item of statusBarItems) {
    const itemShouldShow = shouldShow && (item.command !== "mbedCe.buildDeploy" || hasDeployTarget);
    updateStatusBarVisibility(item, itemShouldShow);
  }

  if (stopStatusBarItem) {
    updateStatusBarVisibility(stopStatusBarItem, shouldShow && !!activeOperationLabel);
  }
}

// Workspace initialization repairs path-based settings before later parsing/build actions rely on them.
async function initializeWorkspace(): Promise<void> {
  if (!extensionContext) {
    return;
  }

  if (workspaceInitializationPromise) {
    await workspaceInitializationPromise;
    return;
  }

  workspaceInitializationPromise = initializeWorkspaceFlow(inspectWorkspace, extensionContext)
    .then(async () => {
      await syncCppToolsConfigurationProvider();
    })
    .finally(() => {
      workspaceInitializationPromise = undefined;
    });

  await workspaceInitializationPromise;
}

async function queueSidebarRevealAfterProjectOpen(): Promise<void> {
  if (!extensionContext) {
    return;
  }

  const shouldReveal = vscode.workspace.getConfiguration("mbedCe").get<boolean>("revealViewAfterProjectOpen", false);
  if (!shouldReveal) {
    return;
  }

  await extensionContext.globalState.update(REVEAL_SIDEBAR_AFTER_PROJECT_OPEN_STATE_KEY, true);
}

async function maybeRevealSidebarAfterProjectOpen(): Promise<void> {
  if (!extensionContext?.globalState.get<boolean>(REVEAL_SIDEBAR_AFTER_PROJECT_OPEN_STATE_KEY)) {
    return;
  }

  await extensionContext.globalState.update(REVEAL_SIDEBAR_AFTER_PROJECT_OPEN_STATE_KEY, false);
  await vscode.commands.executeCommand("workbench.view.extension.mbedCe");
}

async function inspectWorkspace(): Promise<WorkspaceInspection> {
  return await inspectWorkspaceDetails(
    getWorkspaceState<string>(TARGET_STATE_KEY),
    getWorkspaceState<string>(BUILD_TYPE_STATE_KEY),
    getWorkspaceState<string>(UPLOAD_METHOD_STATE_KEY)
  );
}

function getSelectedDeployTarget(projectInfo: WorkspaceInspection): string {
  return resolveSelectedDeployTarget(projectInfo, getWorkspaceState<string>(DEPLOY_TARGET_STATE_KEY));
}

async function checkRequirements(): Promise<void> {
  await checkRequirementsCommand(getRequirementsOutputChannel());
}

async function selectTarget(): Promise<void> {
  await selectTargetCommand(inspectWorkspace, updateWorkspaceState, getSelectedUploadMethod);
}

async function selectBuildType(): Promise<void> {
  await selectBuildTypeCommand(updateWorkspaceState);
}

async function selectUploadMethod(): Promise<void> {
  await selectUploadMethodCommand(inspectWorkspace, updateWorkspaceState);
}

async function getSelectedTarget(projectInfo?: WorkspaceInspection): Promise<string | undefined> {
  const info = projectInfo ?? (await inspectWorkspace());
  return resolveSelectedTarget(info, getWorkspaceState<string>(TARGET_STATE_KEY));
}

function getSelectedBuildType(): string {
  return resolveSelectedBuildType(
    getWorkspaceState<string>(BUILD_TYPE_STATE_KEY),
    vscode.workspace.getConfiguration("mbedCe").get<string>("defaultBuildType", "Develop")
  );
}

function getSelectedUploadMethod(projectInfo?: WorkspaceInspection): string {
  return resolveSelectedUploadMethod(
    projectInfo,
    getWorkspaceState<string>(UPLOAD_METHOD_STATE_KEY)
  );
}

// All build-like actions flow through one runner so the sidebar and status bar follow the same rules.
async function runAction(action: ProjectAction, onStateChanged: () => void): Promise<void> {
  await runProjectAction(action, {
    inspectWorkspace,
    getSelectedTarget,
    getSelectedBuildType,
    getSelectedUploadMethod,
    getSelectedDeployTarget,
    getActiveOperationLabel: () => activeOperationLabel,
    setActiveOperationLabel: (label) => {
      activeOperationLabel = label;
      onStateChanged();
    },
    isStopRequested: () => stopRequested,
    setStopRequested: (value) => {
      stopRequested = value;
      onStateChanged();
    },
    setCurrentTaskExecution: (execution) => {
      currentTaskExecution = execution;
      onStateChanged();
    }
  });
}

async function stopActiveAction(): Promise<void> {
  if (!activeOperationLabel || !currentTaskExecution) {
    void vscode.window.showInformationMessage("No Mbed CE action is currently running.");
    return;
  }

  stopRequested = true;
  currentTaskExecution.terminate();
  void vscode.window.showInformationMessage(`Stopping Mbed CE action: ${activeOperationLabel}`);
}

function getRequirementsOutputChannel(): vscode.OutputChannel {
  requirementsOutputChannel ??= vscode.window.createOutputChannel("Mbed CE Requirements");
  return requirementsOutputChannel;
}

function getWorkspaceState<T>(key: string): T | undefined {
  return extensionContext?.workspaceState.get<T>(key);
}

async function updateWorkspaceState<T>(key: string, value: T): Promise<void> {
  await extensionContext?.workspaceState.update(key, value);
}

async function syncCppToolsConfigurationProvider(projectInfo?: WorkspaceInspection): Promise<void> {
  const workspaceFolder = projectInfo?.workspaceFolder ?? vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return;
  }

  if (!vscode.extensions.getExtension("ms-vscode.cpptools")) {
    return;
  }

  const cppConfig = vscode.workspace.getConfiguration("C_Cpp", workspaceFolder.uri);
  const currentProvider = cppConfig.get<string>("default.configurationProvider");
  const shouldManage = vscode.workspace.getConfiguration("mbedCe", workspaceFolder.uri).get<boolean>("manageCppToolsProvider", true);

  if (!shouldManage) {
    if (currentProvider === CPPTOOLS_CONFIGURATION_PROVIDER_ID) {
      await cppConfig.update("default.configurationProvider", undefined, vscode.ConfigurationTarget.Workspace);
    }
    return;
  }

  const info = projectInfo ?? (await inspectWorkspace());
  if (!info.isMbedCeProject) {
    if (currentProvider === CPPTOOLS_CONFIGURATION_PROVIDER_ID) {
      await cppConfig.update("default.configurationProvider", undefined, vscode.ConfigurationTarget.Workspace);
    }
    return;
  }

  const hasActiveConfiguration = await cppToolsProviderHandle.hasActiveConfiguration();
  if (!hasActiveConfiguration) {
    if (currentProvider === CPPTOOLS_CONFIGURATION_PROVIDER_ID) {
      await cppConfig.update("default.configurationProvider", undefined, vscode.ConfigurationTarget.Workspace);
    }
    return;
  }

  if (currentProvider === CPPTOOLS_CONFIGURATION_PROVIDER_ID) {
    return;
  }

  await cppConfig.update("default.configurationProvider", CPPTOOLS_CONFIGURATION_PROVIDER_ID, vscode.ConfigurationTarget.Workspace);
}

function shouldRefreshForSavedDocument(document: vscode.TextDocument): boolean {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
  if (!workspaceFolder) {
    return false;
  }

  const normalizedPath = document.uri.fsPath.replaceAll("\\", "/");
  const fileName = path.basename(normalizedPath);

  if (
    fileName === "CMakeLists.txt" ||
    fileName === "mbed-ce-targets.json5" ||
    fileName === "targets.json5" ||
    fileName === "custom_targets.json5" ||
    fileName === "mbed_app.json" ||
    fileName === "mbed_app.json5"
  ) {
    return true;
  }

  return normalizedPath.includes("/upload_method_cfg/") && normalizedPath.endsWith(".cmake");
}
