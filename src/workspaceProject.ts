import * as path from "path";
import * as vscode from "vscode";
import JSON5 from "json5";
import { resolveBuildDirectory } from "./actionHelpers";
import { TARGET_SELECTOR_RELATIVE_PATH } from "./constants";
import { readTextFile } from "./fsUtils";
import { readConfiguredExecutableTargets } from "./cmakeFileApi";
import { resolveSelectedBuildType, resolveSelectedTarget, resolveSelectedUploadMethod } from "./selectionState";
import { TargetSettings, TargetSourceResult, TemplateValues, UploadMethodInfo, WorkspaceInspection } from "./types";

export async function inspectWorkspace(storedTarget?: string, storedBuildType?: string, storedUploadMethod?: string): Promise<WorkspaceInspection> {
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  if (!workspaceFolder) {
    return { isMbedCeProject: false, summary: "No workspace folder is open.", targets: [], deployTargets: [] };
  }

  const projectRootPath = getConfiguredProjectRootPath(workspaceFolder);
  const projectRootUri = vscode.Uri.file(projectRootPath);
  const cmakeLists = path.join(projectRootPath, "CMakeLists.txt");
  const targetSelectorUri = getTargetSelectorUri(workspaceFolder);
  const customTargetsPath = path.join(getConfiguredCustomTargetsPath(workspaceFolder), "custom_targets.json5");
  const mbedTargetsPath = path.join(getConfiguredMbedOsPath(workspaceFolder), "targets", "targets.json5");
  const targetSource = await resolveTargetSource(workspaceFolder);
  const targets = targetSource.targets;
  const hasCmake = await fileExists(vscode.Uri.file(cmakeLists));
  const hasTargetSelector = await fileExists(targetSelectorUri);
  const hasCustomTargets = await fileExists(vscode.Uri.file(customTargetsPath));
  const hasMbedTargets = await fileExists(vscode.Uri.file(mbedTargetsPath));
  const hasLikelyProjectMarkers = await isLikelyMbedCeProjectRoot(projectRootUri);
  const isMbedCeProject = targets.length > 0 || hasLikelyProjectMarkers;
  const config = vscode.workspace.getConfiguration("mbedCe", workspaceFolder.uri);
  const selectedTarget = resolveSelectedTarget({ targets } as WorkspaceInspection, storedTarget);
  const selectedTargetSettings = selectedTarget ? targetSource.targetSettingsByName[selectedTarget] : undefined;
  const selectedBuildType = resolveSelectedBuildType(
    storedBuildType,
    config.get<string>("defaultBuildType", "Develop")
  );
  const uploadMethodInfo = selectedTarget ? await readUploadMethodInfo(workspaceFolder, selectedTarget) : undefined;
  const selectedUploadMethod = resolveSelectedUploadMethod(
    { uploadMethodInfo, selectedTargetSettings } as WorkspaceInspection,
    storedUploadMethod
  );
  const selectedSerialNumber = selectedTargetSettings?.serialNumber ?? "";
  const deployTargets = selectedTarget
    ? await readConfiguredExecutableTargets(
        getConfiguredBuildDirectory(workspaceFolder, projectRootPath, selectedTarget, selectedBuildType, selectedUploadMethod, selectedSerialNumber),
        selectedBuildType
      )
    : [];

  return {
    workspaceFolder,
    projectRootPath,
    isMbedCeProject,
    summary: buildProjectSummary(hasCmake, hasTargetSelector, hasCustomTargets, hasMbedTargets, targets.length, uploadMethodInfo, targetSource.sourceLabel),
    targets,
    selectedTargetSettings,
    uploadMethodInfo,
    deployTargets
  };
}


