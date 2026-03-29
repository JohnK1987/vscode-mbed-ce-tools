import { SidebarCommand } from "./types";

export function renderActionButton(command: SidebarCommand, label: string, icon: string): string {
  return `<button class="action" data-command="${command}"><span class="button-icon"><span class="codicon ${renderButtonCodiconClass(icon)}"></span></span><span class="button-label">${escapeHtml(label)}</span></button>`;
}

export function renderIconButton(command: SidebarCommand, icon: string, ariaLabel: string, className = "icon-button"): string {
  return `<button class="${className}" data-command="${command}" aria-label="${escapeHtml(ariaLabel)}" title="${escapeHtml(ariaLabel)}"><span class="codicon ${renderButtonCodiconClass(icon)}"></span></button>`;
}

export function renderButtonCodiconClass(icon: string): string {
  switch (icon) {
    case "check":
      return "codicon-check";
    case "new":
      return "codicon-add";
    case "folder":
      return "codicon-folder-opened";
    case "configure":
    case "gear":
      return "codicon-gear";
    case "clean":
      return "codicon-trash";
    case "build":
      return "codicon-build";
    case "deploy":
      return "codicon-download";
    case "stop":
      return "codicon-debug-stop";
    case "close":
      return "codicon-close";
    default:
      return "codicon-circle-large-outline";
  }
}

export function renderSelectOptions(options: string[], selectedValue?: string): string {
  return options.map((option) => {
    const selected = option === selectedValue ? " selected" : "";
    const escaped = escapeHtml(option);
    return `<option value="${escaped}"${selected}>${escaped}</option>`;
  }).join("");
}

export function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

export function getNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let index = 0; index < 16; index += 1) {
    value += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return value;
}
