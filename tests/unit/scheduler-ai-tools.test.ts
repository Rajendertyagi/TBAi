/**
 * Single `scheduler` AI tool (services/scheduler/schedulerTools.ts `runScheduler`).
 *
 * Exercises every `action` (create / list / get / update / delete / run_now)
 * through the one consolidated dispatcher. It reuses the SAME schedulerStore +
 * scheduler coordinator as the REST API, so these tests also guard against the
 * two entry points drifting. Schema-level validation (strict read variants,
 * conditional schedule rules) is checked via `schedulerSchema`. Real LLM
 * execution is avoided — run_now is only exercised on the missing-job branch.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { db } from "../../src/db";
import { registry } from "../../src/config/providers";
import { schedulerStore } from "../../src/services/scheduler/schedulerStore";
import { clearAllTimers } from "../../src/services/scheduler/scheduler";
import { runScheduler } from "../../src/services/scheduler/schedulerTools";
import { schedulerSchema } from "../../src/lib/validation";
import { getWorkspaceDir } from "../../src/services/tools";

const PROVIDER_ID = "p1";
const MODEL_ID = "m1";

function seedProvider() {
  db.run(
    `INSERT OR REPLACE INTO provider_configs
       (id, name, type, encrypted_api_key, credential_version, endpoint, model, is_active, created_at, updated_at)
     VALUES (?, ?, 'ollama', NULL, NULL, NULL, ?, 1, ?, ?)`,
    [PROVIDER_ID, "test-ollama", MODEL_ID, Date.now(), Date.now()],
  );
  void registry.loadFromDb(db);
}

function baseCreateArgs(overrides: Record<string, unknown> = {}) {
  return {
    action: "create" as const,
    name: "ai job",
    scheduleType: "once" as const,
    execAt: Date.now() + 3600_000,
    timezone: "UTC",
    providerId: PROVIDER_ID,
    modelId: MODEL_ID,
    workspacePath: getWorkspaceDir(),
    prompt: "do the thing",
    ...overrides,
  };
}

describe("scheduler AI tool (consolidated)", () => {
  beforeEach(() => {
    for (const job of schedulerStore.list()) schedulerStore.remove(job.id);
    seedProvider();
  });
  afterEach(() => {
    for (const job of schedulerStore.list()) schedulerStore.remove(job.id);
    clearAllTimers();
  });

  describe("schema validation", () => {
    it("parses a valid create action", () => {
      const res = schedulerSchema.safeParse(baseCreateArgs());
      expect(res.success).toBe(true);
    });

    it("rejects a cron create without cronExpression (superRefine)", () => {
      const res = schedulerSchema.safeParse(
        baseCreateArgs({ scheduleType: "cron", cronExpression: null }),
      );
      expect(res.success).toBe(false);
    });

    it("rejects list with stray write fields (strict)", () => {
      const res = schedulerSchema.safeParse({ action: "list", name: "x" });
      expect(res.success).toBe(false);
    });

    it("parses a create without providerId/modelId (chat injects them)", () => {
      const { providerId: _p, modelId: _m, ...rest } = baseCreateArgs();
      const res = schedulerSchema.safeParse(rest);
      expect(res.success).toBe(true);
    });

    it("rejects get without jobId (required)", () => {
      const res = schedulerSchema.safeParse({ action: "get" });
      expect(res.success).toBe(false);
    });
  });

  describe("runScheduler actions", () => {
    it("create returns ok + job summary and persists it", async () => {
      const res = await runScheduler(baseCreateArgs());
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.action).toBe("create");
      expect(res.job?.id).toBeTruthy();
      expect(res.job?.name).toBe("ai job");
      expect(res.id).toBe(res.job?.id);
      expect(schedulerStore.get(res.job!.id)).not.toBeNull();
    });

    it("create validates the provider exists", async () => {
      const res = await runScheduler(
        baseCreateArgs({ providerId: "ghost" }),
      );
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toMatch(/does not exist/i);
    });

    it("create without IDs fails with a clear required-message (chat fills them)", async () => {
      const { providerId: _p, modelId: _m, ...rest } = baseCreateArgs();
      const res = await runScheduler(rest as never);
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toMatch(/providerId and modelId are required/i);
    });

    it("list returns all jobs", async () => {
      await runScheduler(baseCreateArgs({ name: "a" }));
      await runScheduler(baseCreateArgs({ name: "b" }));
      const res = await runScheduler({ action: "list" });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.jobs?.length).toBe(2);
      expect(res.jobs?.map((j) => j.name).sort()).toEqual(["a", "b"]);
    });

    it("list filters by status", async () => {
      const created = await runScheduler(baseCreateArgs({ name: "active" }));
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const paused = await runScheduler({
        action: "update",
        jobId: created.job!.id,
        status: "paused",
      });
      expect(paused.ok).toBe(true);
      const activeOnly = await runScheduler({ action: "list", status: "active" });
      expect(activeOnly.ok).toBe(true);
      if (!activeOnly.ok) return;
      expect(activeOnly.jobs?.length).toBe(0);
      const pausedOnly = await runScheduler({ action: "list", status: "paused" });
      expect(pausedOnly.ok).toBe(true);
      if (!pausedOnly.ok) return;
      expect(pausedOnly.jobs?.length).toBe(1);
    });

    it("get returns full detail including the prompt", async () => {
      const created = await runScheduler(baseCreateArgs());
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const res = await runScheduler({ action: "get", jobId: created.job!.id });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.job?.prompt).toBe("do the thing");
    });

    it("get on a missing job reports failure", async () => {
      const res = await runScheduler({ action: "get", jobId: "nope" });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toMatch(/not found/i);
    });

    it("update changes fields and reschedules", async () => {
      const created = await runScheduler(baseCreateArgs());
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const res = await runScheduler({
        action: "update",
        jobId: created.job!.id,
        name: "renamed",
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.job?.name).toBe("renamed");
      expect(schedulerStore.get(created.job!.id)?.name).toBe("renamed");
    });

    it("delete soft-deletes (hidden, history retained)", async () => {
      const created = await runScheduler(baseCreateArgs());
      expect(created.ok).toBe(true);
      if (!created.ok) return;
      const res = await runScheduler({
        action: "delete",
        jobId: created.job!.id,
      });
      expect(res.ok).toBe(true);
      if (!res.ok) return;
      expect(res.id).toBe(created.job!.id);
      // Soft-deleted: not in the active list, but run history remains queryable.
      expect(
        schedulerStore.list().some((j) => j.id === created.job!.id),
      ).toBe(false);
      expect(schedulerStore.get(created.job!.id)?.status).toBe("deleted");
    });

    it("run_now on a missing job reports failure", async () => {
      const res = await runScheduler({ action: "run_now", jobId: "nope" });
      expect(res.ok).toBe(false);
      if (res.ok) return;
      expect(res.error).toMatch(/not found/i);
    });
  });
});
