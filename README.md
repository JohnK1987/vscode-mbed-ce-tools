# Mbed CE Tools

> This extension is currently in Alpha (tested on Windows only for now).

VS Code extension for **Mbed CE projects** and the **current CMake + CLI-based workflow**, not the legacy ARM Mbed toolchain.

## What It Does

The extension acts as a thin VS Code UI layer over the existing Mbed CE build system.

Current features:

- start screen with entry points for `Check Requirements`, `New Project`, and `Load Project`
- optional return to the Mbed CE view after `New Project` or `Load Project` reopens the workspace folder
- workflow screen with selectors for:
  - Board
  - Profile
  - Upload method
  - Deploy target when multiple deployable targets exist
- workflow actions:
  - `Configure`
  - `Clean Build`
  - `Build`
  - `Deploy`
- inline action-status row with live state and cancel support while an action is running
- status bar shortcuts for `Configure`, `Clean`, `Build`, and `Stop`, plus `Deploy` when a real deploy target is detected; selector changes refresh both the sidebar and status bar together
- project-aware target discovery and upload-method parsing
- configurable command templates and build directory layout
- requirements check for core CLI tools and recommended VS Code extensions
- new-project creation by cloning the official `mbed-ce-hello-world` starter or a user-defined git source

## Current Workflow

Typical flow:

1. `Check Requirements`
2. `New Project` or `Load Project`
3. select `Board`
4. select `Profile`
5. select `Upload Method`
6. if needed, select `Deploy Target`
7. run `Configure`, `Clean Build`, `Build`, or `Deploy` (`Deploy` becomes available after `Configure` when CMake File API target data exists)

The extension is designed to stay close to the real Mbed CE command-line flow instead of hiding it behind a separate build implementation.

## Target Discovery

Target discovery order:

1. use `.vscode/mbed-ce-targets.json5` if it already exists
2. otherwise parse `${mbedCe.customTargetsPath}/custom_targets.json5` and `${mbedCe.mbedOsPath}/targets/targets.json5`, then generate `.vscode/mbed-ce-targets.json5`
3. otherwise parse `${mbedCe.mbedOsPath}/targets/targets.json5`, then generate `.vscode/mbed-ce-targets.json5`

Only public targets are included when reading from JSON5 target databases. After `.vscode/mbed-ce-targets.json5` exists, the extension treats it as a user-curated target list and does not overwrite it during normal inspection or UI refreshes. When the extension generates the helper file, it shows a notification so the new file does not come as a surprise. The file is safe to edit manually or delete if you want the extension to regenerate it later. A top-level `CMakeLists.txt` alone does not enable the Mbed workflow UI.

The selector file format is:

```json5
{
  targets: [
    { name: "NUCLEO_F767ZI", uploadMethod: "STM32CUBE", serialNumber: "066EFF515153898367074825" },
    { name: "NUCLEO_L452RE_P" },
  ],
}
```

Each target entry requires `name`. `uploadMethod` and `serialNumber` are optional.

If `serialNumber` is present for the selected target, the configure step automatically adds:

- `-DMBED_UPLOAD_SERIAL_NUMBER:STRING=<serialNumber>`

## Upload Method Discovery

When a board is selected, the extension looks for upload-method configuration in:

1. `${mbedCe.customTargetsPath}/upload_method_cfg/<TARGET>.cmake`
2. `${mbedCe.mbedOsPath}/targets/upload_method_cfg/<TARGET>.cmake`

It parses:

- `UPLOAD_METHOD_DEFAULT`
- enabled `*_UPLOAD_ENABLED TRUE` entries

Those values are used to populate the upload-method selector.

Upload-method selection priority is:

1. previously stored workspace selection
2. the selected target's preferred upload method from `.vscode/mbed-ce-targets.json5`, if present and supported by the selected board
3. the board default from `UPLOAD_METHOD_DEFAULT`
4. the first available method

Changing the selected upload method invalidates the previous configured build. `Build` and `Deploy` automatically reconfigure when the current build directory does not match the selected board, profile, upload method, or target serial number.

