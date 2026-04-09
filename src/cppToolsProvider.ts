import * as path from "path";
import * as vscode from "vscode";
import { resolveBuildDirectory } from "./actionHelpers";
import { CPPTOOLS_CONFIGURATION_PROVIDER_ID } from "./constants";
import { readTextFile } from "./fsUtils";
import { TemplateValues, WorkspaceInspection } from "./types";

type ProviderDependencies = {
  inspectWorkspace: () => Promise<WorkspaceInspection>;
  getSelectedTarget: (projectInfo?: WorkspaceInspection) => Promise<string | undefined>;
  getSelectedBuildType: () => string;
  getSelectedUploadMethod: (projectInfo?: WorkspaceInspection) => string;
};

type CppToolsApi = {
  registerCustomConfigurationProvider(provider: CppToolsProvider): void;
  notifyReady(provider: CppToolsProvider): void;
  didChangeCustomConfiguration(provider: CppToolsProvider): void;
};

type CppToolsExtensionExports = {
  getApi(version: number): CppToolsApi;
};

type SourceFileConfiguration = {
  includePath: string[];
  defines: string[];
  compilerArgs?: string[];
  forcedInclude?: string[];
  compilerPath?: string;
  standard?: string;
  intelliSenseMode?: string;
};

type SourceFileConfigurationItem = {
  uri: vscode.Uri;
  configuration: SourceFileConfiguration;
};

type WorkspaceBrowseConfiguration = {
  browsePath: string[];
  compilerPath?: string;
  compilerArgs?: string[];
  standard?: string;
  windowsSdkVersion?: string;
};

type CompileCommandsCache = {
  compileCommandsPath: string;
  mtimeMs: number;
  entries: Map<string, SourceFileConfiguration>;
  browse: WorkspaceBrowseConfiguration;
};

type CompileCommandsItem = {
  directory?: unknown;
  file?: unknown;
  command?: unknown;
  arguments?: unknown;
};

const CPPTOOLS_EXTENSION_ID = "ms-vscode.cpptools";
const CPPTOOLS_PROVIDER_EXTENSION_ID = CPPTOOLS_CONFIGURATION_PROVIDER_ID;
const CPPTOOLS_API_VERSION = 7;
const DEFAULT_BROWSE_CONFIGURATION: WorkspaceBrowseConfiguration = { browsePath: [] };

export type CppToolsProviderHandle = {
  hasActiveConfiguration: () => Promise<boolean>;
  refresh: () => Promise<void>;
  dispose: () => void;
};

type CppToolsProvider = MbedCeCppToolsProvider;

export async function registerCppToolsProvider(dependencies: ProviderDependencies): Promise<CppToolsProviderHandle> {
  const extension = vscode.extensions.getExtension<CppToolsExtensionExports>(CPPTOOLS_EXTENSION_ID);
  if (!extension) {
    return { hasActiveConfiguration: async () => false, refresh: async () => undefined, dispose: () => undefined };
  }

  let exportsObject: CppToolsExtensionExports | undefined;
  try {
    exportsObject = extension.isActive ? extension.exports : await extension.activate();
  } catch {
    return { hasActiveConfiguration: async () => false, refresh: async () => undefined, dispose: () => undefined };
  }

  if (!exportsObject?.getApi) {
    return { hasActiveConfiguration: async () => false, refresh: async () => undefined, dispose: () => undefined };
  }

  let api: CppToolsApi | undefined;
  try {
    api = exportsObject.getApi(CPPTOOLS_API_VERSION);
  } catch {
    return { hasActiveConfiguration: async () => false, refresh: async () => undefined, dispose: () => undefined };
  }

  const provider = new MbedCeCppToolsProvider(dependencies);
  let isRegistered = false;

  return {
    hasActiveConfiguration: async () => await provider.hasActiveConfiguration(),
    refresh: async () => {
      await provider.refreshNow();
      const hasActiveConfiguration = await provider.hasActiveConfiguration();
      if (hasActiveConfiguration && !isRegistered) {
        api?.registerCustomConfigurationProvider(provider);
        api?.notifyReady(provider);
        isRegistered = true;
        return;
      }

      if (hasActiveConfiguration && isRegistered) {
        api?.didChangeCustomConfiguration(provider);
      }
    },
    dispose: () => {
      provider.dispose();
    }
  };
}

