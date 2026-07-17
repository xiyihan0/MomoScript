import type {
  LogicalSourceId,
  ProjectionKey,
  SourceContentKey,
  SourceStaleToken,
  TypstProjectSnapshotKey
} from "./runtimeIdentity";

export interface TinymistRequestIdentity {
  readonly backendGeneration: number;
  readonly logicalSource: LogicalSourceId;
  readonly sourceContent: SourceContentKey;
  readonly sourceStaleToken: SourceStaleToken;
  readonly projectSnapshot: TypstProjectSnapshotKey;
  readonly projectionKey?: ProjectionKey;
}

export interface TinymistRequestMetadata extends TinymistRequestIdentity {
  readonly requestSequence: number;
}

export interface TinymistRequestEnvelope<Method extends string, Params> {
  readonly method: Method;
  readonly params: Params;
  readonly metadata: TinymistRequestMetadata;
}

export interface TinymistRequestDefinition<Params, Result> {
  readonly params: Params;
  readonly result: Result;
}

export type TinymistRequestParameters<Definition> =
  Definition extends TinymistRequestDefinition<infer Params, unknown> ? Params : never;

export type TinymistRequestResult<Definition> =
  Definition extends TinymistRequestDefinition<unknown, infer Result> ? Result : never;

export type TinymistRequestEnvelopeFor<Requests> = {
  [Method in keyof Requests & string]: TinymistRequestEnvelope<
    Method,
    TinymistRequestParameters<Requests[Method]>
  >;
}[keyof Requests & string];

export type TinymistRequestSender<Requests> = (
  envelope: TinymistRequestEnvelopeFor<Requests>,
  signal?: AbortSignal
) => Promise<TinymistRequestResult<Requests[keyof Requests & string]>>;

export type TinymistDispatchErrorCode =
  | "Cancelled"
  | "NoCurrentIdentity"
  | "StaleBackendGeneration"
  | "StaleLogicalSource"
  | "StaleSourceContent"
  | "StaleDocument"
  | "StaleProjectSnapshot"
  | "StaleProjection"
  | "SupersededSequence";

export class TinymistDispatchError extends Error {
  constructor(readonly code: TinymistDispatchErrorCode, message: string) {
    super(message);
    this.name = "TinymistDispatchError";
  }
}


type CurrentIdentity = (
  captured: TinymistRequestMetadata
) => TinymistRequestIdentity | undefined;

/**
 * Assigns request sequence numbers and guards publication. It owns no backend
 * lifecycle or project state: callers provide one immutable captured identity
 * and a synchronous lookup of the currently accepted identity.
 */
export class TinymistRequestDispatcher<Requests> {
  private nextRequestSequence = 1;
  private readonly latestSequenceByScope = new Map<
    string,
    { readonly sequence: number; readonly hostUri: string; readonly backendGeneration: number }
  >();

  constructor(
    private readonly send: TinymistRequestSender<Requests>,
    private readonly currentIdentity: CurrentIdentity
  ) {}

  activeRequestScopeCount(): number {
    return this.latestSequenceByScope.size;
  }

  retireHost(hostUri: string): void {
    for (const [scope, active] of this.latestSequenceByScope) {
      if (active.hostUri === hostUri) this.latestSequenceByScope.delete(scope);
    }
  }

  retireGenerationsExcept(backendGeneration: number): void {
    for (const [scope, active] of this.latestSequenceByScope) {
      if (active.backendGeneration !== backendGeneration) this.latestSequenceByScope.delete(scope);
    }
  }

  retireAll(): void {
    this.latestSequenceByScope.clear();
  }

