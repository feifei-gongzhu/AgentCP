/**
 * A2 —— 证据存储与采集记录路由（蓝图 §5 端点 #11/#12/#43/#44）。
 *
 * 规范落点：
 *   - POST /sorne/evidence/blobs（#11，rawBody）：原始字节流式上传并固定，
 *     不受 JSON 预读 256KiB 上限约束（§11.2/§13；蓝图 §2.2 rawBody 协议）；
 *   - GET  /sorne/evidence/blobs/:sha256（#43）：验证与完整依据层按哈希读取
 *     原始证据字节（§8.3「验证可以读取原始证据」/§18.3）；
 *   - POST /sorne/captures（#12）：建立采集记录，引用已固定证据（§5.3）；
 *   - GET  /sorne/captures/:id（#44）：采集详情（请求/响应引用、条件快照与
 *     完整性状态，§18.3 完整依据层）。
 */
import { readRawBody } from "../http.mjs";
import { apiError } from "../errors.mjs";
import * as evidence from "../store/evidence.mjs";

function headerString(value) {
  if (Array.isArray(value)) return headerString(value[0]);
  if (value === undefined || value === null) return undefined;
  const text = String(value).trim();
  return text ? text.slice(0, 128) : undefined;
}

export const routes = [
  {
    method: "POST",
    path: "/sorne/evidence/blobs",
    rawBody: true, // 流式读取，dispatcher 不预读不解析（蓝图 §2.2）
    async handler(pctx, req, res, { query }) {
      let bytes;
      try {
        bytes = await readRawBody(req, evidence.evidenceMaxBytes());
      } catch (error) {
        if (error && error.code === "REQUEST_TOO_LARGE") {
          throw apiError("REQUEST_TOO_LARGE", `证据上传超过上限（${evidence.evidenceMaxBytes()} 字节），不会产生可用证据记录`, {
            limit_bytes: evidence.evidenceMaxBytes(),
          });
        }
        throw apiError("BAD_REQUEST", `上传流读取失败：${error?.message ?? error}`, { retryable: true });
      }
      const receipt = await evidence.storeBlob(pctx, {
        projectId: query.project_id,
        bytes,
        representation: query.representation,
        sourceKind: query.source_kind,
        expectedSha256: query.expected_sha256,
        actor: headerString(req.headers["x-sorne-actor"]),
      });
      return receipt;
    },
  },
  {
    method: "GET",
    path: "/sorne/evidence/blobs/:sha256",
    async handler(pctx, req, res, { params, query }) {
      const { bytes, row } = await evidence.readBlobBytes(pctx, {
        sha256: params.sha256,
        projectId: query.project_id,
      });
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "cache-control": "no-store",
        "content-length": String(bytes.length),
        "x-sorne-blob-id": row.blob_id,
        "x-sorne-project-id": row.project_id,
        "x-sorne-sha256": row.sha256,
        "x-sorne-byte-size": String(row.byte_size),
        "x-sorne-representation": row.representation,
        "x-sorne-source-kind": row.source_kind,
      });
      res.end(bytes);
      return undefined; // 已自行以字节响应
    },
  },
  {
    method: "POST",
    path: "/sorne/captures",
    async handler(pctx, req, res, { body }) {
      return evidence.registerCapture(pctx, body ?? {}, {
        actor: headerString(req.headers["x-sorne-actor"]),
      });
    },
  },
  {
    method: "GET",
    path: "/sorne/captures/:id",
    async handler(pctx, req, res, { params }) {
      return evidence.getCaptureDetail(pctx, params.id);
    },
  },
];