class MbedCeCppToolsProvider {
  public readonly name = "Mbed CE Tools";
  public readonly extensionId = CPPTOOLS_PROVIDER_EXTENSION_ID;

  private activeCompileCommandsPath: string | undefined;
  private cache: CompileCommandsCache | undefined;
  private disposed = false;
  private refreshGeneration = 0;

  constructor(private readonly dependencies: ProviderDependencies) {}

  async refreshNow(): Promise<void> {
    if (this.disposed) {
      return;
    }

    const generation = ++this.refreshGeneration;
    try {
      await this.refreshActiveCompileCommandsPath(generation);
    } catch {
      // Ignore refresh failures and let C/C++ fall back normally.
    }
  }

  async canProvideConfiguration(uri: vscode.Uri): Promise<boolean> {
    if (this.disposed) {
      return false;
    }

    const cache = await this.getCompileCommandsCache();
    if (!cache) {
      return false;
    }

    return cache.entries.has(normalizeFsPath(uri.fsPath));
  }

  async provideConfigurations(uris: vscode.Uri[]): Promise<SourceFileConfigurationItem[]> {
    const cache = await this.getCompileCommandsCache();
    if (!cache) {
      return [];
    }

    return uris
      .map((uri) => {
        const configuration = cache.entries.get(normalizeFsPath(uri.fsPath));
        return configuration ? { uri, configuration } : undefined;
      })
      .filter((item): item is SourceFileConfigurationItem => Boolean(item));
  }

  async canProvideBrowseConfiguration(): Promise<boolean> {
    return (await this.getCompileCommandsCache()) !== undefined;
  }

  async provideBrowseConfiguration(): Promise<WorkspaceBrowseConfiguration> {
    return (await this.getCompileCommandsCache())?.browse ?? DEFAULT_BROWSE_CONFIGURATION;
  }

  async canProvideBrowseConfigurationsPerFolder(): Promise<boolean> {
    return (await this.getCompileCommandsCache()) !== undefined;
  }

  async provideFolderBrowseConfiguration(_uri: vscode.Uri): Promise<WorkspaceBrowseConfiguration> {
    return (await this.getCompileCommandsCache())?.browse ?? DEFAULT_BROWSE_CONFIGURATION;
  }

  dispose(): void {
    this.disposed = true;
    this.activeCompileCommandsPath = undefined;
    this.cache = undefined;
  }

  async hasActiveConfiguration(): Promise<boolean> {
    return (await this.getCompileCommandsCache()) !== undefined;
  }

  private async getCompileCommandsCache(): Promise<CompileCommandsCache | undefined> {
    if (this.disposed) {
      return undefined;
    }

    const compileCommandsPath = this.activeCompileCommandsPath;
    if (!compileCommandsPath) {
      return undefined;
    }

    const compileCommandsUri = vscode.Uri.file(compileCommandsPath);

    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(compileCommandsUri);
    } catch {
      this.activeCompileCommandsPath = undefined;
      this.cache = undefined;
      return undefined;
    }

    if (
      this.cache &&
      this.cache.compileCommandsPath === compileCommandsPath &&
      this.cache.mtimeMs === stat.mtime
    ) {
      return this.cache;
    }

