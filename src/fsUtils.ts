import * as vscode from "vscode";

export async function readTextFile(uri: vscode.Uri): Promise<string> {
  const raw = await vscode.workspace.fs.readFile(uri);
  return Buffer.from(raw).toString("utf8");
}
