import * as vscode from "vscode";
import { WorkspaceInspection } from "./types";
import { maybePromptForCustomTargetsPath, maybePromptForMbedOsPath, maybePromptForProjectRootPath } from "./workspaceProject";

export async function initializeWorkspace(
  inspectWorkspace: () => Promise<WorkspaceInspection>,
  _context: vscode.ExtensionContext
): Promise<void> {
  const info = await inspectWorkspace();
  if (!info.workspaceFolder) {
    return;
  }

  const changedProjectRootPath = await maybePromptForProjectRootPath(info);
  let refreshedInfo = changedProjectRootPath ? await inspectWorkspace() : info;
  const changedMbedOsPath = await maybePromptForMbedOsPath(refreshedInfo);
  refreshedInfo = changedMbedOsPath ? await inspectWorkspace() : refreshedInfo;
  const changedCustomTargetsPath = await maybePromptForCustomTargetsPath(refreshedInfo);
  if (changedCustomTargetsPath) {
    await inspectWorkspace();
  }
}
