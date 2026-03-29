export const BUILD_TYPE_OPTIONS = ["Debug", "Develop", "Release"] as const;

export const TARGET_STATE_KEY = "selectedTarget";
export const BUILD_TYPE_STATE_KEY = "selectedBuildType";
export const UPLOAD_METHOD_STATE_KEY = "selectedUploadMethod";
export const DEPLOY_TARGET_STATE_KEY = "selectedDeployTarget";
export const MBED_CE_TOOLCHAIN_INSTALL_URL = "https://mbed-ce.dev/getting-started/toolchain-install/";
export const MBED_CE_DOCS_URL = "https://mbed-ce.dev/";
export const REQUIREMENT_CHECK_TIMEOUT_MS = 15000;
export const DEFAULT_PROJECT_TEMPLATE_SOURCE = "https://github.com/mbed-ce/mbed-ce-hello-world.git";
export const MBED_CE_FILE_API_CLIENT = "vscode-mbed-ce-tools";
export const TARGET_SELECTOR_RELATIVE_PATH = ".vscode/mbed-ce-targets.json5";

export const REVEAL_SIDEBAR_AFTER_PROJECT_OPEN_STATE_KEY = "mbedCe.revealSidebarAfterProjectOpen";
export const CPPTOOLS_CONFIGURATION_PROVIDER_ID = "mbed-ce.vscode-mbed-ce-tools";