  async request<Method extends keyof Requests & string>(
    method: Method,
    params: TinymistRequestParameters<Requests[Method]>,
    identity: TinymistRequestIdentity,
    signal?: AbortSignal
  ): Promise<TinymistRequestResult<Requests[Method]>> {
    const metadata = this.capture(identity);
    const envelope: TinymistRequestEnvelope<Method, TinymistRequestParameters<Requests[Method]>> = Object.freeze({
      method,
      params,
      metadata
    });
    const scope = `${method}\u0000${metadata.sourceStaleToken.hostUri}`;

    this.assertNotCancelled(signal);
    this.assertCurrent(metadata);
    this.latestSequenceByScope.set(scope, {
      sequence: metadata.requestSequence,
      hostUri: metadata.sourceStaleToken.hostUri,
      backendGeneration: metadata.backendGeneration
    });

    try {
      let response: unknown;
      try {
        response = await this.send(envelope as TinymistRequestEnvelopeFor<Requests>, signal);
      } catch (error) {
        if (signal?.aborted) throw cancelledError(signal);
        throw error;
      }

      this.assertNotCancelled(signal);
      this.assertCurrent(metadata);
      if (this.latestSequenceByScope.get(scope)?.sequence !== metadata.requestSequence) {
        throw new TinymistDispatchError(
          "SupersededSequence",
          `Tinymist ${method} response sequence ${metadata.requestSequence} was superseded`
        );
      }
      return response as TinymistRequestResult<Requests[Method]>;
    } finally {
      if (this.latestSequenceByScope.get(scope)?.sequence === metadata.requestSequence) {
        this.latestSequenceByScope.delete(scope);
      }
    }
  }

  private capture(identity: TinymistRequestIdentity): TinymistRequestMetadata {
    validateIdentity(identity);
    if (!Number.isSafeInteger(this.nextRequestSequence)) {
      throw new Error("Tinymist request sequence exhausted");
    }
    return Object.freeze({
      ...identity,
      requestSequence: this.nextRequestSequence++
    });
  }

  private assertNotCancelled(signal: AbortSignal | undefined): void {
    if (signal?.aborted) throw cancelledError(signal);
  }

  private assertCurrent(expected: TinymistRequestMetadata): void {
    const current = this.currentIdentity(expected);
    if (!current) {
      throw new TinymistDispatchError("NoCurrentIdentity", "Tinymist request no longer has a current project identity");
    }
    if (current.backendGeneration !== expected.backendGeneration) {
      throw new TinymistDispatchError("StaleBackendGeneration", "Tinymist backend generation changed");
    }
    if (current.logicalSource !== expected.logicalSource) {
      throw new TinymistDispatchError("StaleLogicalSource", "Tinymist logical source changed");
    }
    if (current.sourceContent !== expected.sourceContent) {
      throw new TinymistDispatchError("StaleSourceContent", "Tinymist source content changed");
    }
    if (!sourceStaleTokensEqual(current.sourceStaleToken, expected.sourceStaleToken)) {
      throw new TinymistDispatchError("StaleDocument", "Tinymist document incarnation or version changed");
    }
    if (current.projectSnapshot !== expected.projectSnapshot) {
      throw new TinymistDispatchError("StaleProjectSnapshot", "Tinymist complete project snapshot changed");
    }
    if (current.projectionKey !== expected.projectionKey) {
      throw new TinymistDispatchError("StaleProjection", "Tinymist projection changed");
    }
  }
}

function validateIdentity(identity: TinymistRequestIdentity): void {
  if (!Number.isSafeInteger(identity.backendGeneration) || identity.backendGeneration <= 0) {
    throw new Error(`Invalid Tinymist backend generation: ${identity.backendGeneration}`);
  }
  if (!Number.isInteger(identity.sourceStaleToken.documentVersion)) {
    throw new Error(`Invalid document version: ${identity.sourceStaleToken.documentVersion}`);
  }
}

function sourceStaleTokensEqual(left: SourceStaleToken, right: SourceStaleToken): boolean {
  return left.hostUri === right.hostUri
    && left.documentIncarnation === right.documentIncarnation
    && left.documentVersion === right.documentVersion;
}


function cancelledError(signal: AbortSignal): TinymistDispatchError {
  const suffix = signal.reason instanceof Error ? `: ${signal.reason.message}` : "";
  return new TinymistDispatchError("Cancelled", `Tinymist request cancelled${suffix}`);
}
