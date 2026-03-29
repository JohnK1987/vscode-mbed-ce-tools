import * as vscode from "vscode";
import {
  deleteBuildDirectoryIfExists,
  doesBuildConfigurationMatch,
  ensureCMakeFileApiQuery,
  getExpandedCommand,
  getUnsafeBuildDirectoryReason,
  resolveBuildDirectory,
  runShellTask
} from "./actionHelpers";
import { ProjectAction, RunningExecution, TemplateValues, WorkspaceInspection } from "./types";

type ProjectActionDependencies = {
  inspectWorkspace: () => Promise<WorkspaceInspection>;
  getSelectedTarget: (projectInfo?: WorkspaceInspection) => Promise<string | undefined>;
  getSelectedBuildType: () => string;
  getSelectedUploadMethod: (projectInfo?: WorkspaceInspection) => string;
  getSelectedDeployTarget: (projectInfo: WorkspaceInspection) => string;
  getActiveOperationLabel: () => string | undefined;
  setActiveOperationLabel: (label: string | undefined) => void;
  isStopRequested: () => boolean;
  setStopRequested: (value: boolean) => void;
  setCurrentTaskExecution: (execution: RunningExecution | undefined) => void;
};

// Every build-like command comes through here so preconditions, path expansion, and task behavior stay identical.
export async function runProjectAction(action: ProjectAction, dependencies: ProjectActionDependencies): Promise<void> {
  const activeOperationLabel = dependencies.getActiveOperationLabel();
  if (activeOperationLabel) {
    void vscode.window.showWarningMessage(`Another Mbed CE action is already running: ${activeOperationLabel}`);
    return;
  }

  const projectInfo = await dependencies.inspectWorkspace();
  if (!projectInfo.workspaceFolder) {
    void vscode.window.showWarningMessage("Open an Mbed CE workspace folder before running actions.");
    return;
  }
  if (!projectInfo.isMbedCeProject) {
    void vscode.window.showWarningMessage("The current workspace does not look like an Mbed CE project.");
    return;
  }

  if (!(await saveWorkspaceFilesForAction(action))) {
    return;
  }

  const target = await dependencies.getSelectedTarget(projectInfo);
  if (!target) {
    void vscode.window.showWarningMessage("Select a target before running Mbed CE actions.");
    return;
  }

  const buildType = dependencies.getSelectedBuildType();
  const uploadMethod = dependencies.getSelectedUploadMethod(projectInfo);
  const serialNumber = projectInfo.selectedTargetSettings?.serialNumber ?? "";
  const deployTarget = dependencies.getSelectedDeployTarget(projectInfo);
  if (!deployTarget && action === "buildDeploy") {
    void vscode.window.showWarningMessage("Could not detect a deploy target for flash-<target>.");
    return;
  }

  const config = vscode.workspace.getConfiguration("mbedCe");
  const workspaceFolderPath = projectInfo.workspaceFolder.uri.fsPath;
  const projectRootPath = projectInfo.projectRootPath ?? workspaceFolderPath;
  const baseValues: TemplateValues = {
    workspaceFolder: workspaceFolderPath,
    projectRoot: projectRootPath,
    target,
    buildType,
    uploadMethod,
    serialNumber,
    mbedUploadSerialNumberArgument: serialNumber ? ` -DMBED_UPLOAD_SERIAL_NUMBER:STRING=${serialNumber}` : "",
    buildDirectory: "",
    deployTarget: deployTarget ?? ""
  };
  const buildDirectoryTemplate = config.get<string>("buildDirectory", "${projectRoot}/build/${target}-${buildType}");
  const buildDirectory = resolveBuildDirectory(buildDirectoryTemplate, baseValues);
  const values: TemplateValues = { ...baseValues, buildDirectory };

  const configureCommand = getExpandedCommand(config, "configureCommand", values);
  const buildCommand = getExpandedCommand(config, "buildCommand", values);
  const deployCommand = getExpandedCommand(config, "deployCommand", values);

  dependencies.setStopRequested(false);
  dependencies.setActiveOperationLabel(getActionStatusLabel(action));
  try {
    switch (action) {
      case "configure":
        if (!configureCommand) {
          return;
        }
        await ensureCMakeFileApiQuery(buildDirectory);
        await runTrackedTask(configureCommand, projectRootPath, "Mbed CE: Configure", dependencies);
        break;
      case "cleanBuild": {
        if (!configureCommand || !buildCommand) {
          return;
        }
        const unsafeBuildDirectoryReason = getUnsafeBuildDirectoryReason(buildDirectory, [projectRootPath, workspaceFolderPath]);
        if (unsafeBuildDirectoryReason) {
          void vscode.window.showErrorMessage(unsafeBuildDirectoryReason);
          return;
        }
        await deleteBuildDirectoryIfExists(buildDirectory);
        if (dependencies.isStopRequested()) {
          return;
        }
        await ensureCMakeFileApiQuery(buildDirectory);
        if ((await runTrackedTask(configureCommand, projectRootPath, "Mbed CE: Configure", dependencies)) !== 0 || dependencies.isStopRequested()) {
          return;
        }
        await runTrackedTask(buildCommand, projectRootPath, "Mbed CE: Build", dependencies);
        break;
      }
      case "build":
        if (!configureCommand || !buildCommand) {
          return;
        }
        if (!(await ensureConfiguredBuildDirectory(buildDirectory, { target, buildType, uploadMethod, serialNumber }, configureCommand, projectRootPath, dependencies))) {
          return;
        }
        await runTrackedTask(buildCommand, projectRootPath, "Mbed CE: Build", dependencies);
        break;
      case "buildDeploy":
        if (!configureCommand || !deployCommand) {
          return;
        }
        if (!(await ensureConfiguredBuildDirectory(buildDirectory, { target, buildType, uploadMethod, serialNumber }, configureCommand, projectRootPath, dependencies))) {
          return;
        }
        await runTrackedTask(deployCommand, projectRootPath, "Mbed CE: Deploy", dependencies);
        break;
    }
  } finally {
    dependencies.setCurrentTaskExecution(undefined);
    dependencies.setActiveOperationLabel(undefined);
    dependencies.setStopRequested(false);
  }
}

