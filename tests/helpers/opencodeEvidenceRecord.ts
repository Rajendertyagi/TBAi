/**
 * LB1/LB5 — the shape of one legacy-database evidence record.
 *
 * Plan §2.9.4 LB1 defines the identity of a recorded observation as a composite
 * key, and this module is the executable form of it: a record that cannot name
 * *which build* produced the observation, or cannot tie the observation to the
 * service image's own process, is rejected rather than read. LB5 is the same
 * rule applied to provenance: a shim run is a real observation of the shim, not
 * of the build, so it can never be presented as build evidence.
 *
 * The validator is deliberately structural. It cannot confirm that a digest is
 * true or that a trace exists; it confirms that the record carries every part
 * the plan requires, that the composite key is complete rather than keyed on
 * an executable digest alone, that the process tree actually resolves the
 * service image, and that the observation names an operation, an access, a
 * disposition and a timestamp. A record missing any part is REJECTED — never
 * PASS by default.
 */

/** Where the executable came from. `bare executable` is the plan's literal. */
export type LegacyExtractionProvenance = "package extraction" | "bare executable";

/** What produced the run. A shim is measurable but is not build evidence. */
export type LegacyRunKind = "real-build" | "shim";

/** One link of the recorded launcher → … → service-image process chain. */
export interface LegacyProcessLink {
  readonly pid: number;
  readonly parentPid: number;
  readonly imagePath: string;
  readonly imageSha256: string;
  readonly startedAt: string;
}

/** The process-level file observation (§2.9.1), tied to the service image. */
export interface LegacyFileObservation {
  readonly targetFile: string;
  readonly operation: string;
  readonly requestedAccess: string;
  readonly disposition: string;
  readonly timestamp: string;
}

/**
 * A section check. `value` is present only when `missing` is empty; the shape
 * keeps both fields on every result so the caller never relies on narrowing
 * (the tests project runs without `strictNullChecks`).
 */
interface CheckResult<T> {
  readonly value: T | null;
  readonly missing: readonly string[];
}

interface CheckedExtraction {
  readonly provenance: LegacyExtractionProvenance;
  readonly packageName: string | null;
  readonly packageSha256: string | null;
  readonly executablePath: string;
  readonly executableSha256: string;
}

/** One recorded observation for one build. */
export interface LegacyEvidenceRecord {
  readonly version: string;
  readonly kind: LegacyRunKind;
  readonly isolationRoot: string;
  readonly extraction: {
    readonly provenance: LegacyExtractionProvenance;
    /** Present for a package, absent for a bare executable. */
    readonly packageName?: string;
    readonly packageSha256?: string;
    /** Integrity value as reported by the registry, when one exists. */
    readonly packageIntegrity?: string;
    readonly executablePath: string;
    readonly executableSha256: string;
    /** Package member path, when the executable was extracted from a package. */
    readonly executableMember?: string;
  };
  readonly registration: {
    readonly path: string;
    readonly written: boolean;
  };
  /** The service-image PID, resolved through `processTree`. */
  readonly serviceImagePid: number;
  readonly processTree: readonly LegacyProcessLink[];
  readonly observation: LegacyFileObservation;
}

/** Why a record cannot be read, with the exact fields that are incomplete. */
export interface LegacyEvidenceRejection {
  readonly status: "rejected";
  readonly reason:
    | "not_an_object"
    | "shim_provenance"
    | "incomplete_identity"
    | "unlabelled_digest"
    | "process_tree_unresolved"
    | "image_digest_mismatch"
    | "incomplete_observation";
  readonly fields: readonly string[];
}

export interface LegacyEvidenceAcceptance {
  readonly status: "pass";
  /** The composite key: version + package + executable + provenance. */
  readonly key: string;
}

export type LegacyEvidenceResult = LegacyEvidenceAcceptance | LegacyEvidenceRejection;

const SHA256 = /^[0-9a-f]{64}$/;
const NON_EMPTY = /\S/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | null {
  return typeof value === "string" && NON_EMPTY.test(value) ? value : null;
}

