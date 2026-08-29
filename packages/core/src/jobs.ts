import { randomUUID } from "node:crypto";

import { VscxError } from "./errors.js";
import type { JsonValue } from "./protocol.js";
import { serializeValue } from "./serialization.js";

export interface BridgeJobOptions {
  id?: string;
  label?: string;
  metadata?: unknown;
}

export interface BridgeJobDescription {
  createdAt: string;
  id: string;
  label?: string;
  metadata: JsonValue;
  resourceCount: number;
  state: "active" | "cancelled" | "disposed";
}

export interface BridgeJobHandle {
  readonly id: string;
  readonly signal: AbortSignal;
  add(resource: BridgeJobResource): void;
  cancel(): Promise<void>;
  dispose(): Promise<void>;
  describe(): BridgeJobDescription;
}

export type BridgeJobResource =
  | (() => unknown | Promise<unknown>)
  | { dispose(): unknown | Promise<unknown> };

interface ManagedBridgeJob {
  controller: AbortController;
  createdAt: string;
  id: string;
  label?: string;
  metadata: unknown;
  resources: BridgeJobResource[];
  state: BridgeJobDescription["state"];
}

export class BridgeJobManager {
  readonly #jobsById = new Map<string, ManagedBridgeJob>();

  create(options: BridgeJobOptions = {}): BridgeJobHandle {
    const jobId = options.id ?? randomUUID();

    if (this.#jobsById.has(jobId)) {
      throw new VscxError("job-already-exists", `A job named ${jobId} already exists.`);
    }

    const bridgeJob: ManagedBridgeJob = {
      controller: new AbortController(),
      createdAt: new Date().toISOString(),
      id: jobId,
      label: options.label,
      metadata: options.metadata,
      resources: [],
      state: "active",
    };

    this.#jobsById.set(jobId, bridgeJob);

    return this.#buildHandle(bridgeJob);
  }

  list(): BridgeJobDescription[] {
    return [...this.#jobsById.values()].map((bridgeJob) =>
      this.#describeJob(bridgeJob),
    );
  }

  get(jobId: string): BridgeJobDescription {
    return this.#describeJob(this.#getJob(jobId));
  }

  async cancel(jobId: string): Promise<BridgeJobDescription> {
    const bridgeJob = this.#getJob(jobId);

    if (bridgeJob.state === "active") {
      bridgeJob.controller.abort();
      bridgeJob.state = "cancelled";
    }

    return this.#describeJob(bridgeJob);
  }

  async dispose(jobId: string): Promise<BridgeJobDescription> {
    const bridgeJob = this.#getJob(jobId);

    await this.#disposeJob(bridgeJob);

    this.#jobsById.delete(jobId);

    return this.#describeJob(bridgeJob);
  }

  async disposeAll(): Promise<void> {
    await Promise.allSettled(
      [...this.#jobsById.values()].map((bridgeJob) => this.#disposeJob(bridgeJob)),
    );

    this.#jobsById.clear();
  }

  #buildHandle(bridgeJob: ManagedBridgeJob): BridgeJobHandle {
    return {
      id: bridgeJob.id,
      signal: bridgeJob.controller.signal,
      add: (resource) => {
        if (bridgeJob.state !== "active") {
          throw new VscxError(
            "job-not-active",
            `Job ${bridgeJob.id} is ${bridgeJob.state}.`,
          );
        }

        bridgeJob.resources.push(resource);
      },
      cancel: async () => {
        await this.cancel(bridgeJob.id);
      },
      dispose: async () => {
        await this.dispose(bridgeJob.id);
      },
      describe: () => this.#describeJob(bridgeJob),
    };
  }

  #getJob(jobId: string): ManagedBridgeJob {
    const bridgeJob = this.#jobsById.get(jobId);

    if (bridgeJob) return bridgeJob;

    throw new VscxError("job-not-found", `No bridge job named ${jobId} exists.`);
  }

  #describeJob(bridgeJob: ManagedBridgeJob): BridgeJobDescription {
    return {
      createdAt: bridgeJob.createdAt,
      id: bridgeJob.id,
      ...(bridgeJob.label ? { label: bridgeJob.label } : {}),
      metadata: serializeValue(bridgeJob.metadata),
      resourceCount: bridgeJob.resources.length,
      state: bridgeJob.state,
    };
  }

  async #disposeJob(bridgeJob: ManagedBridgeJob): Promise<void> {
    if (bridgeJob.state === "disposed") return;

    bridgeJob.controller.abort();

    const resources = bridgeJob.resources.splice(0).reverse();

    await Promise.allSettled(
      resources.map(async (resource) => {
        if (typeof resource === "function") {
          await resource();

          return;
        }

        await resource.dispose();
      }),
    );

    bridgeJob.state = "disposed";
  }
}
