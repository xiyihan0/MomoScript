import type { TypstProjectUpdate } from "../../vscode/src/tinymistClient";

export interface LanguageProjectionToken {
  entryUri: string;
  session: string;
  sourceVersion: number;
  revision: number;
}

export interface LanguageProjectionAdvance {
  token: LanguageProjectionToken;
  advanced: boolean;
}
export interface PreviewHostTimestamp {
  unixMillis: number;
  localOffsetMinutes: number;
}

export class RevisionPinnedPreviewClock {
  readonly #timestampByToken = new WeakMap<LanguageProjectionToken, PreviewHostTimestamp>();

  timestamp(
    token: LanguageProjectionToken,
    refresh = false,
    now: () => Date = () => new Date()
  ): PreviewHostTimestamp {
    const pinned = this.#timestampByToken.get(token);
    if (pinned && !refresh) return pinned;
    const current = now();
    const timestamp = {
      unixMillis: current.getTime(),
      localOffsetMinutes: -current.getTimezoneOffset()
    };
    this.#timestampByToken.set(token, timestamp);
    return timestamp;
  }
}
export async function waitForSynchronizedLanguageProjection<T extends { sourceVersion: number }>(
  request: () => Promise<T | null>,
  minimumSourceVersion: number,
  timeoutMs = 5_000
): Promise<T | null> {
  const deadline = Date.now() + timeoutMs;
  let delayMs = 25;
  do {
    const project = await request();
    if (project && project.sourceVersion >= minimumSourceVersion) return project;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) break;
    await new Promise((resolve) => setTimeout(resolve, Math.min(delayMs, remainingMs)));
    delayMs = Math.min(delayMs * 2, 250);
  } while (Date.now() < deadline);
  return null;
}



export function advanceLanguageProjection(
  project: Pick<TypstProjectUpdate, "sourceUri" | "sourceVersion" | "entryUri" | "revision" | "full">,
  session: string,
  latestBySource: Map<string, LanguageProjectionToken>,
  retiredSessionsBySource: Map<string, Set<string>>
): LanguageProjectionAdvance | undefined {
  const latest = latestBySource.get(project.sourceUri);
  const retiredSessions = retiredSessionsBySource.get(project.sourceUri);
  if (retiredSessions?.has(session)) return undefined;
  if ((!latest || latest.session !== session) && !project.full) return undefined;
  if (latest?.session === session) {
    if (project.revision < latest.revision) return undefined;
    if (project.revision === latest.revision) {
      if (project.sourceVersion !== latest.sourceVersion) return undefined;
      return project.entryUri === latest.entryUri
        ? { token: latest, advanced: false }
        : undefined;
    }
  }
  if (latest && latest.session !== session) {
    const nextRetiredSessions = retiredSessions ?? new Set<string>();
    nextRetiredSessions.add(latest.session);
    retiredSessionsBySource.set(project.sourceUri, nextRetiredSessions);
  }
  const token = { entryUri: project.entryUri, session, sourceVersion: project.sourceVersion, revision: project.revision };
  latestBySource.set(project.sourceUri, token);
  return { token, advanced: true };
}