function buildProjectSummary(
  hasCmake: boolean,
  hasTargetSelector: boolean,
  hasCustomTargets: boolean,
  hasMbedTargets: boolean,
  targetCount: number,
  uploadMethodInfo?: UploadMethodInfo,
  targetSourceLabel?: string
): string {
  const parts: string[] = [];
  if (hasCmake) parts.push("CMakeLists.txt");
  if (hasTargetSelector) parts.push(TARGET_SELECTOR_RELATIVE_PATH);
  if (hasCustomTargets) parts.push("custom_targets.json5");
  if (hasMbedTargets) parts.push("mbed-os/targets/targets.json5");

  const targetsText = targetCount > 0 ? ` ${targetCount} target(s) parsed.` : "";
  const sourceText = targetSourceLabel ? ` Source: ${targetSourceLabel}.` : "";
  const uploadText = uploadMethodInfo?.available.length ? ` Upload methods: ${uploadMethodInfo.available.join(", ")}.` : "";
  if (parts.length === 0 && targetCount === 0) {
    return "Workspace does not currently look like an Mbed CE project.";
  }
  return `Found ${parts.join(", ") || "project files"}.${targetsText}${sourceText}${uploadText}`;
}

export async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function getConfiguredProjectRootPath(workspaceFolder: vscode.WorkspaceFolder): string {
  return getConfiguredPath(workspaceFolder, "projectRootPath", "${workspaceFolder}", workspaceFolder.uri.fsPath);
}

function getConfiguredProjectRootUri(workspaceFolder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.file(getConfiguredProjectRootPath(workspaceFolder));
}

function getTargetSelectorUri(workspaceFolder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.joinPath(workspaceFolder.uri, ".vscode", "mbed-ce-targets.json5");
}

function getConfiguredMbedOsPath(workspaceFolder: vscode.WorkspaceFolder): string {
  return getConfiguredPath(workspaceFolder, "mbedOsPath", "${projectRoot}/mbed-os", getConfiguredProjectRootPath(workspaceFolder));
}

function getConfiguredMbedOsUri(workspaceFolder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.file(getConfiguredMbedOsPath(workspaceFolder));
}

function getConfiguredCustomTargetsPath(workspaceFolder: vscode.WorkspaceFolder): string {
  return getConfiguredPath(workspaceFolder, "customTargetsPath", "${projectRoot}/custom_targets", getConfiguredProjectRootPath(workspaceFolder));
}

function getConfiguredCustomTargetsUri(workspaceFolder: vscode.WorkspaceFolder): vscode.Uri {
  return vscode.Uri.file(getConfiguredCustomTargetsPath(workspaceFolder));
}

function getConfiguredPath(
  workspaceFolder: vscode.WorkspaceFolder,
  settingKey: "projectRootPath" | "mbedOsPath" | "customTargetsPath",
  defaultValue: string,
  projectRootPath: string
): string {
  const configured = vscode.workspace
    .getConfiguration("mbedCe", workspaceFolder.uri)
    .get<string>(settingKey, defaultValue)
    .trim();
  return expandConfiguredPath(configured, workspaceFolder, projectRootPath);
}

function getConfiguredBuildDirectory(
  workspaceFolder: vscode.WorkspaceFolder,
  projectRootPath: string,
  target: string,
  buildType: string,
  uploadMethod: string,
  serialNumber: string
): string {
  const template = vscode.workspace.getConfiguration("mbedCe", workspaceFolder.uri).get<string>("buildDirectory", "${projectRoot}/build/${target}-${buildType}");
  const values: TemplateValues = {
    workspaceFolder: workspaceFolder.uri.fsPath,
    projectRoot: projectRootPath,
    target,
    buildType,
    uploadMethod,
    serialNumber,
    mbedUploadSerialNumberArgument: serialNumber ? ` -DMBED_UPLOAD_SERIAL_NUMBER:STRING=${serialNumber}` : "",
    buildDirectory: "",
    deployTarget: ""
  };
  return resolveBuildDirectory(template, values);
}

function expandConfiguredPath(configured: string, workspaceFolder: vscode.WorkspaceFolder, projectRootPath: string): string {
  const expanded = configured
    .replaceAll("${workspaceFolder}", workspaceFolder.uri.fsPath)
    .replaceAll("${workspaceFolderBasename}", workspaceFolder.name)
    .replaceAll("${projectRoot}", projectRootPath);
  const absolutePath = path.isAbsolute(expanded)
    ? expanded
    : path.join(projectRootPath, expanded);
  return path.normalize(absolutePath);
}

