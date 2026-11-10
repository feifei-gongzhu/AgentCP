/**
 * 工具产物批量持久化路由（阶段 3；01 号基线 §八）。
 */
import { apiError } from "../errors.mjs";
import { sessionFromRequest } from "../store/sessions.mjs";
import { saveBatch, getBatch, listItemsByCategory, markBatchPartial } from "../store/extraction.mjs";

function readPlane(req, query) {
  const session = sessionFromRequest(req);
  const projectId =
    (typeof query.project_id === "string" && query.project_id) ||
    (session && typeof session.project_id === "string" && session.project_id) ||
    null;
  if (!projectId) throw apiError("BAD_REQUEST", "缺少 project_id");
  if (session && session.project_id && session.project_id !== projectId) {
    throw apiError("TRUST_DENIED", `会话项目不一致`);
  }
  return { session, projectId, actor: session ? session.actor : "user", role: session ? session.role : "user" };
}

export const routes = [
  {
    method: "POST",
    path: "/sorne/extraction/batches",
    async handler(pctx, req, res, { body, query }) {
      const { projectId, actor } = readPlane(req, query);
      return saveBatch(pctx, {
        projectId,
        idempotencyKey: body.idempotency_key,
        captureId: body.capture_id,
        blobId: body.blob_id,
        inputSha256: body.input_sha256,
        extractorName: body.extractor_name,
        extractorVersion: body.extractor_version,
        intentId: body.intent_id,
        attemptId: body.attempt_id,
        runId: body.run_id,
        actor,
        items: body.items,
      });
    },
  },
  {
    method: "GET",
    path: "/sorne/extraction/batches/:batchId",
    async handler(pctx, req, res, { params, query }) {
      const { projectId } = readPlane(req, query);
      return getBatch(pctx, {
        projectId,
        batchId: params.batchId,
        offset: query.offset ? Number(query.offset) : 0,
        limit: query.limit ? Number(query.limit) : 20,
      });
    },
  },
  {
    method: "POST",
    path: "/sorne/extraction/batches/:batchId/partial",
    async handler(pctx, req, res, { params, body, query }) {
      const { projectId } = readPlane(req, query);
      return markBatchPartial(pctx, {
        projectId,
        batchId: params.batchId,
        errorNote: body.error_note,
      });
    },
  },
  {
    method: "GET",
    path: "/sorne/extraction/items",
    async handler(pctx, req, res, { query }) {
      const { projectId } = readPlane(req, query);
      return listItemsByCategory(pctx, {
        projectId,
        category: query.category,
        cursor: query.cursor,
        limit: query.limit ? Number(query.limit) : 20,
      });
    },
  },
];
