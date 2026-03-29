import * as os from "os";
import * as vscode from "vscode";
import { DEFAULT_PROJECT_TEMPLATE_SOURCE } from "./constants";
import { quoteShellArgument, runShellTask, runWithProgress } from "./actionHelpers";
import { extractRequirementDetails } from "./requirements";
import { fileExists } from "./workspaceProject";

type BeforeOpenProjectHandler = () => Promise<void> | void;

function getDefaultProjectsRootUri(): vscode.Uri {
  const configured = vscode.workspace.getConfiguration("mbedCe").get<string>("defaultProjectsRoot", "").trim();
  if (configured) {
    return vscode.Uri.file(configured);
  }

  return vscode.Uri.file(os.homedir());
}

export async function loadProject(onBeforeOpenProject: BeforeOpenProjectHandler = () => undefined): Promise<void> {
  const selection = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Open Mbed CE Project",
    defaultUri: getDefaultProjectsRootUri()
  });
  const folder = selection?.[0];
  if (!folder) return;

  await runWithProgress("Opening Mbed CE project", async () => {
    await onBeforeOpenProject();
    await vscode.commands.executeCommand("vscode.openFolder", folder, false);
  });
}

export async function createNewProject(onBeforeOpenProject: BeforeOpenProjectHandler = () => undefined): Promise<void> {
  const templateSource = getProjectTemplateSource();
  if (!templateSource) {
    return;
  }

  const parentSelection = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Choose Parent Folder",
    defaultUri: getDefaultProjectsRootUri()
  });
  const parentFolder = parentSelection?.[0];
  if (!parentFolder) return;

  const projectName = await vscode.window.showInputBox({
    prompt: "New Mbed CE project folder name",
    placeHolder: "my-mbed-ce-project",
    validateInput: (value) => {
      return getProjectNameValidationError(value);
    }
  });
  if (!projectName) return;

  const trimmedProjectName = projectName.trim();
  const projectUri = vscode.Uri.joinPath(parentFolder, trimmedProjectName);
  if (await fileExists(projectUri)) {
    void vscode.window.showWarningMessage(`A folder named ${trimmedProjectName} already exists in the selected location.`);
    return;
  }

  try {
    await runWithProgress("Creating new Mbed CE project", async () => {
      const cloneCommand = `git clone --progress --recurse-submodules ${quoteShellArgument(templateSource)} ${quoteShellArgument(trimmedProjectName)}`;
      const exitCode = await runShellTask(cloneCommand, parentFolder.fsPath, "Mbed CE: Clone Starter Project");
      if (exitCode !== 0) {
        throw new Error(`git clone failed with exit code ${exitCode}. See the Mbed CE Tasks output channel for details.`);
      }
    });
  } catch (error) {
    const execError = error as { stderr?: string; stdout?: string; message?: string };
    const details = extractRequirementDetails(execError.stdout, execError.stderr, execError.message);
    void vscode.window.showErrorMessage(`Failed to create the new project: ${details}`);
    return;
  }

  void vscode.window.showInformationMessage(`Created new Mbed CE project in ${trimmedProjectName}.`);
  await onBeforeOpenProject();
  await vscode.commands.executeCommand("vscode.openFolder", projectUri, false);
}

function getProjectNameValidationError(value: string): string | undefined {
  const trimmed = value.trim();
  if (!trimmed) {
    return "Project name is required.";
  }

  if (/[<>:"/\\|?*]/.test(trimmed)) {
    return "Project name contains invalid path characters.";
  }

  if (trimmed === "." || trimmed === "..") {
    return "Project name cannot be . or ..";
  }

  if (process.platform === "win32") {
    if (/[. ]$/.test(value)) {
      return "Project name cannot end with a space or period on Windows.";
    }

    if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i.test(trimmed)) {
      return "Project name uses a reserved Windows device name.";
    }
  }

  return undefined;
}

function getProjectTemplateSource(): string {
  const configuredSource = vscode.workspace.getConfiguration("mbedCe").get<string>("projectTemplate", "").trim();
  if (configuredSource) {
    return configuredSource;
  }

  return DEFAULT_PROJECT_TEMPLATE_SOURCE;
}