If no upload-method information can be resolved, the safe fallback is `NONE`.

## Deploy Target Detection

Deploy targets are taken only from the selected build directory via the CMake File API after configure. The extension no longer guesses deploy targets from source parsing, and it only offers executable targets that also have a matching `flash-*` target in the configured build tree. When a build directory was configured outside this extension, the parser also accepts the standard codemodel reply objects written by CMake.

If more than one deploy target is found, the UI shows a Deploy Target selector and the deploy command uses that selected target. If no real deploy target can be detected yet, Deploy stays unavailable until the project has been configured.

## Commands And Defaults

Default command templates are exposed as extension settings.

Important defaults:

- `mbedCe.buildDirectory`
  - `${projectRoot}/build/${target}-${buildType}`
- `mbedCe.configureCommand`
  - `cmake -DCMAKE_BUILD_TYPE:STRING=${buildType} -DMBED_TARGET:STRING=${target} -DUPLOAD_METHOD:STRING=${uploadMethod}${mbedUploadSerialNumberArgument} -DCMAKE_EXPORT_COMPILE_COMMANDS:BOOL=TRUE --no-warn-unused-cli -S "${projectRoot}" -B "${buildDirectory}" -G Ninja`
- `mbedCe.buildCommand`
  - `cmake --build "${buildDirectory}" --config ${buildType} --target all --`
- `mbedCe.deployCommand`
  - `cmake --build "${buildDirectory}" --config ${buildType} --target flash-${deployTarget} --`

Behavior:

- `Configure` runs the explicit configure command
- `Build` configures first if the selected build directory is missing or no longer matches the current board, profile, upload method, or target serial number
- `Clean Build` deletes the selected build directory only when it resolves to a dedicated build-like path under the project/workspace, then configures and builds again
- `Deploy` configures first if needed, then runs the flash target
- while an action is running, the workflow page shows a live status row and lets you cancel the active task
- on Windows, build tasks and requirement checks run through `powershell.exe` from `PATH`, so custom command templates and requirement commands should use PowerShell-compatible syntax
- `${mbedUploadSerialNumberArgument}` expands to ` -DMBED_UPLOAD_SERIAL_NUMBER:STRING=<serialNumber>` when the selected target entry contains `serialNumber`; otherwise it expands to an empty string

## Settings

Main extension settings:

- `mbedCe.toolchainCheckCommands`
- `mbedCe.buildDirectory`
- `mbedCe.configureCommand`
- `mbedCe.buildCommand`
- `mbedCe.deployCommand`
- `mbedCe.defaultBuildType`
- `mbedCe.revealViewAfterProjectOpen`
- `mbedCe.manageCppToolsProvider`
- `mbedCe.recommendedExtensionIds`
- `mbedCe.projectTemplate`
- `mbedCe.projectRootPath`
- `mbedCe.defaultProjectsRoot`
- `mbedCe.mbedOsPath`
- `mbedCe.customTargetsPath`

Notes:

