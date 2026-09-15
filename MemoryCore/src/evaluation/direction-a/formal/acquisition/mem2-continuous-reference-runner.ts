import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AppendOnlyAttemptJournal } from "./journal.js";
import { reconstructResumeState } from "./resume.js";
import { assertPairSchedule, type PairSchedule } from "./integrity.js";
import { hashCanonical } from "../core/canonical.js";
import {
  assertMem2ContinuousReferenceArtifact,
  buildMem2ContinuousReferenceArtifact,
  nextMem2ReferenceAction,
  type Mem2ContinuousReferenceArtifact,
  type Mem2ReferencePairSlot,
} from "../teacher/mem2-continuous-reference.js";

interface SlotEnvelopeBody {
  schemaVersion: "direction-a.mem2-continuous-reference-slot.v1";
  causalGroupId: string;
  statisticalClusterId: string;
  authorityBindingHash: string;
  protocolHash: string;
  profileHash: string;
  snapshotHash: string;
  pairScheduleHash: string;
  slot: Mem2ReferencePairSlot;
}

interface SlotEnvelope extends SlotEnvelopeBody { contentHash: string }

export interface Mem2ContinuousReferenceRunnerConfig {
  journal: AppendOnlyAttemptJournal;
  artifactRoot: string;
  authorityBindingHash: string;
  protocolHash: string;
  profileHash: string;
  snapshotHash: string;
  verifierHash: string;
  pairSchedule: PairSchedule;
}

export interface Mem2ContinuousReferenceRunInput {
  causalGroupId: string;
  statisticalClusterId: string;
  acquireSlot(pairIndex: 1 | 2 | 3 | 4 | 5): Promise<Mem2ReferencePairSlot>;
  recoverStartedSlot?(pairIndex: 1 | 2 | 3 | 4 | 5): Promise<Mem2ReferencePairSlot | undefined>;
}

