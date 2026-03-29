import { spawn } from "child_process";
import * as path from "path";
import * as vscode from "vscode";
import { MBED_CE_FILE_API_CLIENT } from "./constants";
import { RunningExecution, TemplateValues } from "./types";

export type TaskLifecycleCallbacks = {
  onStart?: (execution: RunningExecution) => void;
  onEnd?: (execution: RunningExecution) => void;
};

export type BuildDirectoryExpectation = {
  target: string;
  buildType: string;
  uploadMethod: string;
  serialNumber: string;
};

let taskOutputChannel: vscode.OutputChannel | undefined;

export async function runWithProgress<T>(title: string, work: () => Promise<T>): Promise<T> {
  return await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title, cancellable: false },
    async () => await work()
  );
}

export async function runShellTask(command: string, cwd: string, label: string, callbacks?: TaskLifecycleCallbacks): Promise<number> {
  const taskSpec = createProcessTaskSpec(command, cwd);
  const output = getTaskOutputChannel();
  output.appendLine(`> ${label}`);
  output.appendLine(`cwd: ${cwd}`);
  output.appendLine(`${taskSpec.command} ${taskSpec.args.join(" ")}`);
  output.appendLine("");
  output.show(false);

  const child = spawn(taskSpec.command, taskSpec.args, {
    cwd,
    env: process.env,
    windowsHide: true,
    shell: false,
    detached: process.platform !== "win32"
  });

  child.stdout.on("data", (chunk) => {
    output.append(Buffer.from(chunk).toString("utf8"));
  });
  child.stderr.on("data", (chunk) => {
    output.append(Buffer.from(chunk).toString("utf8"));
  });

  const execution: RunningExecution = {
    terminate: () => terminateRunningProcess(child)
  };
  callbacks?.onStart?.(execution);

  return await new Promise<number>((resolve) => {
    child.on("error", (error) => {
      output.appendLine(error.message);
    });

    child.on("close", (code) => {
      output.appendLine("");
      output.appendLine(`< ${label} finished with code ${code ?? -1}>`);
      callbacks?.onEnd?.(execution);
      resolve(code ?? -1);
    });
  });
}

function createProcessTaskSpec(command: string, _cwd: string): { command: string; args: string[] } {
  if (process.platform === "win32") {
    return {
      command: "powershell.exe",
      args: ["-NoLogo", "-NoProfile", "-Command", command]
    };
  }

  return {
    command: process.env.SHELL || "/bin/sh",
    args: ["-lc", command]
  };
}

function getTaskOutputChannel(): vscode.OutputChannel {
  taskOutputChannel ??= vscode.window.createOutputChannel("Mbed CE Tasks");
  return taskOutputChannel;
}

function terminateRunningProcess(child: ReturnType<typeof spawn>): void {
  if (child.exitCode !== null || child.killed) {
    return;
  }

  if (process.platform === "win32" && child.pid) {
    void spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, shell: false });
    return;
  }

  if (child.pid) {
    try {
      process.kill(-child.pid, "SIGTERM");
      return;
    } catch {
      // Fall through to direct child termination if process-group signaling is unavailable.
    }
  }

  child.kill("SIGTERM");
}

export async function ensureCMakeFileApiQuery(buildDirectory: string): Promise<void> {
  const queryDirectory = vscode.Uri.file(path.join(buildDirectory, ".cmake", "api", "v1", "query", `client-${MBED_CE_FILE_API_CLIENT}`));
  await vscode.workspace.fs.createDirectory(queryDirectory);
  await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(queryDirectory, "codemodel-v2"), new Uint8Array());
}

export function getExpandedCommand(config: vscode.WorkspaceConfiguration, key: string, values: TemplateValues): string | undefined {
  const template = config.get<string>(key, "");
  if (!template) {
    void vscode.window.showWarningMessage(`No command is configured for ${key}.`);
    return undefined;
  }
  return expandCommandTemplate(template, values);
}

export function expandCommandTemplate(template: string, values: TemplateValues): string {
  const escapedValues = mapTemplateValues(values, escapeShellTemplateValue);
  return replaceTemplateValues(template, escapedValues);
}

export function resolveBuildDirectory(template: string, values: TemplateValues): string {
  const expanded = replaceTemplateValues(template, values).trim();
  const absolutePath = path.isAbsolute(expanded)
    ? expanded
    : path.join(values.projectRoot, expanded);
  return path.normalize(absolutePath);
}

export async function directoryExists(buildDirectory: string): Promise<boolean> {
  const uri = vscode.Uri.file(buildDirectory);
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    return stat.type === vscode.FileType.Directory;
  } catch {
    return false;
  }
}

export async function isConfiguredBuildDirectory(buildDirectory: string): Promise<boolean> {
  if (!(await directoryExists(buildDirectory))) {
    return false;
  }

  const buildUri = vscode.Uri.file(buildDirectory);
  try {
    const entries = await vscode.workspace.fs.readDirectory(buildUri);
    if (
      entries.some(
        ([name, type]) =>
          type === vscode.FileType.File &&
          (name === "build.ninja" || name === "Makefile" || name.toLowerCase().endsWith(".sln"))
      )
    ) {
      return true;
    }
  } catch {
    return false;
  }

  const fileApiReplyDirectory = vscode.Uri.file(path.join(buildDirectory, ".cmake", "api", "v1", "reply"));
  try {
    const entries = await vscode.workspace.fs.readDirectory(fileApiReplyDirectory);
    return entries.some(([name, type]) => type === vscode.FileType.File && /^index-.*\.json$/i.test(name));
  } catch {
    return false;
  }
}