- `mbedCe.projectTemplate` can point to a custom git repository URL or a local git repository path for `New Project`
- `mbedCe.defaultProjectsRoot` sets the starting folder for `New Project` and `Load Project`; if it is empty, the user home folder is used
- `mbedCe.projectRootPath` defaults to `${workspaceFolder}`, is project-specific, and points to the folder that contains the main `CMakeLists.txt` file used for configure/build actions and project parsing; it expects the folder path, not the `CMakeLists.txt` file path
- if the configured project root is missing or does not contain `CMakeLists.txt`, the extension prompts the user to select the correct folder when the workspace still contains a likely Mbed CE project root; changing `mbedCe.projectRootPath` to an invalid value reruns that repair flow
- relative `mbedCe.buildDirectory` values are resolved from `${projectRoot}` and control where Configure, Build, and Deploy store their generated build output
- `mbedCe.configureCommand` supports `${mbedUploadSerialNumberArgument}`, which expands to the serial-number CMake define when the selected target entry provides `serialNumber`
- `mbedCe.mbedOsPath` defaults to `${projectRoot}/mbed-os`, is project-specific, and is used for Mbed OS target parsing and upload-method parsing; it expects the `mbed-os` folder itself, not the `targets.json5` file path
- if the configured Mbed OS folder is missing or does not contain `targets/targets.json5`, the extension prompts the user to select the correct folder after project load and accepts either the `mbed-os` folder itself or a parent folder that contains it
- `mbedCe.customTargetsPath` defaults to `${projectRoot}/custom_targets`, is project-specific, and is used for custom target parsing and custom upload-method parsing; it expects the `custom_targets` folder itself, not the `custom_targets.json5` file path
- if the configured `custom_targets` folder is missing or does not contain `custom_targets.json5`, but the extension finds `custom_targets.json5` elsewhere in the workspace, it prompts the user to select the correct folder and accepts either the `custom_targets` folder itself or a parent folder that contains it
- `.vscode/mbed-ce-targets.json5` is stored at the workspace level and can be edited manually to remove unwanted targets from the selector or add per-target `uploadMethod` and `serialNumber` values; if you delete it, the extension can regenerate it from the configured target databases
- `mbedCe.manageCppToolsProvider` lets the extension select `Mbed CE Tools` as the active C/C++ configuration provider for Mbed CE workspaces so IntelliSense follows the current configured build
- if `mbedCe.manageCppToolsProvider` is disabled, the extension clears the active C/C++ provider only when it is currently `Mbed CE Tools`

## Requirements Check

The requirements check currently reports:

- command-line tools such as `git`, `python`, `cmake`, `ninja`, and `arm-none-eabi-gcc`
- recommended VS Code extensions such as `cpptools` and `cortex-debug`

`CMake Tools` is not required for the extension workflow.

## Load Project

`Load Project` currently:

- opens a folder picker starting in `mbedCe.defaultProjectsRoot` when it is set
- falls back to the user home folder when `mbedCe.defaultProjectsRoot` is empty
- reopens the selected folder as the current VS Code workspace
- can optionally reveal the Mbed CE view after the workspace is reopened when `mbedCe.revealViewAfterProjectOpen` is enabled

## New Project

`New Project` currently:

- asks for a parent folder
- asks for the new project folder name
- validates Windows-reserved names and trailing space/period cases before cloning
- clones `mbed-ce-hello-world` by default using `git clone --recurse-submodules`
- shows clone progress in the `Mbed CE Tasks` output channel while the starter is being downloaded
- can clone from a custom Git source when `mbedCe.projectTemplate` is set

## Reference Projects And Docs

- Mbed CE new project guide: [New Project Setup Guide](https://github.com/mbed-ce/mbed-os/wiki/New-Project-Setup-Guide)
- Mbed CE example project: [`mbed-ce-hello-world`](https://github.com/mbed-ce/mbed-ce-hello-world)
- Mbed CE custom target example: [`mbed-ce-custom-targets`](https://github.com/mbed-ce/mbed-ce-custom-targets)
- Toolchain docs: [mbed-ce.dev toolchain install](https://mbed-ce.dev/getting-started/toolchain-install/)
- Upload docs: [mbed-ce.dev upload methods](https://mbed-ce.dev/upload-methods/)

## Development

See `DEVELOPMENT.md` for contributor setup, compile steps, running the Extension Development Host, packaging, and VSIX installation.

## Current Limitations

- target lists can become very large when read from the full `mbed-os/targets/targets.json5` database
- upload-method parsing currently uses simple CMake text matching
- debug actions are not supported in the extension
- the extension currently supports only one Mbed CE project per VS Code workspace
- `CMake Tools` is not required or recommended for the Mbed CE Tools workflow. If you only want CMake highlighting, prefer a syntax-only extension such as `CMake`.


Created by MbedCE Community Contributors (Jan Kamidra with AI Codex assistance).