async function writeImmutableJson(path: string, value: unknown): Promise<void> {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(path, bytes, { encoding: "utf8", flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    const existing = JSON.parse(await readFile(path, "utf8")) as { contentHash?: string };
    if (!existing.contentHash || existing.contentHash !== (value as { contentHash?: string }).contentHash
      || hashCanonical(Object.fromEntries(Object.entries(existing).filter(([key]) => key !== "contentHash"))) !== existing.contentHash) {
      throw new Error(`MEM_CONTINUOUS_REFERENCE_IMMUTABLE_ARTIFACT_TAMPER:${path}`);
    }
  }
}

function verifySlotEnvelope(value: SlotEnvelope, config: Mem2ContinuousReferenceRunnerConfig, input: Mem2ContinuousReferenceRunInput): void {
  const { contentHash, ...body } = value;
  if (hashCanonical(body) !== contentHash) throw new Error("MEM_CONTINUOUS_REFERENCE_SLOT_HASH_MISMATCH");
  if (value.authorityBindingHash !== config.authorityBindingHash || value.protocolHash !== config.protocolHash || value.profileHash !== config.profileHash || value.snapshotHash !== config.snapshotHash
    || value.pairScheduleHash !== config.pairSchedule.scheduleHash || value.causalGroupId !== input.causalGroupId
    || value.statisticalClusterId !== input.statisticalClusterId) throw new Error("MEM2_CONTINUOUS_REFERENCE_SLOT_BINDING_DRIFT");
}

export class Mem2ContinuousReferenceRunner {
  constructor(private readonly config: Mem2ContinuousReferenceRunnerConfig) {
    assertPairSchedule(config.pairSchedule);
    if (config.pairSchedule.rows.length !== 5 || config.pairSchedule.rows.some((row, index) => row.pairIndex !== index + 1)) {
      throw new Error("MEM2_CONTINUOUS_REFERENCE_RUNNER_REQUIRES_PREDECLARED_SLOTS_1_TO_5");
    }
    for (const [key, value] of Object.entries(config).filter(([key]) => !["journal", "pairSchedule", "artifactRoot"].includes(key))) {
      if (typeof value !== "string" || !value) throw new Error(`MEM2_CONTINUOUS_REFERENCE_RUNNER_EMPTY_${key}`);
    }
  }

  private async loadBoundSlots(input: Mem2ContinuousReferenceRunInput): Promise<Mem2ReferencePairSlot[]> {
    const events = await this.config.journal.read();
    reconstructResumeState(events, this.config.protocolHash);
    const slots: Mem2ReferencePairSlot[] = [];
    for (const event of events.filter((row) => row.eventType === "REFERENCE_SLOT_BOUND")) {
      if (event.payload.causalGroupId !== input.causalGroupId) continue;
      const relativePath = String(event.payload.relativePath);
      if (!/^slots\/[a-f0-9]{64}\.json$/.test(relativePath.replace(/\\/g, "/"))) throw new Error("MEM2_CONTINUOUS_REFERENCE_SLOT_PATH_INVALID");
      const envelope = JSON.parse(await readFile(join(this.config.artifactRoot, relativePath), "utf8")) as SlotEnvelope;
      verifySlotEnvelope(envelope, this.config, input);
      if (event.payload.slotContentHash !== envelope.contentHash) throw new Error("MEM2_CONTINUOUS_REFERENCE_JOURNAL_SLOT_HASH_DRIFT");
      slots.push(envelope.slot);
    }
    if (new Set(slots.map((slot) => slot.pairIndex)).size !== slots.length) throw new Error("MEM2_CONTINUOUS_REFERENCE_DUPLICATE_BOUND_SLOT");
    return slots.sort((a, b) => a.pairIndex - b.pairIndex);
  }

  private async bindSlot(input: Mem2ContinuousReferenceRunInput, slot: Mem2ReferencePairSlot): Promise<void> {
    const body: SlotEnvelopeBody = {
      schemaVersion: "direction-a.mem2-continuous-reference-slot.v1",
      causalGroupId: input.causalGroupId,
      statisticalClusterId: input.statisticalClusterId,
      authorityBindingHash: this.config.authorityBindingHash,
      protocolHash: this.config.protocolHash,
      profileHash: this.config.profileHash,
      snapshotHash: this.config.snapshotHash,
      pairScheduleHash: this.config.pairSchedule.scheduleHash,
      slot,
    };
    const envelope: SlotEnvelope = { ...body, contentHash: hashCanonical(body) };
    const relativePath = `slots/${envelope.contentHash}.json`;
    await writeImmutableJson(join(this.config.artifactRoot, relativePath), envelope);
    await this.config.journal.append({ eventType: "REFERENCE_SLOT_BOUND", pairId: slot.pairId,
      protocolHash: this.config.protocolHash, payload: { causalGroupId: input.causalGroupId, pairIndex: slot.pairIndex,
        slotContentHash: envelope.contentHash, relativePath } });
  }

  async run(input: Mem2ContinuousReferenceRunInput): Promise<Mem2ContinuousReferenceArtifact> {
    if (!input.causalGroupId || !input.statisticalClusterId) throw new Error("MEM2_CONTINUOUS_REFERENCE_RUNNER_GROUP_IDENTITY_REQUIRED");
    let events = await this.config.journal.read();
    reconstructResumeState(events, this.config.protocolHash);
    const finalEvent = [...events].reverse().find((event) => event.eventType === "REFERENCE_FROZEN"
      && event.payload.causalGroupId === input.causalGroupId);
    if (finalEvent) {
      const relativePath = String(finalEvent.payload.relativePath);
      if (!/^references\/[a-f0-9]{64}\.json$/.test(relativePath.replace(/\\/g, "/"))) throw new Error("MEM2_CONTINUOUS_REFERENCE_FINAL_PATH_INVALID");
      const artifact = JSON.parse(await readFile(join(this.config.artifactRoot, relativePath), "utf8")) as Mem2ContinuousReferenceArtifact;
      assertMem2ContinuousReferenceArtifact(artifact);
      if (artifact.contentHash !== finalEvent.payload.referenceContentHash) throw new Error("MEM2_CONTINUOUS_REFERENCE_FINAL_JOURNAL_HASH_DRIFT");
      if (artifact.bindings.authorityBindingHash !== this.config.authorityBindingHash || artifact.bindings.protocolHash !== this.config.protocolHash
        || artifact.bindings.profileHash !== this.config.profileHash || artifact.bindings.snapshotHash !== this.config.snapshotHash
        || artifact.bindings.verifierHash !== this.config.verifierHash) throw new Error("MEM2_CONTINUOUS_REFERENCE_FINAL_BINDING_DRIFT");
      return artifact;
    }

    let slots = await this.loadBoundSlots(input);
    while (true) {
      const next = nextMem2ReferenceAction(slots);
      if (next.action !== "ACQUIRE_PAIR_SLOT") break;
      const started = events.find((event) => event.eventType === "REFERENCE_SLOT_STARTED"
        && event.payload.causalGroupId === input.causalGroupId && event.payload.pairIndex === next.pairIndex);
      let slot: Mem2ReferencePairSlot | undefined;
      if (started) {
        slot = await input.recoverStartedSlot?.(next.pairIndex);
        if (!slot) throw new Error(`MEM2_CONTINUOUS_REFERENCE_RESUME_REQUIRES_DURABLE_RECOVERY:${next.pairIndex}`);
      } else {
        await this.config.journal.append({ eventType: "REFERENCE_SLOT_STARTED", protocolHash: this.config.protocolHash,
          payload: { causalGroupId: input.causalGroupId, statisticalClusterId: input.statisticalClusterId,
            pairIndex: next.pairIndex, reason: next.reason, technicalRetryLimit: 0,
            profileHash: this.config.profileHash, snapshotHash: this.config.snapshotHash,
            pairScheduleHash: this.config.pairSchedule.scheduleHash } });
        slot = await input.acquireSlot(next.pairIndex);
      }
      if (slot.pairIndex !== next.pairIndex) throw new Error("MEM2_CONTINUOUS_REFERENCE_ACQUIRED_SLOT_INDEX_DRIFT");
      await this.bindSlot(input, slot);
      events = await this.config.journal.read();
      slots = await this.loadBoundSlots(input);
    }
    const artifact = buildMem2ContinuousReferenceArtifact({
      causalGroupId: input.causalGroupId,
      statisticalClusterId: input.statisticalClusterId,
      slots,
      protocolHash: this.config.protocolHash,
      authorityBindingHash: this.config.authorityBindingHash,
      profileHash: this.config.profileHash,
      snapshotHash: this.config.snapshotHash,
      verifierHash: this.config.verifierHash,
    });
    const relativePath = `references/${artifact.contentHash}.json`;
    await writeImmutableJson(join(this.config.artifactRoot, relativePath), artifact);
    await this.config.journal.append({ eventType: "REFERENCE_FROZEN", protocolHash: this.config.protocolHash,
      payload: { causalGroupId: input.causalGroupId, statisticalClusterId: input.statisticalClusterId,
        referenceContentHash: artifact.contentHash, relativePath, referenceAvailable: artifact.referenceAvailable } });
    return artifact;
  }
}
