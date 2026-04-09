import * as vscode from "vscode";

export type ProjectAction = "configure" | "cleanBuild" | "build" | "buildDeploy";

export type ActionCommand = "mbed-ce.configure" | "mbed-ce.cleanBuild" | "mbed-ce.build" | "mbed-ce.buildDeploy";

export type SidebarCommand =
  | ActionCommand
  | "mbed-ce.stop"
  | "mbed-ce.newProject"
  | "mbed-ce.loadProject"
  | "mbed-ce.showStartPage"
  | "mbed-ce.showProjectPage"
  | "mbed-ce.checkRequirements"
  | "mbed-ce.selectTarget"
  | "mbed-ce.selectBuildType"
  | "mbed-ce.selectUploadMethod";

export type UploadMethodInfo = {
  available: string[];
  defaultMethod?: string;
  sourcePath?: string;
};

export type TargetSettings = {
  uploadMethod?: string;
  serialNumber?: string;
};

export type WorkspaceInspection = {
  workspaceFolder?: vscode.WorkspaceFolder;
  projectRootPath?: string;
  isMbedCeProject: boolean;
  summary: string;
  targets: string[];
  selectedTargetSettings?: TargetSettings;
  uploadMethodInfo?: UploadMethodInfo;
  deployTargets: string[];
};

export type TemplateValues = {
  workspaceFolder: string;
  projectRoot: string;
  target: string;
  buildType: string;
  uploadMethod: string;
  serialNumber: string;
  mbedUploadSerialNumberArgument: string;
  buildDirectory: string;
  deployTarget: string;
};

export type RequirementCheck = {
  label: string;
  command: string;
};

export type RequirementCheckResult = {
  label: string;
  ok: boolean;
  details: string;
};

export type ExtensionCheckResult = {
  id: string;
  ok: boolean;
  details: string;
};

export type TargetSourceResult = {
  targets: string[];
  targetSettingsByName: Record<string, TargetSettings>;
  sourceLabel: string;
};

export type RunningExecution = {
  terminate: () => void;
};