async function ensureConfiguredBuildDirectory(
  buildDirectory: string,
  expectation: { target: string; buildType: string; uploadMethod: string; serialNumber: string },
  configureCommand: string,
  projectRootPath: string,
  dependencies: Pick<ProjectActionDependencies, "setCurrentTaskExecution" | "isStopRequested">
): Promise<boolean> {
  if (await doesBuildConfigurationMatch(buildDirectory, expectation)) {
    return !dependencies.isStopRequested();
  }

  await ensureCMakeFileApiQuery(buildDirectory);
  if ((await runTrackedTask(configureCommand, projectRootPath, "Mbed CE: Configure", dependencies)) !== 0) {
    return false;
  }

  return !dependencies.isStopRequested();
}

function getActionStatusLabel(action: ProjectAction): string {
  switch (action) {
    case "configure":
      return "Running Configure";
    case "cleanBuild":
      return "Running Clean Build";
    case "build":
      return "Running Build";
    case "buildDeploy":
      return "Running Deploy";
  }
}

async function saveWorkspaceFilesForAction(action: ProjectAction): Promise<boolean> {
  const saved = await vscode.workspace.saveAll(false);
  if (saved) {
    return true;
  }

  const actionLabel = getActionDisplayName(action);
  void vscode.window.showWarningMessage(`Could not save all modified files before ${actionLabel}. Resolve the save issue and try again.`);
  return false;
}

function getActionDisplayName(action: ProjectAction): string {
  switch (action) {
    case "configure":
      return "Configure";
    case "cleanBuild":
      return "Clean Build";
    case "build":
      return "Build";
    case "buildDeploy":
      return "Deploy";
  }
}

async function runTrackedTask(
  command: string,
  cwd: string,
  label: string,
  dependencies: Pick<ProjectActionDependencies, "setCurrentTaskExecution" | "isStopRequested">
): Promise<number> {
  if (dependencies.isStopRequested()) {
    return -1;
  }

  return await runShellTask(command, cwd, label, {
    onStart: (execution) => {
      dependencies.setCurrentTaskExecution(execution);
    },
    onEnd: () => {
      dependencies.setCurrentTaskExecution(undefined);
    }
  });
}
