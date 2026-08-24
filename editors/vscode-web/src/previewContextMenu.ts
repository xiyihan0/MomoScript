import { getService } from "@codingame/monaco-vscode-api";
import {
  SubmenuAction,
  toAction,
  type IAction,
} from "@codingame/monaco-vscode-api/vscode/vs/base/common/actions";
import {
  IContextMenuService,
  IContextViewService,
} from "@codingame/monaco-vscode-api/vscode/vs/platform/contextview/browser/contextView.service";
import type {
  PreviewComposerContextMenuItem,
  PreviewComposerContextMenuPort,
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