    try {
      const parsed = JSON.parse(await readTextFile(compileCommandsUri)) as CompileCommandsItem[];
      const entries = new Map<string, SourceFileConfiguration>();
      const browsePaths = new Set<string>();
      let browseCompilerPath: string | undefined;
      let browseCompilerArgs: string[] | undefined;
      let browseStandard: string | undefined;

      for (const item of parsed) {
        const directory = typeof item.directory === "string" ? item.directory : undefined;
        const file = typeof item.file === "string" ? item.file : undefined;
        const command = typeof item.command === "string" ? item.command : undefined;
        const argumentsList = Array.isArray(item.arguments) && item.arguments.every((entry) => typeof entry === "string")
          ? (item.arguments as string[])
          : undefined;
        if (!file || (!command && !argumentsList)) {
          continue;
        }

        const tokens = argumentsList ?? tokenizeCommandLine(command!);
        const configuration = parseCompileCommand(tokens, directory);
        if (!configuration) {
          continue;
        }

        entries.set(normalizeFsPath(resolveRequiredPath(file, directory)), configuration);
        for (const includePath of configuration.includePath) {
          browsePaths.add(includePath);
        }
        browseCompilerPath ??= configuration.compilerPath;
        browseCompilerArgs ??= configuration.compilerArgs;
        browseStandard ??= configuration.standard;
      }

      if (entries.size === 0) {
        this.cache = undefined;
        return undefined;
      }

      this.cache = {
        compileCommandsPath,
        mtimeMs: stat.mtime,
        entries,
        browse: {
          browsePath: [...browsePaths].sort((left, right) => left.localeCompare(right)),
          compilerPath: browseCompilerPath,
          compilerArgs: browseCompilerArgs,
          standard: browseStandard
        }
      };
      return this.cache;
    } catch {
      this.cache = undefined;
      return undefined;
    }
  }

  private async refreshActiveCompileCommandsPath(generation: number): Promise<void> {
    const compileCommandsPath = await this.resolveActiveCompileCommandsPath();
    if (this.disposed || this.refreshGeneration !== generation) {
      return;
    }

    this.activeCompileCommandsPath = compileCommandsPath;
    if (!compileCommandsPath) {
      this.cache = undefined;
      return;
    }

    await this.getCompileCommandsCache();
  }

  private async resolveActiveCompileCommandsPath(): Promise<string | undefined> {
    const buildDirectory = await this.resolveActiveBuildDirectory();
    if (!buildDirectory) {
      return undefined;
    }

    const compileCommandsPath = path.join(buildDirectory, "compile_commands.json");
    try {
      await vscode.workspace.fs.stat(vscode.Uri.file(compileCommandsPath));
      return compileCommandsPath;
    } catch {
      return undefined;
    }
  }

  private async resolveActiveBuildDirectory(): Promise<string | undefined> {
    const projectInfo = await this.dependencies.inspectWorkspace();
    if (!projectInfo.workspaceFolder || !projectInfo.isMbedCeProject) {
      return undefined;
    }

    const target = await this.dependencies.getSelectedTarget(projectInfo);
    if (!target) {
      return undefined;
    }

    const workspaceFolderPath = projectInfo.workspaceFolder.uri.fsPath;
    const projectRootPath = projectInfo.projectRootPath ?? workspaceFolderPath;
    const buildType = this.dependencies.getSelectedBuildType();
    const uploadMethod = this.dependencies.getSelectedUploadMethod(projectInfo);
    const serialNumber = projectInfo.selectedTargetSettings?.serialNumber ?? "";
    const buildDirectoryTemplate = vscode.workspace
      .getConfiguration("mbed-ce", projectInfo.workspaceFolder.uri)
      .get<string>("buildDirectory", "${projectRoot}/build/${target}-${buildType}");
    const values: TemplateValues = {
      workspaceFolder: workspaceFolderPath,
      projectRoot: projectRootPath,
      target,
      buildType,
      uploadMethod,
      serialNumber,
      mbedUploadSerialNumberArgument: serialNumber ? ` -DMBED_UPLOAD_SERIAL_NUMBER:STRING=${serialNumber}` : "",
      buildDirectory: "",
      deployTarget: ""
    };
    return resolveBuildDirectory(buildDirectoryTemplate, values);
  }
}