function toWorkspaceRelativeOrAbsolutePath(workspaceFolder: vscode.WorkspaceFolder, selectedFolder: vscode.Uri): string {
  const relative = path.relative(workspaceFolder.uri.fsPath, selectedFolder.fsPath);
  if (!relative.startsWith("..") && !path.isAbsolute(relative)) {
    return "${workspaceFolder}/" + relative.replaceAll("\\", "/");
  }

  return selectedFolder.fsPath;
}

type ConfiguredFolderPromptOptions = {
  currentUri: (workspaceFolder: vscode.WorkspaceFolder) => vscode.Uri;
  isCurrentValid: (currentUri: vscode.Uri) => Promise<boolean>;
  findSuggestions: (workspaceFolder: vscode.WorkspaceFolder) => Promise<vscode.Uri[]>;
  shouldPrompt: (info: WorkspaceInspection, suggestions: vscode.Uri[]) => boolean;
  warningMessage: (currentUri: vscode.Uri) => string;
  actionLabel: string;
  openLabel: string;
  defaultUri: (info: WorkspaceInspection, suggestions: vscode.Uri[]) => vscode.Uri;
  resolveSelection: (selectedFolder: vscode.Uri) => Promise<vscode.Uri | undefined>;
  invalidMessage: string;
  settingKey: "projectRootPath" | "mbedOsPath" | "customTargetsPath";
  successMessage: (resolvedFolder: vscode.Uri) => string;
};

export async function maybePromptForProjectRootPath(info: WorkspaceInspection): Promise<boolean> {
  return await maybePromptForConfiguredFolder(info, {
    currentUri: getConfiguredProjectRootUri,
    isCurrentValid: async (currentUri) => await fileExists(vscode.Uri.joinPath(currentUri, "CMakeLists.txt")),
    findSuggestions: findProjectRootCandidates,
    shouldPrompt: (workspaceInfo, suggestions) => workspaceInfo.isMbedCeProject || suggestions.length > 0,
    warningMessage: (currentUri) => `Configured project root was not found or does not contain CMakeLists.txt: ${currentUri.fsPath}`,
    actionLabel: "Set Project Root",
    openLabel: "Select Project Root Folder",
    defaultUri: (workspaceInfo, suggestions) => suggestions[0] ?? workspaceInfo.workspaceFolder!.uri,
    resolveSelection: resolveProjectRootSelection,
    invalidMessage: "The selected folder does not look like a project root. Select the folder that contains the top-level CMakeLists.txt file.",
    settingKey: "projectRootPath",
    successMessage: (resolvedFolder) => `Using project root: ${resolvedFolder.fsPath}`
  });
}

export async function maybePromptForMbedOsPath(info: WorkspaceInspection): Promise<boolean> {
  return await maybePromptForConfiguredFolder(info, {
    currentUri: getConfiguredMbedOsUri,
    isCurrentValid: async (currentUri) => await fileExists(vscode.Uri.joinPath(currentUri, "targets", "targets.json5")),
    findSuggestions: async () => [],
    shouldPrompt: (workspaceInfo) => workspaceInfo.isMbedCeProject,
    warningMessage: (currentUri) => `Configured Mbed OS folder was not found: ${currentUri.fsPath}`,
    actionLabel: "Set Mbed OS Path",
    openLabel: "Select Mbed OS Folder",
    defaultUri: (workspaceInfo) => getConfiguredProjectRootUri(workspaceInfo.workspaceFolder!),
    resolveSelection: resolveMbedOsFolderSelection,
    invalidMessage: "The selected folder does not look like an Mbed OS folder. Select the mbed-os folder itself or a parent folder that contains it.",
    settingKey: "mbedOsPath",
    successMessage: (resolvedFolder) => `Using Mbed OS path: ${resolvedFolder.fsPath}`
  });
}

