import * as vscode from "vscode";
import { BUILD_TYPE_OPTIONS, BUILD_TYPE_STATE_KEY, TARGET_STATE_KEY, UPLOAD_METHOD_STATE_KEY } from "./constants";
import { WorkspaceInspection } from "./types";

type WorkspaceStateUpdater = <T>(key: string, value: T) => Promise<void>;
type InspectWorkspaceFn = () => Promise<WorkspaceInspection>;
type SelectedUploadMethodResolver = (projectInfo?: WorkspaceInspection) => string;

// These resolvers keep target/build/upload fallback rules in one place so UI and commands stay consistent.
export function resolveSelectedTarget(projectInfo: WorkspaceInspection, storedTarget?: string): string | undefined {
  if (storedTarget && projectInfo.targets.includes(storedTarget)) {
    return storedTarget;
  }

  return projectInfo.targets[0];
}

export function resolveSelectedBuildType(storedBuildType?: string, configuredDefaultBuildType = "Develop"): string {
  if (storedBuildType && BUILD_TYPE_OPTIONS.includes(storedBuildType as (typeof BUILD_TYPE_OPTIONS)[number])) {
    return storedBuildType;
  }

  return configuredDefaultBuildType;
}

export function resolveSelectedUploadMethod(
  projectInfo?: WorkspaceInspection,
  storedUploadMethod?: string
): string {
  const available = projectInfo?.uploadMethodInfo?.available ?? ["NONE"];
  if (storedUploadMethod && available.includes(storedUploadMethod)) {
    return storedUploadMethod;
  }

  const targetPreferredUploadMethod = projectInfo?.selectedTargetSettings?.uploadMethod;
  if (targetPreferredUploadMethod && available.includes(targetPreferredUploadMethod)) {
    return targetPreferredUploadMethod;
  }

  const boardDefault = projectInfo?.uploadMethodInfo?.defaultMethod;
  if (boardDefault && available.includes(boardDefault)) {
    return boardDefault;
  }

  return available[0] ?? "NONE";
}

export async function selectTargetCommand(
  inspectWorkspace: InspectWorkspaceFn,
  updateWorkspaceState: WorkspaceStateUpdater,
  getSelectedUploadMethod: SelectedUploadMethodResolver
): Promise<void> {
  const projectInfo = await inspectWorkspace();
  if (!projectInfo.workspaceFolder) {
    void vscode.window.showWarningMessage("Open an Mbed CE workspace folder before selecting a target.");
    return;
  }
  if (projectInfo.targets.length === 0) {
    void vscode.window.showWarningMessage("No targets were found in .vscode/mbed-ce-targets.json5 or the configured Mbed target databases.");
    return;
  }

  const selection = await vscode.window.showQuickPick(projectInfo.targets, { placeHolder: "Choose an Mbed CE target" });
  if (!selection) {
    return;
  }

  await updateWorkspaceState(TARGET_STATE_KEY, selection);
  const refreshed = await inspectWorkspace();
  await updateWorkspaceState(UPLOAD_METHOD_STATE_KEY, getSelectedUploadMethod(refreshed));
  void vscode.window.showInformationMessage(`Selected target: ${selection}`);
}

export async function selectBuildTypeCommand(updateWorkspaceState: WorkspaceStateUpdater): Promise<void> {
  const selection = await vscode.window.showQuickPick([...BUILD_TYPE_OPTIONS], { placeHolder: "Choose a build type" });
  if (!selection) {
    return;
  }

  await updateWorkspaceState(BUILD_TYPE_STATE_KEY, selection);
  void vscode.window.showInformationMessage(`Selected build type: ${selection}`);
}

export async function selectUploadMethodCommand(
  inspectWorkspace: InspectWorkspaceFn,
  updateWorkspaceState: WorkspaceStateUpdater
): Promise<void> {
  const projectInfo = await inspectWorkspace();
  if (!projectInfo.workspaceFolder) {
    void vscode.window.showWarningMessage("Open an Mbed CE workspace folder before selecting an upload method.");
    return;
  }
  if (!projectInfo.isMbedCeProject || projectInfo.targets.length === 0) {
    void vscode.window.showWarningMessage("Select an Mbed CE project target before choosing an upload method.");
    return;
  }

  const methods = projectInfo.uploadMethodInfo?.available;
  if (!methods || methods.length === 0) {
    void vscode.window.showWarningMessage("No upload methods were found for the selected target.");
    return;
  }

  const selection = await vscode.window.showQuickPick(methods, { placeHolder: "Choose an upload method" });
  if (!selection) {
    return;
  }

  await updateWorkspaceState(UPLOAD_METHOD_STATE_KEY, selection);
  void vscode.window.showInformationMessage(`Selected upload method: ${selection}`);
}
