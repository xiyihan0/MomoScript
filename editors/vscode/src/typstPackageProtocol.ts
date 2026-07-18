import type { TypstProjectSnapshotKey } from "./runtimeIdentity";

export const TYPST_PACKAGE_REQUEST_METHOD = "mmt/typstPackageRequest.v1" as const;
export const TYPST_PACKAGE_CONTEXT_METHOD = "mmt/typstPackageContext.v1" as const;

export interface PackageSpec {
  readonly namespace: string;
  readonly name: string;
  readonly version: string;
}

export interface TypstPackageContext {
  readonly backend_generation: number;
  readonly typst_project_snapshot_key: TypstProjectSnapshotKey | string;
}

export interface TypstPackageRequestParams extends TypstPackageContext {
  readonly request_id: string;
  readonly package_spec: PackageSpec;
  readonly requested_path?: string;
}

export interface TypstPackageWireFile {
  readonly path: string;
  readonly content_base64: string;
}

export type TypstPackageResponse =
  | {
      readonly status: "Ready";
      readonly request_id: string;
      readonly package_generation: string;
      readonly files_digest: string;
      readonly files: readonly TypstPackageWireFile[];
    }
  | {
      readonly status: "Unavailable";
      readonly request_id: string;
      readonly reason: string;
      readonly retryable: boolean;
    }
  | {
      readonly status: "Cancelled";
      readonly request_id: string;
    };

const COMPONENT = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
const FULL_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?(?:\+[0-9A-Za-z]+(?:\.[0-9A-Za-z]+)*)?$/;

export function parseAuthoredPackageSpec(value: string): PackageSpec {
  const match = /^@([^/]+)\/([^:]+):(.+)$/.exec(value);
  if (!match) throw new Error(`Typst package import must be fully versioned: ${value}`);
  return checkedPackageSpec({ namespace: match[1]!, name: match[2]!, version: match[3]! });
}

export function checkedPackageSpec(value: unknown): PackageSpec {
  if (!isRecord(value)
    || typeof value.namespace !== "string"
    || typeof value.name !== "string"
    || typeof value.version !== "string") {
    throw new Error("Invalid Typst package identity");
  }
  if (!COMPONENT.test(value.namespace) || !COMPONENT.test(value.name) || !FULL_VERSION.test(value.version)) {
    throw new Error(`Invalid fully versioned Typst package identity: @${value.namespace}/${value.name}:${value.version}`);
  }
  return Object.freeze({ namespace: value.namespace, name: value.name, version: value.version });
}

export function checkedTypstPackageContext(value: unknown): TypstPackageContext {
  if (!isRecord(value)
    || !Number.isSafeInteger(value.backend_generation)
    || Number(value.backend_generation) <= 0
    || typeof value.typst_project_snapshot_key !== "string"
    || value.typst_project_snapshot_key.length === 0) {
    throw new Error("Invalid Typst package project context");
  }
  return Object.freeze({
    backend_generation: Number(value.backend_generation),
    typst_project_snapshot_key: value.typst_project_snapshot_key
  });
}

export function checkedTypstPackageRequest(value: unknown): TypstPackageRequestParams {
  const context = checkedTypstPackageContext(value);
  if (!isRecord(value) || typeof value.request_id !== "string" || value.request_id.length === 0) {
    throw new Error("Invalid Typst package request id");
  }
  if (value.requested_path !== undefined && typeof value.requested_path !== "string") {
    throw new Error("Invalid Typst requested package path");
  }
  return Object.freeze({
    request_id: value.request_id,
    ...context,
    package_spec: checkedPackageSpec(value.package_spec),
    ...(value.requested_path === undefined ? {} : { requested_path: value.requested_path })
  });
}

export function packageSpecKey(spec: PackageSpec): string {
  return `@${spec.namespace}/${spec.name}:${spec.version}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