export async function maybePromptForCustomTargetsPath(info: WorkspaceInspection): Promise<boolean> {
  return await maybePromptForConfiguredFolder(info, {
    currentUri: getConfiguredCustomTargetsUri,
    isCurrentValid: async (currentUri) => await fileExists(vscode.Uri.joinPath(currentUri, "custom_targets.json5")),
    findSuggestions: findCustomTargetsCandidates,
    shouldPrompt: (workspaceInfo, suggestions) => workspaceInfo.isMbedCeProject && suggestions.length > 0,
    warningMessage: (currentUri) => `Configured custom_targets folder was not found: ${currentUri.fsPath}`,
    actionLabel: "Set Custom Targets Path",
    openLabel: "Select custom_targets Folder",
    defaultUri: (_workspaceInfo, suggestions) => suggestions[0],
    resolveSelection: resolveCustomTargetsFolderSelection,
    invalidMessage: "The selected folder does not look like a custom_targets folder. Select the custom_targets folder itself or a parent folder that contains it.",
    settingKey: "customTargetsPath",
    successMessage: (resolvedFolder) => `Using custom_targets path: ${resolvedFolder.fsPath}`
  });
}

async function maybePromptForConfiguredFolder(info: WorkspaceInspection, options: ConfiguredFolderPromptOptions): Promise<boolean> {
  if (!info.workspaceFolder) {
    return false;
  }

  const currentUri = options.currentUri(info.workspaceFolder);
  if (await options.isCurrentValid(currentUri)) {
    return false;
  }

  const suggestions = await options.findSuggestions(info.workspaceFolder);
  if (!options.shouldPrompt(info, suggestions)) {
    return false;
  }

  const choice = await vscode.window.showWarningMessage(
    options.warningMessage(currentUri),
    options.actionLabel,
    "Ignore"
  );
  if (choice !== options.actionLabel) {
    return false;
  }

  const selection = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: options.openLabel,
    defaultUri: options.defaultUri(info, suggestions)
  });
  const selectedFolder = selection?.[0];
  if (!selectedFolder) {
    return false;
  }

  const resolvedFolder = await options.resolveSelection(selectedFolder);
  if (!resolvedFolder) {
    void vscode.window.showErrorMessage(options.invalidMessage);
    return false;
  }

  const configValue = toWorkspaceRelativeOrAbsolutePath(info.workspaceFolder, resolvedFolder);
  await vscode.workspace
    .getConfiguration("mbedCe", info.workspaceFolder.uri)
    .update(options.settingKey, configValue, vscode.ConfigurationTarget.WorkspaceFolder);
  void vscode.window.showInformationMessage(options.successMessage(resolvedFolder));
  return true;
}

async function resolveProjectRootSelection(selectedFolder: vscode.Uri): Promise<vscode.Uri | undefined> {
  if (await fileExists(vscode.Uri.joinPath(selectedFolder, "CMakeLists.txt"))) {
    return selectedFolder;
  }

  try {
    const entries = await vscode.workspace.fs.readDirectory(selectedFolder);
    const matches = await Promise.all(
      entries
        .filter(([, type]) => type === vscode.FileType.Directory)
        .map(async ([name]) => {
          const candidate = vscode.Uri.joinPath(selectedFolder, name);
          return (await fileExists(vscode.Uri.joinPath(candidate, "CMakeLists.txt"))) ? candidate : undefined;
        })
    );
    const resolved = matches.filter((candidate): candidate is vscode.Uri => Boolean(candidate));
    if (resolved.length === 1) {
      return resolved[0];
    }
  } catch {
    // Ignore unreadable folders and fall back to validation failure.
  }

  return undefined;
}

async function findProjectRootCandidates(workspaceFolder: vscode.WorkspaceFolder): Promise<vscode.Uri[]> {
  const found = await vscode.workspace.findFiles(
    new vscode.RelativePattern(workspaceFolder, "**/CMakeLists.txt"),
    "{**/.git/**,**/.vscode/**,**/build/**,**/dist/**,**/node_modules/**,**/mbed-os/**}",
    20
  );

  const candidateDirectories = found
    .map((uri) => vscode.Uri.file(path.dirname(uri.fsPath)))
    .filter((uri, index, list) => list.findIndex((entry) => entry.fsPath === uri.fsPath) === index)
    .sort((left, right) => left.fsPath.localeCompare(right.fsPath));

  const likelyProjectRoots = await Promise.all(
    candidateDirectories.map(async (candidate) => ((await isLikelyMbedCeProjectRoot(candidate)) ? candidate : undefined))
  );

  return likelyProjectRoots.filter((candidate): candidate is vscode.Uri => Boolean(candidate));
}

