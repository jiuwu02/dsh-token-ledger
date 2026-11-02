/**
 * The two HTTP primitives the plugin route needs.
 */

/**
 * Largest request body the route accepts. A settings save is a small JSON
 * object, so anything larger is not a request this endpoint serves.
 */
export const BODY_LIMIT = 64 * 1024;

/**
 * Read and parse a bounded JSON request body.
 * @param req - the incoming request.
 * @returns the parsed object, or an empty object for a malformed body.
 */
export async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > BODY_LIMIT) return {};
    chunks.push(chunk);
  }
  if (chunks.length === 0) return {};
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return typeof value === "object" && value !== null ? value : {};
  } catch {
    return {};
  }
}

/**
 * Write one JSON response.
 * @param res - the response to own.
 * @param status - HTTP status code.
 * @param value - JSON-serializable body.
 */
export function writeJson(res, status, value) {
  if (res.headersSent === true) {
    res.destroy?.();
    return;
  }
  const body = JSON.stringify(value);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(body),
  });
  res.end(body);
}
