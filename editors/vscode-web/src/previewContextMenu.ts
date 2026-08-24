import { getService } from "@codingame/monaco-vscode-api";
import {
  InputBox,
  MessageType,
} from "@codingame/monaco-vscode-api/vscode/vs/base/browser/ui/inputbox/inputBox";
import {
  SubmenuAction,
  toAction,
  type IAction,
} from "@codingame/monaco-vscode-api/vscode/vs/base/common/actions";
import {
  DisposableStore,
  toDisposable,
} from "@codingame/monaco-vscode-api/vscode/vs/base/common/lifecycle";
import {
  IContextMenuService,
  IContextViewService,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/contextview/browser/contextView.service";
import { defaultInputBoxStyles } from "@codingame/monaco-vscode-api/vscode/vs/platform/theme/browser/defaultStyles";
import type {
  PreviewComposerContextMenuItem,
  PreviewComposerContextMenuPort,
  PreviewComposerContextInputPort,
  PreviewComposerContextInputSession,
  PreviewComposerContextMenuSelection,
  PreviewComposerContextMenuSession,
} from "./previewComposer.ts";
import type { PreviewContextMenuAnchor } from "./previewWebviewProtocol.ts";

export interface PreviewContextMenuWindowGeometry {
  readonly screenX: number;
  readonly screenY: number;
  readonly outerWidth: number;
  readonly outerHeight: number;
  readonly innerWidth: number;
  readonly innerHeight: number;
}

export function contextMenuAnchorInWorkbench(
  anchor: PreviewContextMenuAnchor,
  geometry: PreviewContextMenuWindowGeometry,
): { readonly x: number; readonly y: number } {
  const sideInset = Math.max(0, (geometry.outerWidth - geometry.innerWidth) / 2);
  const topInset = Math.max(sideInset, geometry.outerHeight - geometry.innerHeight - sideInset);
  return {
    x: clamp(anchor.screenX - geometry.screenX - sideInset, 0, geometry.innerWidth),
    y: clamp(anchor.screenY - geometry.screenY - topInset, 0, geometry.innerHeight),
  };
}

export async function createWorkbenchPreviewContextMenu(): Promise<PreviewComposerContextMenuPort> {
  const [contextMenuService, contextViewService] = await Promise.all([
    getService(IContextMenuService),
    getService(IContextViewService),
  ]);
  let active: PreviewComposerContextMenuSession | undefined;

  return {
    open(anchor, items) {
      active?.close();
      const { promise, resolve } = Promise.withResolvers<PreviewComposerContextMenuSelection | undefined>();
      let settled = false;
      let pendingSelection: PreviewComposerContextMenuSelection | undefined;
      let session: PreviewComposerContextMenuSession;
      const finish = (selection: PreviewComposerContextMenuSelection | undefined) => {
        if (settled) return;
        settled = true;
        if (active === session) active = undefined;
        resolve(selection);
      };
      session = {
        result: promise,
        close() {
          if (settled) return;
          if (active === session) contextViewService.hideContextView();
          finish(undefined);
        },
      };
      active = session;
      const actions = items.map((item, index) => menuAction(item, String(index), (selection) => {
        pendingSelection = selection;
      }));
      contextMenuService.showContextMenu({
        getAnchor: () => contextMenuAnchorInWorkbench(anchor, window),
        getActions: () => actions,
        getCheckedActionsRepresentation: () => "radio",
        autoSelectFirstItem: true,
        onHide: () => setTimeout(() => finish(pendingSelection), 0),
      });
      return session;
    },
  };
}

export async function createWorkbenchPreviewContextInput(): Promise<PreviewComposerContextInputPort> {
  const contextViewService = await getService(IContextViewService);
  let active: PreviewComposerContextInputSession | undefined;

  return {
    open(anchor, options) {
      active?.close();
      const { promise, resolve } = Promise.withResolvers<string | undefined>();
      let settled = false;
      let pendingValue: string | undefined;
      let contextView: { close(): void } | undefined;
      let input: InputBox | undefined;
      let session: PreviewComposerContextInputSession;
      const finish = (value: string | undefined) => {
        if (settled) return;
        settled = true;
        if (active === session) active = undefined;
        resolve(value);
      };
      session = {
        result: promise,
        close() {
          if (settled) return;
          if (active === session) contextView?.close();
          finish(undefined);
        },
      };
      active = session;
      contextView = contextViewService.showContextView({
        getAnchor: () => contextMenuAnchorInWorkbench(anchor, window),
        render(container) {
          const disposables = new DisposableStore();
          const root = document.createElement("div");
          root.className = "mmt-preview-context-input";
          const width = Math.max(160, Math.min(320, window.innerWidth - 24));
          root.style.width = `${width}px`;
          Object.assign(root.style, {
            boxSizing: "border-box",
            padding: "8px",
            border: "1px solid var(--vscode-widget-border, transparent)",
            background: "var(--vscode-editorWidget-background)",
            boxShadow: "0 2px 8px var(--vscode-widget-shadow)",
          });
          const title = document.createElement("div");
          title.className = "mmt-preview-context-input__title";
          title.textContent = options.title;
          Object.assign(title.style, {
            overflow: "hidden",
            marginBottom: "6px",
            color: "var(--vscode-foreground)",
            fontSize: "12px",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          });
          root.append(title);
          container.append(root);

          input = new InputBox(root, contextViewService, {
            placeholder: options.placeholder,
            ariaLabel: `${options.title}。按 Enter 确认，按 Escape 取消。`,
            flexibleWidth: true,
            inputBoxStyles: defaultInputBoxStyles,
          });
          input.width = width - 16;
          input.value = options.value;
          disposables.add(input);
          disposables.add(input.onDidChange((value) => {
            if (value.length > 0) input?.hideMessage();
          }));
          const onKeyDown = (event: KeyboardEvent) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.stopPropagation();
              if (!input || input.value.length === 0) {
                input?.showMessage({ content: options.requiredMessage, type: MessageType.ERROR }, true);
                return;
              }
              pendingValue = input.value;
              contextView?.close();
            } else if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              contextView?.close();
            }
          };
          input.inputElement.addEventListener("keydown", onKeyDown);
          disposables.add(toDisposable(() => input?.inputElement.removeEventListener("keydown", onKeyDown)));
          return disposables;
        },
        focus() {
          input?.focus();
          input?.select();
        },
        onHide: () => finish(pendingValue),
      });
      return session;
    },
  };
}

function menuAction(
  item: PreviewComposerContextMenuItem,
  path: string,
  select: (selection: PreviewComposerContextMenuSelection) => void,
): IAction {
  if (item.children) {
    return new SubmenuAction(
      `momoscript.previewComposer.menu.${path}`,
      item.label,
      item.children.map((child, index) => menuAction(child, `${path}.${index}`, select)),
    );
  }
  return toAction({
    id: `momoscript.previewComposer.menu.${path}`,
    label: item.label,
    checked: item.checked,
    run: () => {
      if (item.selection) select(item.selection);
    },
  });
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}