async function isLikelyMbedCeProjectRoot(candidate: vscode.Uri): Promise<boolean> {
  const likelyMarkers = [
    vscode.Uri.joinPath(candidate, "mbed-os"),
    vscode.Uri.joinPath(candidate, "custom_targets", "custom_targets.json5"),
    vscode.Uri.joinPath(candidate, ".vscode", "mbed-ce-targets.json5")
  ];

  for (const marker of likelyMarkers) {
    if (await fileExists(marker)) {
      return true;
    }
  }

  return false;
}

async function resolveMbedOsFolderSelection(selectedFolder: vscode.Uri): Promise<vscode.Uri | undefined> {
  const candidates = [selectedFolder, vscode.Uri.joinPath(selectedFolder, "mbed-os")];
  for (const candidate of candidates) {
    if (await fileExists(vscode.Uri.joinPath(candidate, "targets", "targets.json5"))) {
      return candidate;
    }
  }

  return undefined;
}

async function resolveCustomTargetsFolderSelection(selectedFolder: vscode.Uri): Promise<vscode.Uri | undefined> {
  const candidates = [selectedFolder, vscode.Uri.joinPath(selectedFolder, "custom_targets")];
  for (const candidate of candidates) {
    if (await fileExists(vscode.Uri.joinPath(candidate, "custom_targets.json5"))) {
      return candidate;
    }
  }

  return undefined;
}

async function findCustomTargetsCandidates(workspaceFolder: vscode.WorkspaceFolder): Promise<vscode.Uri[]> {
  const found = await vscode.workspace.findFiles(
    new vscode.RelativePattern(workspaceFolder, "**/custom_targets.json5"),
    "{**/.git/**,**/.vscode/**,**/build/**,**/dist/**,**/node_modules/**,**/mbed-os/**}",
    10
  );

  return found
    .map((uri) => vscode.Uri.file(path.dirname(uri.fsPath)))
    .filter((uri, index, list) => list.findIndex((entry) => entry.fsPath === uri.fsPath) === index)
    .sort((left, right) => left.fsPath.localeCompare(right.fsPath));
}

async function resolveTargetSource(workspaceFolder: vscode.WorkspaceFolder): Promise<TargetSourceResult> {
  const targetSelectorUri = getTargetSelectorUri(workspaceFolder);
  if (await fileExists(targetSelectorUri)) {
    try {
      const targetSelectorData = await readTargetSelectorData(targetSelectorUri);
      return {
        targets: targetSelectorData.targets,
        targetSettingsByName: targetSelectorData.targetSettingsByName,
        sourceLabel: TARGET_SELECTOR_RELATIVE_PATH
      };
    } catch {
      return { targets: [], targetSettingsByName: {}, sourceLabel: `${TARGET_SELECTOR_RELATIVE_PATH} (invalid)` };
    }
  }

  const generatedTargets: string[] = [];
  const generationSources: string[] = [];
  const customTargetsPath = vscode.Uri.joinPath(getConfiguredCustomTargetsUri(workspaceFolder), "custom_targets.json5");
  if (await fileExists(customTargetsPath)) {
    try {
      const targets = await readTargetDatabase(customTargetsPath);
      if (targets.length > 0) {
        generatedTargets.push(...targets);
        generationSources.push("custom_targets.json5");
      }
    } catch {
      // Ignore malformed target JSON while the file is being edited and fall back to other sources.
    }
  }

  const mbedTargetsPath = vscode.Uri.joinPath(getConfiguredMbedOsUri(workspaceFolder), "targets", "targets.json5");
  if (await fileExists(mbedTargetsPath)) {
    try {
      const targets = await readTargetDatabase(mbedTargetsPath);
      if (targets.length > 0) {
        generatedTargets.push(...targets);
        generationSources.push("targets.json5");
      }
    } catch {
      // Ignore malformed target JSON while the file is being edited and report no targets from this source.
    }
  }

  const targets = uniqueTargets(generatedTargets);
  if (targets.length > 0) {
    await writeGeneratedTargetSelector(workspaceFolder, targets, generationSources);
    return { targets, targetSettingsByName: Object.fromEntries(targets.map((target) => [target, {}])), sourceLabel: TARGET_SELECTOR_RELATIVE_PATH };
  }

  return { targets: [], targetSettingsByName: {}, sourceLabel: "" };
}

