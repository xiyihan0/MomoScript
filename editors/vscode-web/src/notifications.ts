import {
  getService,
  INotificationService,
  Severity,
} from "@codingame/monaco-vscode-api";
import { toAction } from "@codingame/monaco-vscode-api/vscode/vs/base/common/actions";

export type MomoScriptNotificationSeverity = "info" | "warning" | "error";

export interface MomoScriptNotificationOptions {
  readonly id?: string;
}

const SOURCE = Object.freeze({ id: "momoscript.web", label: "MomoScript" });

export async function showMomoScriptMessage(
  severity: MomoScriptNotificationSeverity,
  message: string,
  actions: readonly string[] = [],
  options: MomoScriptNotificationOptions = {},
): Promise<string | undefined> {
  const notificationService = await getService(INotificationService);
  return await new Promise<string | undefined>((resolve) => {
    let settled = false;
    let closeListener: { dispose(): void } | undefined;
    const finish = (result: string | undefined) => {
      if (settled) return;
      settled = true;
      closeListener?.dispose();
      resolve(result);
    };
    const handle = notificationService.notify({
      ...(options.id ? { id: `momoscript.${options.id}` } : {}),
      severity: severity === "error" ? Severity.Error : severity === "warning" ? Severity.Warning : Severity.Info,
      message,
      source: SOURCE,
      actions: actions.length === 0 ? undefined : {
        primary: actions.map((label, index) => toAction({
          id: `momoscript.notification.${options.id ?? crypto.randomUUID()}.${index}`,
          label,
          run: () => finish(label),
        })),
      },
    });
    closeListener = handle.onDidClose(() => finish(undefined));
  });
}
