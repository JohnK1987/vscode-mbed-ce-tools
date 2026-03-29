import { exec } from "child_process";
import * as os from "os";
import { promisify } from "util";
import * as vscode from "vscode";
import { MBED_CE_TOOLCHAIN_INSTALL_URL, REQUIREMENT_CHECK_TIMEOUT_MS } from "./constants";
import { ExtensionCheckResult, RequirementCheck, RequirementCheckResult } from "./types";
import { runWithProgress } from "./actionHelpers";

const execAsync = promisify(exec);

export async function checkRequirementsCommand(output: vscode.OutputChannel): Promise<void> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const cwd = workspaceFolder?.uri.fsPath ?? os.homedir();

  const config = vscode.workspace.getConfiguration("mbedCe");
  const checks = getRequirementChecks(config);
  if (checks.length === 0) {
    void vscode.window.showWarningMessage("No requirement check commands are configured.");
    return;
  }

  await runWithProgress("Checking Mbed CE requirements", async () => {
    const results = [];
    for (const check of checks) {
      results.push(await runRequirementCheck(check, cwd, REQUIREMENT_CHECK_TIMEOUT_MS));
    }

    const extensionResults = getExtensionCheckResults(config);
    showRequirementResults(results, extensionResults, output, MBED_CE_TOOLCHAIN_INSTALL_URL);
  });
}

export function getRequirementChecks(config: vscode.WorkspaceConfiguration): RequirementCheck[] {
  const configuredCommands = config.get<string[]>("toolchainCheckCommands", []);
  return configuredCommands.map((command) => ({ label: inferRequirementLabel(command), command }));
}

function inferRequirementLabel(command: string): string {
  const match = command.trim().match(/^(\S+)/);
  return match?.[1] ?? command;
}

export function getExtensionCheckResults(config: vscode.WorkspaceConfiguration): ExtensionCheckResult[] {
  const extensionIds = config.get<string[]>("recommendedExtensionIds", []);

  return extensionIds.map((id) => {
    const extension = vscode.extensions.getExtension(id);
    return {
      id,
      ok: Boolean(extension),
      details: extension ? "Installed" : "Not installed"
    };
  });
}

export async function runRequirementCheck(check: RequirementCheck, cwd: string, timeoutMs: number): Promise<RequirementCheckResult> {
  try {
    const { stdout, stderr } = await execAsync(check.command, {
      cwd,
      timeout: timeoutMs,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
      shell: getRequirementCheckShell()
    });
    return { label: check.label, ok: true, details: extractRequirementDetails(stdout, stderr) };
  } catch (error) {
    const execError = error as { stdout?: string; stderr?: string; message?: string };
    return {
      label: check.label,
      ok: false,
      details: extractRequirementDetails(execError.stdout, execError.stderr, execError.message)
    };
  }
}

function getRequirementCheckShell(): string | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }

  return "powershell.exe";
}

export function extractRequirementDetails(stdout?: string, stderr?: string, fallback?: string): string {
  const combined = [stdout ?? "", stderr ?? ""]
    .join("\n")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);

  return combined ?? fallback ?? "No output returned.";
}

export function showRequirementResults(
  results: RequirementCheckResult[],
  extensionResults: ExtensionCheckResult[],
  output: vscode.OutputChannel,
  toolchainInstallUrl: string
): void {
  output.clear();
  output.appendLine("Mbed CE Requirements Check");
  output.appendLine("");

  const okResults = results.filter((result) => result.ok);
  const failedResults = results.filter((result) => !result.ok);
  const okExtensions = extensionResults.filter((result) => result.ok);
  const failedExtensions = extensionResults.filter((result) => !result.ok);

  output.appendLine("Tools OK:");
  if (okResults.length === 0) {
    output.appendLine("- none");
  } else {
    for (const result of okResults) {
      output.appendLine("- " + result.label + ": " + result.details);
    }
  }

  output.appendLine("");
  output.appendLine("Tools missing or failed:");
  if (failedResults.length === 0) {
    output.appendLine("- none");
  } else {
    for (const result of failedResults) {
      output.appendLine("- " + result.label + ": " + result.details);
    }
  }

  output.appendLine("");
  output.appendLine("VS Code extensions OK:");
  if (okExtensions.length === 0) {
    output.appendLine("- none");
  } else {
    for (const result of okExtensions) {
      output.appendLine("- " + result.id + ": " + result.details);
    }
  }

  output.appendLine("");
  output.appendLine("VS Code extensions missing:");
  if (failedExtensions.length === 0) {
    output.appendLine("- none");
  } else {
    for (const result of failedExtensions) {
      output.appendLine("- " + result.id + ": " + result.details);
    }
  }

  output.show(true);

  if (failedResults.length === 0 && failedExtensions.length === 0) {
    void vscode.window.showInformationMessage(
      "Requirements look good. " + okResults.length + " tool(s) and " + okExtensions.length + " VS Code extension(s) are available."
    );
    return;
  }

  if (failedResults.length === 0) {
    const missingExtensions = failedExtensions.map((result) => result.id).join(", ");
    void vscode.window
      .showInformationMessage(
        "Core tools look good. Recommended VS Code extensions are missing: " + missingExtensions + ". You can continue, but some editor features may be unavailable.",
        "Open Output"
      )
      .then((selection) => {
        if (selection === "Open Output") {
          output.show(true);
        }
      });
    return;
  }

  const failedTools = failedResults.map((result) => result.label).join(", ");
  const missingExtensions = failedExtensions.map((result) => result.id).join(", ");
  const detailsSuffix = missingExtensions
    ? " Recommended VS Code extensions missing: " + missingExtensions + "."
    : "";

  void vscode.window
    .showWarningMessage(
      "Required tools are missing or not available on PATH: " + failedTools + "." + detailsSuffix,
      "Open Toolchain Guide",
      "Open Output"
    )
    .then(async (selection) => {
      switch (selection) {
        case "Open Toolchain Guide":
          await vscode.env.openExternal(vscode.Uri.parse(toolchainInstallUrl));
          break;
        case "Open Output":
          output.show(true);
          break;
        default:
          break;
      }
    });
}