export async function doesBuildConfigurationMatch(
  buildDirectory: string,
  expectation: BuildDirectoryExpectation
): Promise<boolean> {
  if (!(await isConfiguredBuildDirectory(buildDirectory))) {
    return false;
  }

  const cacheEntries = await readCMakeCacheEntries(buildDirectory);
  if (!cacheEntries) {
    return false;
  }

  return (
    cacheEntries.get("MBED_TARGET") === expectation.target &&
    cacheEntries.get("CMAKE_BUILD_TYPE") === expectation.buildType &&
    cacheEntries.get("UPLOAD_METHOD") === expectation.uploadMethod &&
    (cacheEntries.get("MBED_UPLOAD_SERIAL_NUMBER") ?? "") === expectation.serialNumber
  );
}

async function readCMakeCacheEntries(buildDirectory: string): Promise<Map<string, string> | undefined> {
  const cacheUri = vscode.Uri.file(path.join(buildDirectory, "CMakeCache.txt"));
  try {
    const raw = await vscode.workspace.fs.readFile(cacheUri);
    const text = Buffer.from(raw).toString("utf8");
    const entries = new Map<string, string>();

    for (const line of text.split(/\r?\n/)) {
      if (!line || line.startsWith("//") || line.startsWith("#")) {
        continue;
      }

      const match = line.match(/^([^:#=]+):[^=]*=(.*)$/);
      if (match) {
        entries.set(match[1], match[2]);
      }
    }

    return entries;
  } catch {
    return undefined;
  }
}

export function getUnsafeBuildDirectoryReason(buildDirectory: string, allowedRoots: string[]): string | undefined {
  const resolvedBuildDirectory = path.resolve(buildDirectory);
  const driveRoot = path.parse(resolvedBuildDirectory).root;
  if (resolvedBuildDirectory === driveRoot) {
    return `Refusing to clean build directory because it resolves to the drive root: ${resolvedBuildDirectory}`;
  }

  const normalizedAllowedRoots = [...new Set(allowedRoots.map((entry) => path.resolve(entry)))];
  if (normalizedAllowedRoots.includes(resolvedBuildDirectory)) {
    return `Refusing to clean build directory because it resolves to a project/workspace root: ${resolvedBuildDirectory}`;
  }

  const containingRoot = normalizedAllowedRoots.find((allowedRoot) => {
    const relative = path.relative(allowedRoot, resolvedBuildDirectory);
    return relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative);
  });

  if (!containingRoot) {
    return `Refusing to clean build directory outside the project/workspace: ${resolvedBuildDirectory}`;
  }

  if (!looksLikeBuildDirectory(resolvedBuildDirectory, containingRoot)) {
    return `Refusing to clean directory that does not look like a dedicated build directory: ${resolvedBuildDirectory}`;
  }

  return undefined;
}

function looksLikeBuildDirectory(buildDirectory: string, allowedRoot: string): boolean {
  const relative = path.relative(allowedRoot, buildDirectory);
  const segments = relative
    .split(path.sep)
    .map((segment) => segment.trim().toLowerCase())
    .filter(Boolean);

  const lastSegment = segments.at(-1);
  if (!lastSegment) {
    return false;
  }

  return (
    segments.includes("build") ||
    lastSegment.startsWith("build-") ||
    lastSegment.endsWith("-build") ||
    lastSegment.startsWith("cmake-build")
  );
}

export async function deleteBuildDirectoryIfExists(buildDirectory: string): Promise<void> {
  const uri = vscode.Uri.file(buildDirectory);
  try {
    const stat = await vscode.workspace.fs.stat(uri);
    if (stat.type !== vscode.FileType.Directory) return;
  } catch {
    return;
  }
  await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
}

export function quoteShellArgument(value: string): string {
  if (process.platform === "win32") {
    return "'" + value.replace(/'/g, "''") + "'";
  }

  return `"${value.replace(/(["\\$`])/g, "\\$1")}"`;
}

function mapTemplateValues(values: TemplateValues, transform: (value: string) => string): TemplateValues {
  return {
    workspaceFolder: transform(values.workspaceFolder),
    projectRoot: transform(values.projectRoot),
    target: transform(values.target),
    buildType: transform(values.buildType),
    uploadMethod: transform(values.uploadMethod),
    serialNumber: transform(values.serialNumber),
    mbedUploadSerialNumberArgument: transform(values.mbedUploadSerialNumberArgument),
    buildDirectory: transform(values.buildDirectory),
    deployTarget: transform(values.deployTarget)
  };
}

function replaceTemplateValues(template: string, values: TemplateValues): string {
  return template
    .replaceAll("${workspaceFolder}", values.workspaceFolder)
    .replaceAll("${projectRoot}", values.projectRoot)
    .replaceAll("${target}", values.target)
    .replaceAll("${buildType}", values.buildType)
    .replaceAll("${uploadMethod}", values.uploadMethod)
    .replaceAll("${serialNumber}", values.serialNumber)
    .replaceAll("${mbedUploadSerialNumberArgument}", values.mbedUploadSerialNumberArgument)
    .replaceAll("${buildDirectory}", values.buildDirectory)
    .replaceAll("${deployTarget}", values.deployTarget);
}

function escapeShellTemplateValue(value: string): string {
  if (process.platform === "win32") {
    return value
      .replace(/`/g, "``")
      .replace(/\$/g, "`$")
      .replace(/"/g, '`"');
  }

  return value;
}
