# Development

This file is for repository and contributor use. It is not included in the packaged extension.

## Install Node Dependencies

```powershell
npm install
```

## Compile The Extension

```powershell
npm run compile
```

## Run In Extension Development Host

1. Open this repository in VS Code.
2. Press `F5`.
3. A new Extension Development Host window should open.

## Package The Extension

```powershell
npm run package
```

This creates a file like:

```text
vscode-mbed-ce-tools-0.0.1-beta.1.vsix
```

The package is created in the repository root.

## Install A VSIX Package

From VS Code:

1. Open the Extensions view.
2. Open the `...` menu.
3. Choose `Install from VSIX...`
4. Select the generated `.vsix` file.

From the command line:

```powershell
code --install-extension .\vscode-mbed-ce-tools-0.0.1-beta.1.vsix
```

## Notes

- The activity bar icon uses `media/mbed-ce.svg`.
- The marketplace/listing icon uses `media/mbed-ce.png`.
- Packaged content is filtered by `.vscodeignore`.

## Smoke Test

Use this before packaging or release when you want the fastest useful check.

- [x] Run `npm run compile`
- [x] Launch the extension in the VS Code Extension Development Host
- [x] Open an Mbed CE project
- [x] Confirm the workflow page shows board, profile, and upload-method selectors
- [x] Run `Configure`
- [x] Run `Build`
- [x] Run `Deploy`
- [x] Confirm deploy targets are detected only after configure from CMake File API data
- [x] Reload the VS Code window and confirm selections still restore correctly
- [ ] Build a VSIX with `npm run package`

## Full Test Checklist

Use this checklist after larger changes, before packaging, or before release.

### Basic Build Check

- [ ] Run `npm run compile`
- [ ] Confirm TypeScript compilation passes with no errors

### Extension Host Smoke Test

- [ ] Launch the extension in the VS Code Extension Development Host
- [ ] Confirm the start screen shows `Check Requirements`, `New Project`, and `Load Project`
- [ ] Open or create an Mbed CE project
- [ ] Confirm the workflow page appears with board, profile, and upload-method selectors
- [ ] Confirm the status bar shows `Configure`, `Clean`, `Build`, and `Deploy` only when appropriate

### Main Workflow

- [ ] Select board, profile, and upload method
- [ ] Run `Configure`
- [ ] Run `Build`
- [ ] Run `Deploy`
- [ ] Confirm `Stop` appears while an action is running and cancels correctly

### Target And Deploy Detection

- [ ] Confirm `.vscode/mbed-ce-targets.json5` is used when present
- [ ] Confirm the extension generates `.vscode/mbed-ce-targets.json5` when it is missing and valid target databases are available
- [ ] Confirm the helper-file creation notification appears when `.vscode/mbed-ce-targets.json5` is generated
- [ ] Confirm fallback works with `custom_targets.json5`
- [ ] Confirm fallback works with `mbed-os/targets/targets.json5`
- [ ] Confirm deploy targets come from CMake File API data only
- [ ] Confirm only deployable targets with matching `flash-*` targets are offered

### Settings And Repair Flow

- [ ] Change `mbedCe.projectRootPath` to an invalid value and confirm repair prompt behavior
- [ ] Change `mbedCe.mbedOsPath` to an invalid value and confirm repair prompt behavior
- [ ] Change `mbedCe.customTargetsPath` to an invalid value and confirm repair prompt behavior
- [ ] Change `mbedCe.buildDirectory` and confirm the sidebar state and C/C++ provider refresh correctly
- [ ] Change `mbedCe.defaultBuildType` and confirm the sidebar and build selection refresh correctly
- [ ] Change `mbedCe.configureCommand`, `mbedCe.buildCommand`, or `mbedCe.deployCommand` and confirm the next action uses the updated command template
- [ ] Confirm `mbedCe.projectTemplate` accepts both a Git repository URL and a local Git repository path

### Reconfigure Behavior

- [ ] Change board and confirm upload-method selection updates correctly
- [ ] Change profile and confirm build/deploy use the correct build directory
- [ ] Change upload method and confirm `Build` or `Deploy` reconfigures when needed
- [ ] Add or change `serialNumber` in `.vscode/mbed-ce-targets.json5` and confirm `Build` or `Deploy` reconfigures when needed
- [ ] Confirm the selected target `serialNumber` adds `-DMBED_UPLOAD_SERIAL_NUMBER:STRING=<serialNumber>` during configure

### Windows Edge Cases

- [ ] Test from a project path that contains spaces
- [ ] Test `New Project` with a valid Windows-safe folder name
- [ ] Confirm requirement checks still run through `powershell.exe`
- [ ] Confirm the default Configure command still handles `${mbedUploadSerialNumberArgument}` correctly in PowerShell

### Persistence

- [ ] Reload the VS Code window
- [ ] Confirm the selected board, profile, upload method, and deploy target restore correctly
- [ ] Confirm `Mbed CE Tools` becomes the active C/C++ provider only after `compile_commands.json` exists when `mbedCe.manageCppToolsProvider` is enabled

### Packaging Check

- [ ] Build a VSIX with `npm run package`
- [ ] Install the VSIX in a clean VS Code profile
- [ ] Repeat a short smoke test there