function sha(value: unknown): string | null {
  return typeof value === "string" && SHA256.test(value) ? value : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function isoTimestamp(value: unknown): string | null {
  const candidate = text(value);
  if (candidate === null) return null;
  return Number.isNaN(Date.parse(candidate)) ? null : candidate;
}

function checkExtraction(value: unknown): CheckResult<CheckedExtraction> {
  if (!isObject(value)) return { value: null, missing: ["extraction"] };
  const missing: string[] = [];
  const provenance =
    value.provenance === "package extraction" || value.provenance === "bare executable"
      ? value.provenance
      : null;
  if (provenance === null) missing.push("extraction.provenance");
  const executablePath = text(value.executablePath);
  if (executablePath === null) missing.push("extraction.executablePath");
  const executableSha256 = sha(value.executableSha256);
  if (executableSha256 === null) missing.push("extraction.executableSha256");

  let packageName: string | null = null;
  let packageSha256: string | null = null;
  if (provenance === "package extraction") {
    packageName = text(value.packageName);
    if (packageName === null) missing.push("extraction.packageName");
    packageSha256 = sha(value.packageSha256);
    if (packageSha256 === null) missing.push("extraction.packageSha256");
    if (text(value.executableMember) === null) missing.push("extraction.executableMember");
    // Integrity is optional (a registry may not report one), but a present
    // value must not be empty — an empty one is not evidence.
    if ("packageIntegrity" in value && text(value.packageIntegrity) === null) {
      missing.push("extraction.packageIntegrity");
    }
  } else if (provenance === "bare executable") {
    // A bare executable has no package, so package fields must not be invented
    // alongside the literal provenance.
    for (const key of ["packageName", "packageSha256", "executableMember"] as const) {
      if (key in value) missing.push(`extraction.${key}`);
    }
  }

  if (missing.length > 0) return { value: null, missing };
  if (provenance === null || executablePath === null || executableSha256 === null) {
    // Unreachable: a null above is always pushed to `missing`.
    return { value: null, missing: ["extraction"] };
  }
  return {
    value: { provenance, packageName, packageSha256, executablePath, executableSha256 },
    missing: [],
  };
}

function checkProcessTree(value: unknown): CheckResult<LegacyProcessLink[]> {
  if (!Array.isArray(value) || value.length === 0) {
    return { value: null, missing: ["processTree"] };
  }
  const missing: string[] = [];
  const links: LegacyProcessLink[] = [];
  value.forEach((entry, index) => {
    if (!isObject(entry)) {
      missing.push(`processTree[${index}]`);
      return;
    }
    const pid = positiveInteger(entry.pid);
    const parentPid = positiveInteger(entry.parentPid);
    const imagePath = text(entry.imagePath);
    const imageSha256 = sha(entry.imageSha256);
    const startedAt = isoTimestamp(entry.startedAt);
    if (pid === null) missing.push(`processTree[${index}].pid`);
    if (parentPid === null) missing.push(`processTree[${index}].parentPid`);
    if (imagePath === null) missing.push(`processTree[${index}].imagePath`);
    if (imageSha256 === null) missing.push(`processTree[${index}].imageSha256`);
    if (startedAt === null) missing.push(`processTree[${index}].startedAt`);
    if (
      pid !== null &&
      parentPid !== null &&
      imagePath !== null &&
      imageSha256 !== null &&
      startedAt !== null
    ) {
      links.push({ pid, parentPid, imagePath, imageSha256, startedAt });
    }
  });
  if (missing.length > 0) return { value: null, missing };
  return { value: links, missing: [] };
}

function checkObservation(value: unknown): CheckResult<LegacyFileObservation> {
  if (!isObject(value)) return { value: null, missing: ["observation"] };
  const targetFile = text(value.targetFile);
  const operation = text(value.operation);
  const requestedAccess = text(value.requestedAccess);
  const disposition = text(value.disposition);
  const timestamp = isoTimestamp(value.timestamp);
  const missing: string[] = [];
  if (targetFile === null) missing.push("observation.targetFile");
  if (operation === null) missing.push("observation.operation");
  if (requestedAccess === null) missing.push("observation.requestedAccess");
  if (disposition === null) missing.push("observation.disposition");
  if (timestamp === null) missing.push("observation.timestamp");
  if (missing.length > 0) return { value: null, missing };
  if (
    targetFile === null ||
    operation === null ||
    requestedAccess === null ||
    disposition === null ||
    timestamp === null
  ) {
    return { value: null, missing: ["observation"] };
  }
  return {
    value: { targetFile, operation, requestedAccess, disposition, timestamp },
    missing: [],
  };
}

/** A record with a single, unlabelled digest is keyed on the wrong thing. */
function hasUnlabelledDigest(record: Record<string, unknown>): boolean {
  if ("digest" in record || "sha256" in record || "artifactDigest" in record) return true;
  return false;
}

/**
 * Resolves the recorded chain from a launcher to the service image.
 *
 * The claim LB7 makes is that the attribution PID is the process whose image
 * hashes to the executable digest, not the launcher's. A tree that does not
 * reach `serviceImagePid`, or that skips a hop, cannot support that claim.
 *
 * @returns The service link, or `null` when the tree cannot resolve it.
 */
function resolveServiceLink(
  tree: readonly LegacyProcessLink[],
  serviceImagePid: number,
): LegacyProcessLink | null {
  const byPid = new Map<number, LegacyProcessLink>();
  for (const link of tree) byPid.set(link.pid, link);
  const service = byPid.get(serviceImagePid);
  if (service === undefined) return null;
  // Walk parents while they exist in the tree; a cycle or an unresolved hop
  // makes the chain unusable.
  const seen = new Set<number>([service.pid]);
  let current = service;
  while (byPid.has(current.parentPid)) {
    const parent = byPid.get(current.parentPid);
    if (parent === undefined || seen.has(parent.pid)) return null;
    seen.add(parent.pid);
    current = parent;
  }
  return service;
}

/**
 * Validates one record against LB1 (shape and composite key) and LB5 (a shim is
 * never build evidence).
 *
 * @returns `{ status: "pass", key }` only when every required part is present
 *   and internally consistent; otherwise `{ status: "rejected", reason,
 *   fields }`, where `fields` names each incomplete path.
 */
export function validateLegacyEvidenceRecord(value: unknown): LegacyEvidenceResult {
  if (!isObject(value)) {
    return { status: "rejected", reason: "not_an_object", fields: ["<record>"] };
  }

  const version = text(value.version);
  const kind = value.kind === "real-build" || value.kind === "shim" ? value.kind : null;
  const isolationRoot = text(value.isolationRoot);
  const extraction = checkExtraction(value.extraction);
  const registration = isObject(value.registration) ? value.registration : null;
  const serviceImagePid = positiveInteger(value.serviceImagePid);
  const processTree = checkProcessTree(value.processTree);
  const observation = checkObservation(value.observation);

  const identityMissing: string[] = [];
  if (version === null) identityMissing.push("version");
  if (kind === null) identityMissing.push("kind");
  if (isolationRoot === null) identityMissing.push("isolationRoot");
  if (extraction.missing.length > 0) identityMissing.push(...extraction.missing);
  if (registration === null) {
    identityMissing.push("registration");
  } else {
    if (text(registration.path) === null) identityMissing.push("registration.path");
    if (typeof registration.written !== "boolean") identityMissing.push("registration.written");
  }
  if (serviceImagePid === null) identityMissing.push("serviceImagePid");
  if (processTree.missing.length > 0) identityMissing.push(...processTree.missing);
  if (identityMissing.length > 0) {
    return { status: "rejected", reason: "incomplete_identity", fields: identityMissing };
  }
  if (observation.missing.length > 0) {
    return { status: "rejected", reason: "incomplete_observation", fields: observation.missing };
  }
  if (
    hasUnlabelledDigest(value) ||
    (isObject(value.extraction) && hasUnlabelledDigest(value.extraction))
  ) {
    return { status: "rejected", reason: "unlabelled_digest", fields: ["digest"] };
  }
  const checkedExtraction = extraction.value;
  const checkedTree = processTree.value;
  if (
    version === null ||
    kind === null ||
    serviceImagePid === null ||
    checkedExtraction === null ||
    checkedTree === null
  ) {
    // Unreachable: each of these is in `identityMissing` and returned above.
    return { status: "rejected", reason: "incomplete_identity", fields: ["<record>"] };
  }

  const service = resolveServiceLink(checkedTree, serviceImagePid);
  if (service === null) {
    return { status: "rejected", reason: "process_tree_unresolved", fields: ["processTree"] };
  }
  if (
    service.imagePath !== checkedExtraction.executablePath ||
    service.imageSha256 !== checkedExtraction.executableSha256
  ) {
    return {
      status: "rejected",
      reason: "image_digest_mismatch",
      fields: ["processTree.service"],
    };
  }

  if (kind === "shim") {
    // LB5: a shim run is a measurement of the shim. It is rejected as build
    // evidence, never quietly accepted as a B5 result.
    return { status: "rejected", reason: "shim_provenance", fields: ["kind"] };
  }

  const { provenance, packageName, packageSha256, executablePath, executableSha256 } =
    checkedExtraction;
  const key =
    provenance === "bare executable"
      ? [version, "bare executable", executablePath, executableSha256].join(" | ")
      : [version, packageName, packageSha256, executablePath, executableSha256].join(" | ");
  return { status: "pass", key };
}
