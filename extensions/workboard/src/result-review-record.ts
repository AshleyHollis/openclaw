import {
  WORKBOARD_PROOF_STATUSES,
  type WorkboardResultReviewRequest,
} from "@openclaw/workboard-contract";
import { z } from "zod";

const identity = z.string().min(1);
const timestamp = z.number().finite();
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const proof = z.strictObject({
  id: identity,
  status: z.enum(WORKBOARD_PROOF_STATUSES),
  createdAt: timestamp,
  label: z.string().optional(),
  command: z.string().optional(),
  url: z.string().optional(),
  note: z.string().optional(),
});
const artifact = z.strictObject({
  id: identity,
  createdAt: timestamp,
  label: z.string().optional(),
  url: z.string().optional(),
  path: z.string().optional(),
  mimeType: z.string().optional(),
});
const request = z.strictObject({
  schemaVersion: z.literal(1),
  id: identity,
  requestRevision: digest,
  resultDigest: digest,
  completionIntent: digest,
  revision: z.number().int().positive(),
  status: z.enum(["pending", "reviewed", "withdrawn"]),
  tenant: z.string(),
  boardId: identity,
  cardId: identity,
  sessionKey: identity,
  runId: identity,
  createdAt: timestamp,
  expiresAt: z.null(),
  resolvedAt: timestamp.nullable(),
  result: z.strictObject({
    summary: z.string(),
    proof: z.array(proof),
    artifacts: z.array(artifact),
  }),
});

// Retained snapshots must be validated without normalizing or repairing their bytes.
export function readResultReviewRecord(value: unknown): WorkboardResultReviewRequest {
  return request.parse(value);
}