async function readTargetDatabase(uri: vscode.Uri): Promise<string[]> {
  const text = await readTextFile(uri);
  const parsed = JSON5.parse(text) as unknown;
  return extractTargetNames(parsed);
}

async function readTargetSelectorData(uri: vscode.Uri): Promise<{ targets: string[]; targetSettingsByName: Record<string, TargetSettings> }> {
  const text = await readTextFile(uri);
  const parsed = JSON5.parse(text) as unknown;

  if (!parsed || typeof parsed !== "object") {
    throw new Error("Invalid target selector format.");
  }

  const targets = (parsed as { targets?: unknown }).targets;
  if (!Array.isArray(targets)) {
    throw new Error("Target selector file is missing a targets array.");
  }

  const entries: Array<[string, TargetSettings]> = [];

  for (const entry of targets) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Each target entry must be an object.");
    }

    const name = typeof (entry as { name?: unknown }).name === "string"
      ? (entry as { name: string }).name.trim()
      : "";
    if (!name) {
      throw new Error("Each target entry must have a non-empty name.");
    }

    const uploadMethod = typeof (entry as { uploadMethod?: unknown }).uploadMethod === "string"
      ? (entry as { uploadMethod: string }).uploadMethod.trim()
      : undefined;
    const serialNumber = typeof (entry as { serialNumber?: unknown }).serialNumber === "string"
      ? (entry as { serialNumber: string }).serialNumber.trim()
      : undefined;

    entries.push([
      name,
      {
        uploadMethod: uploadMethod || undefined,
        serialNumber: serialNumber || undefined
      }
    ]);
  }

  const targetSettingsByName = Object.fromEntries(uniqueTargetEntries(entries));
  return {
    targets: Object.keys(targetSettingsByName),
    targetSettingsByName
  };
}

async function writeGeneratedTargetSelector(
  workspaceFolder: vscode.WorkspaceFolder,
  targets: string[],
  generationSources: string[]
): Promise<void> {
  const targetSelectorUri = getTargetSelectorUri(workspaceFolder);
  const targetSelectorDirectoryUri = vscode.Uri.joinPath(workspaceFolder.uri, ".vscode");
  const generationComments = [
    `  // Generated by Mbed CE Tools from ${generationSources.join(" and ")}.`,
    "  // Remove targets you do not want to appear in the selector."
  ];
  const content = [
    "{",
    "  // User-curated target list for Mbed CE Tools.",
    ...generationComments,
    "  targets: [",
    ...targets.map((target) => `    { name: ${JSON.stringify(target)} },`),
    "  ],",
    "}",
    ""
  ].join("\n");

  try {
    await vscode.workspace.fs.createDirectory(targetSelectorDirectoryUri);
    await vscode.workspace.fs.writeFile(targetSelectorUri, Buffer.from(content, "utf8"));
    void vscode.window.showInformationMessage(
      `Created ${TARGET_SELECTOR_RELATIVE_PATH} for Mbed CE Tools. You can edit it to hide targets or delete it to regenerate it.`
    );
  } catch {
    // Keep using the discovered targets even when the generated selector file cannot be written.
  }
}

function extractTargetNames(value: unknown): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return [];
  }

  return Object.entries(value as Record<string, unknown>)
    .filter(([, definition]) => isPublicTargetDefinition(definition))
    .map(([name]) => name);
}

function isPublicTargetDefinition(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  return (value as Record<string, unknown>).public !== false;
}

function uniqueTargets(values: string[]): string[] {
  return uniqueTargetEntries(values.map((value) => [value, {}] as [string, TargetSettings])).map(([name]) => name);
}

