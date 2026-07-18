export interface PwaSafeRestartRuntimePort {
  quiesce(): Promise<void>;
}

export interface PwaSafeRestartDependencies {
  pauseNewWork: () => () => void;
  requireWriter(): void | Promise<void>;
  assertWorkspaceSafe(): void | Promise<void>;
  flushDurableState(): Promise<void>;
  abortAndDrainRuntimeWork(): Promise<void>;
  persistRecoveryMetadata(): Promise<void>;
  runtime: PwaSafeRestartRuntimePort;
}

export interface PwaSafeRestartReadiness {
  readonly acceptingWork: boolean;
  readonly readyForActivation: boolean;
  readonly blocker?: string;
}

export class PwaSafeRestartDeadlineExceeded extends Error {
  readonly deadlineMs: number;

  constructor(deadlineMs: number) {
    super(`Safe restart did not reach a quiescent boundary within ${deadlineMs}ms`);
    this.name = "PwaSafeRestartDeadlineExceeded";
    this.deadlineMs = deadlineMs;
  }
}

/**
 * Adapter from the PWA update owner's durable prepareForReload contract to the
 * editor runtime's single quiesce owner. It deliberately does not activate a
 * worker, reload the page, or own runtime disposal.
 */
export class PwaSafeRestartQuiesceAdapter {
  #acceptingWork = true;
  #readyForActivation = false;
  #blocker: string | undefined;
  #preparation: Promise<void> | undefined;
  readonly #dependencies: PwaSafeRestartDependencies;

  constructor(dependencies: PwaSafeRestartDependencies) {
    this.#dependencies = dependencies;
  }

  get readiness(): PwaSafeRestartReadiness {
    return {
      acceptingWork: this.#acceptingWork,
      readyForActivation: this.#readyForActivation,
      ...(this.#blocker ? { blocker: this.#blocker } : {}),
    };
  }

  prepareForReload(deadlineMs = 1_000): Promise<void> {
    if (this.#readyForActivation) return Promise.resolve();
    if (this.#preparation) return this.#preparation;
    if (!Number.isFinite(deadlineMs) || deadlineMs < 0) {
      return Promise.reject(new RangeError("Safe restart deadline must be a non-negative finite number"));
    }

    const resumeNewWork = this.#dependencies.pauseNewWork();
    this.#acceptingWork = false;
    this.#blocker = undefined;
    const preparation = this.#prepareWithDeadline(deadlineMs).then(
      () => {
        this.#readyForActivation = true;
      },
      (error: unknown) => {
        this.#acceptingWork = true;
        this.#blocker = error instanceof Error ? error.message : String(error);
        resumeNewWork();
        throw error;
      },
    ).finally(() => {
      if (this.#preparation === preparation) this.#preparation = undefined;
    });
    this.#preparation = preparation;
    return preparation;
  }

  async #prepareWithDeadline(deadlineMs: number): Promise<void> {
    let timer: number | NodeJS.Timeout | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new PwaSafeRestartDeadlineExceeded(deadlineMs)), deadlineMs);
    });
    try {
      await Promise.race([this.#prepare(), deadline]);
    } finally {
      clearTimeout(timer);
    }
  }

  async #prepare(): Promise<void> {
    await this.#dependencies.requireWriter();
    await this.#dependencies.assertWorkspaceSafe();
    await this.#dependencies.flushDurableState();
    await this.#dependencies.abortAndDrainRuntimeWork();
    await this.#dependencies.persistRecoveryMetadata();
    await this.#dependencies.runtime.quiesce();
  }
}
