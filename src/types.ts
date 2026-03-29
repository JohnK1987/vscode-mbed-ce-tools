import * as vscode from "vscode";

export type ProjectAction = "configure" | "cleanBuild" | "build" | "buildDeploy";

export type ActionCommand = "mbedCe.configure" | "mbedCe.cleanBuild" | "mbedCe.build" | "mbedCe.buildDeploy";

export type SidebarCommand =
  | ActionCommand
  | "mbedCe.stop"
  | "mbedCe.newProject"
  | "mbedCe.loadProject"
  | "mbedCe.showStartPage"
  | "mbedCe.showProjectPage"
  | "mbedCe.checkRequirements"
  | "mbedCe.selectTarget"
  | "mbedCe.selectBuildType"
  | "mbedCe.selectUploadMethod";

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