function uniqueTargetEntries(entries: Array<[string, TargetSettings]>): Array<[string, TargetSettings]> {
  const seen = new Set<string>();
  const result: Array<[string, TargetSettings]> = [];

  for (const [value, settings] of entries) {
    const trimmed = value.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }

    seen.add(trimmed);
    result.push([trimmed, settings]);
  }

  return result;
}

export function getSelectedDeployTarget(projectInfo: WorkspaceInspection, storedDeployTarget?: string): string {
  if (storedDeployTarget && projectInfo.deployTargets.includes(storedDeployTarget)) return storedDeployTarget;
  return projectInfo.deployTargets[0] ?? "";
}
async function readUploadMethodInfo(workspaceFolder: vscode.WorkspaceFolder, target: string): Promise<UploadMethodInfo | undefined> {
  const candidatePaths = [
    path.join(getConfiguredCustomTargetsPath(workspaceFolder), "upload_method_cfg", `${target}.cmake`),
    path.join(getConfiguredMbedOsPath(workspaceFolder), "targets", "upload_method_cfg", `${target}.cmake`)
  ];

  for (const candidatePath of candidatePaths) {
    const uri = vscode.Uri.file(candidatePath);
    if (!(await fileExists(uri))) continue;
    try {
      const text = await readTextFile(uri);
      const available = extractEnabledUploadMethods(text);
      const defaultMethod = extractDefaultUploadMethod(text);
      return { available: available.length > 0 ? available : ["NONE"], defaultMethod, sourcePath: candidatePath };
    } catch {
      // Fall back to NONE if a board upload-method file is malformed.
    }
  }

  return { available: ["NONE"] };
}

function extractEnabledUploadMethods(text: string): string[] {
  const methods: string[] = [];

  for (const argsText of extractSetCallArguments(text)) {
    const tokens = tokenizeCmakeArguments(argsText);
    if (tokens.length < 2) {
      continue;
    }

    const variableName = tokens[0]?.trim().toUpperCase();
    const value = tokens[1]?.trim().toUpperCase();
    if (!variableName?.endsWith("_UPLOAD_ENABLED") || value !== "TRUE") {
      continue;
    }

    methods.push(variableName.slice(0, -"_UPLOAD_ENABLED".length));
  }

  return [...new Set(methods)].sort((left, right) => left.localeCompare(right));
}

function extractDefaultUploadMethod(text: string): string | undefined {
  for (const argsText of extractSetCallArguments(text)) {
    const tokens = tokenizeCmakeArguments(argsText);
    if (tokens.length < 2) {
      continue;
    }

    const variableName = tokens[0]?.trim().toUpperCase();
    if (variableName !== "UPLOAD_METHOD_DEFAULT") {
      continue;
    }

    const value = tokens[1]?.trim().toUpperCase();
    if (value) {
      return value;
    }
  }

  return undefined;
}

function extractSetCallArguments(text: string): string[] {
  const results: string[] = [];
  const pattern = /\bset\s*\(/gi;

  while (pattern.exec(text) !== null) {
    let index = pattern.lastIndex;
    let depth = 1;
    let inQuote = false;
    let escaped = false;

    while (index < text.length) {
      const char = text[index];

      if (escaped) {
        escaped = false;
        index += 1;
        continue;
      }

      if (char === "\\") {
        escaped = true;
        index += 1;
        continue;
      }

      if (char === "\"") {
        inQuote = !inQuote;
        index += 1;
        continue;
      }

      if (!inQuote) {
        if (char === "(") {
          depth += 1;
        } else if (char === ")") {
          depth -= 1;
          if (depth === 0) {
            results.push(text.slice(pattern.lastIndex, index));
            break;
          }
        }
      }

      index += 1;
    }
  }

  return results;
}

function tokenizeCmakeArguments(value: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuote = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];

    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }

    if (char === "\\") {
      escaped = true;
      continue;
    }

    if (char === "\"") {
      inQuote = !inQuote;
      continue;
    }

    if (!inQuote && /\s/.test(char)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (current) {
    tokens.push(current);
  }

  return tokens;
}
