import { randomUUID } from "node:crypto";

export type TrajectoryStage = "TURN_STARTED" | "RECALL_COMPLETED" | "ACTION_OBSERVED" | "TURN_FINALIZED";
export interface TrajectoryEvent {
  eventId: string;
  stage: TrajectoryStage;
  timestamp: string;
  success?: boolean;
  data: Record<string, unknown>;
}

export class EvaluationTrajectory {
  readonly events: TrajectoryEvent[] = [];
  private finalized = false;

  append(stage: Exclude<TrajectoryStage, "TURN_FINALIZED">, data: Record<string, unknown> = {}): TrajectoryEvent {
    if (this.finalized) throw new Error("Cannot append to a finalized evaluation trajectory");
    const event = { eventId: randomUUID(), stage, timestamp: new Date().toISOString(), data };
    this.events.push(event);
    return event;
  }

  finalize(success: boolean, data: Record<string, unknown> = {}): TrajectoryEvent {
    if (this.finalized) throw new Error("Evaluation trajectory already finalized");
    this.finalized = true;
    const event = { eventId: randomUUID(), stage: "TURN_FINALIZED" as const, timestamp: new Date().toISOString(), success, data };
    this.events.push(event);
    return event;
  }

  assertFinalized(): void {
    if (!this.finalized) throw new Error("Evaluation trajectory must be finalized on success and failure turns");
  }
}

