import * as path from "path";
import * as vscode from "vscode";
import { MBED_CE_FILE_API_CLIENT } from "./constants";
import { readTextFile } from "./fsUtils";

type CMakeFileApiIndex = {
  objects?: Array<{
    kind?: string;
    version?: { major?: number };
    jsonFile?: string;
  }>;
  reply?: Record<string, unknown>;
};

type CMakeFileApiCodemodel = {
  configurations?: Array<{
    name?: string;
    targets?: Array<{ jsonFile?: string }>;
  }>;
};

type CMakeFileApiTarget = {
  name?: string;
  type?: string;
};

export async function readConfiguredExecutableTargets(buildDirectory: string, configurationName?: string): Promise<string[]> {
  const replyDirectory = vscode.Uri.file(path.join(buildDirectory, ".cmake", "api", "v1", "reply"));
  if (!(await uriExists(replyDirectory))) {
    return [];
  }

  const indexUri = await readLatestIndexFile(replyDirectory);
  if (!indexUri) {
    return [];
  }

  try {
    const index = JSON.parse(await readTextFile(indexUri)) as CMakeFileApiIndex;
    const codemodelJsonFile = resolveCodemodelJsonFile(index);
    if (!codemodelJsonFile) {
      return [];
    }

    const codemodelUri = vscode.Uri.joinPath(replyDirectory, codemodelJsonFile);
    const codemodel = JSON.parse(await readTextFile(codemodelUri)) as CMakeFileApiCodemodel;
    const configurations = codemodel.configurations ?? [];
    if (configurations.length === 0) {
      return [];
    }

    const selectedConfiguration = configurations.find((configuration) => configuration.name === configurationName) ?? configurations[0];
    const targets = selectedConfiguration.targets ?? [];
    const executableTargets = new Set<string>();
    const allTargetNames = new Set<string>();

    for (const target of targets) {
      if (!target.jsonFile) {
        continue;
      }

      const targetUri = vscode.Uri.joinPath(replyDirectory, target.jsonFile);
      const targetObject = JSON.parse(await readTextFile(targetUri)) as CMakeFileApiTarget;
      if (typeof targetObject.name === "string") {
        allTargetNames.add(targetObject.name);
        if (targetObject.type === "EXECUTABLE") {
          executableTargets.add(targetObject.name);
        }
      }
    }

    return [...executableTargets]
      .filter((targetName) => allTargetNames.has(`flash-${targetName}`))
      .sort((left, right) => left.localeCompare(right));
  } catch {
    return [];
  }
}

function resolveCodemodelJsonFile(index: CMakeFileApiIndex): string | undefined {
  const clientReply = index.reply?.[`client-${MBED_CE_FILE_API_CLIENT}`] as Record<string, unknown> | undefined;
  const clientCodemodelReply = clientReply?.["codemodel-v2"] as { jsonFile?: string } | undefined;
  if (clientCodemodelReply?.jsonFile) {
    return clientCodemodelReply.jsonFile;
  }

  const standardCodemodelReply = index.objects?.find(
    (object) => object.kind === "codemodel" && object.version?.major === 2 && typeof object.jsonFile === "string"
  );
  return standardCodemodelReply?.jsonFile;
}

async function readLatestIndexFile(replyDirectory: vscode.Uri): Promise<vscode.Uri | undefined> {
  try {
    const entries = await vscode.workspace.fs.readDirectory(replyDirectory);
    const indexFiles = entries
      .filter(([name, type]) => type === vscode.FileType.File && /^index-.*\.json$/i.test(name))
      .map(([name]) => name)
      .sort((left, right) => right.localeCompare(left));

    return indexFiles[0] ? vscode.Uri.joinPath(replyDirectory, indexFiles[0]) : undefined;
  } catch {
    return undefined;
  }
}

async function uriExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}