function parseCompileCommand(tokens: string[], workingDirectory?: string): SourceFileConfiguration | undefined {
  if (tokens.length === 0) {
    return undefined;
  }

  const includePath: string[] = [];
  const defines: string[] = [];
  const forcedInclude: string[] = [];
  const compilerArgs: string[] = [];
  const compilerPath = resolveOptionalToolPath(tokens[0], workingDirectory);
  let standard: string | undefined;

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (!token) {
      continue;
    }

    if (token === "-I") {
      const nextValue = tokens[index + 1];
      if (nextValue) {
        includePath.push(normalizeFsPath(resolveRequiredPath(nextValue, workingDirectory)));
        index += 1;
      }
      continue;
    }

    if (token.startsWith("-I")) {
      includePath.push(normalizeFsPath(resolveRequiredPath(token.slice(2), workingDirectory)));
      continue;
    }

    if (token === "-D") {
      const nextValue = tokens[index + 1];
      if (nextValue) {
        defines.push(nextValue);
        index += 1;
      }
      continue;
    }

    if (token.startsWith("-D")) {
      defines.push(token.slice(2));
      continue;
    }

    if (token === "-include") {
      const nextValue = tokens[index + 1];
      if (nextValue) {
        forcedInclude.push(normalizeFsPath(resolveRequiredPath(nextValue, workingDirectory)));
        compilerArgs.push(token, nextValue);
        index += 1;
      }
      continue;
    }

    if (token.startsWith("-include")) {
      const value = token.slice("-include".length);
      if (value) {
        forcedInclude.push(normalizeFsPath(resolveRequiredPath(value, workingDirectory)));
      }
      compilerArgs.push(token);
      continue;
    }

    if (token === "-o") {
      index += 1;
      continue;
    }

    if (token === "-c") {
      index += 1;
      continue;
    }

    if (token.startsWith("-std=")) {
      standard = normalizeLanguageStandard(token.slice(5));
      compilerArgs.push(token);
      continue;
    }

    compilerArgs.push(token);
  }

  return {
    includePath: uniqueSorted(includePath),
    defines: uniqueSorted(defines),
    compilerArgs,
    forcedInclude: uniqueSorted(forcedInclude),
    compilerPath,
    standard,
    intelliSenseMode: inferIntelliSenseMode(compilerPath)
  };
}

function tokenizeCommandLine(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let inQuotes = false;

  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];

    if (char === '"') {
      inQuotes = !inQuotes;
      continue;
    }

    if (!inQuotes && /\s/.test(char)) {
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

function inferIntelliSenseMode(compilerPath?: string): string | undefined {
  const normalized = compilerPath?.replaceAll("\\", "/").toLowerCase();
  if (!normalized) {
    return undefined;
  }

  if (normalized.includes("arm-none-eabi")) {
    return "gcc-arm";
  }
  if (normalized.includes("clang")) {
    return process.platform === "win32" ? "windows-clang-x64" : process.platform === "darwin" ? "macos-clang-x64" : "linux-clang-x64";
  }
  if (normalized.includes("g++") || normalized.includes("gcc")) {
    return process.platform === "win32" ? "gcc-x64" : process.platform === "darwin" ? "macos-gcc-x64" : "linux-gcc-x64";
  }

  return undefined;
}

function normalizeLanguageStandard(standard: string): string {
  return standard
    .replace(/^gnu\+\+/, "c++")
    .replace(/^gnu/, "c");
}

function normalizeFsPath(value: string): string {
  const normalized = path.normalize(value);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function resolveRequiredPath(value: string, baseDirectory?: string): string {
  if (path.isAbsolute(value) || !baseDirectory) {
    return path.normalize(value);
  }

  return path.normalize(path.join(baseDirectory, value));
}

function resolveOptionalToolPath(value: string, baseDirectory?: string): string {
  if (!baseDirectory || path.isAbsolute(value)) {
    return path.normalize(value);
  }

  if (value.startsWith(".") || value.includes("/") || value.includes("\\")) {
    return path.normalize(path.join(baseDirectory, value));
  }

  return value;
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values)].sort((left, right) => left.localeCompare(right));
}
