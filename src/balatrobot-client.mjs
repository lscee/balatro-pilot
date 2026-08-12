const DEFAULT_BASE_URL = "http://127.0.0.1:12346";
const DEFAULT_TIMEOUT_MS = 5_000;

function errorContext({ method, requestId, cause } = {}) {
  const options = cause === undefined ? undefined : { cause };
  return { options, method, requestId };
}

export class BalatrobotError extends Error {
  constructor(message, context = {}) {
    const { options, method, requestId } = errorContext(context);
    super(message, options);
    this.name = new.target.name;
    if (method !== undefined) this.method = method;
    if (requestId !== undefined) this.requestId = requestId;
  }
}

export class BalatrobotTransportError extends BalatrobotError {}

export class BalatrobotNetworkError extends BalatrobotTransportError {}

export class BalatrobotTimeoutError extends BalatrobotTransportError {
  constructor(message, { timeoutMs, ...context } = {}) {
    super(message, context);
    this.timeoutMs = timeoutMs;
  }
}

export class BalatrobotAbortError extends BalatrobotTransportError {
  constructor(message, context = {}) {
    super(message, context);
    this.name = "AbortError";
  }
}

export class BalatrobotHttpError extends BalatrobotTransportError {
  constructor(message, { status, statusText, body, ...context } = {}) {
    super(message, context);
    this.status = status;
    this.statusText = statusText;
    this.body = body;
  }
}

export class BalatrobotRpcError extends BalatrobotError {
  constructor(message, { code, data, ...context } = {}) {
    super(message, context);
    this.code = code;
    this.data = data;
  }
}

export class BalatrobotProtocolError extends BalatrobotError {
  constructor(message, { response, ...context } = {}) {
    super(message, context);
    this.response = response;
  }
}

function normalizeBaseUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch (cause) {
    throw new TypeError(`Invalid BalatroBot base URL: ${value}`, { cause });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new TypeError(`BalatroBot base URL must use HTTP or HTTPS, received ${url.protocol}`);
  }
  return url.toString();
}

function normalizeTimeout(value, label = "timeoutMs") {
  if (!Number.isFinite(value) || value <= 0) {
    throw new TypeError(`${label} must be a positive finite number`);
  }
  return value;
}

function isAbortSignal(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    typeof value.aborted === "boolean" &&
    typeof value.addEventListener === "function" &&
    typeof value.removeEventListener === "function"
  );
}

function httpErrorDetail(body) {
  if (typeof body?.error?.message === "string" && body.error.message) return body.error.message;
  if (typeof body?.message === "string" && body.message) return body.message;
  return "";
}

function validateResponse(body, { method, requestId }) {
  const context = { method, requestId, response: body };
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new BalatrobotProtocolError("BalatroBot returned a non-object JSON-RPC response", context);
  }
  if (body.jsonrpc !== "2.0") {
    throw new BalatrobotProtocolError("BalatroBot returned an invalid JSON-RPC version", context);
  }
  if (body.id !== requestId) {
    throw new BalatrobotProtocolError(
      `BalatroBot response id ${JSON.stringify(body.id)} did not match request id ${requestId}`,
      context,
    );
  }

  const hasResult = Object.hasOwn(body, "result");
  const hasError = Object.hasOwn(body, "error");
  if (hasResult === hasError) {
    throw new BalatrobotProtocolError(
      "BalatroBot JSON-RPC response must contain exactly one of result or error",
      context,
    );
  }
  if (hasError) {
    const rpcError = body.error;
    if (
      !rpcError ||
      typeof rpcError !== "object" ||
      Array.isArray(rpcError) ||
      !Number.isInteger(rpcError.code) ||
      typeof rpcError.message !== "string"
    ) {
      throw new BalatrobotProtocolError("BalatroBot returned a malformed JSON-RPC error", context);
    }
    throw new BalatrobotRpcError(`BalatroBot RPC ${method} failed: ${rpcError.message}`, {
      method,
      requestId,
      code: rpcError.code,
      data: rpcError.data,
    });
  }
  return body.result;
}

export class BalatrobotClient {
  constructor({ baseUrl = DEFAULT_BASE_URL, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = fetch } = {}) {
    if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.timeoutMs = normalizeTimeout(timeoutMs);
    this.fetch = fetchImpl;
    this.nextRequestId = 1;
    this.requestTail = Promise.resolve();
  }

  health(options = {}) {
    return this.call("health", undefined, options);
  }

  gamestate(options = {}) {
    return this.call("gamestate", undefined, options);
  }

  call(method, params, options = {}) {
    const execute = () => this.#callNow(method, params, options);
    const request = this.requestTail.then(execute, execute);
    this.requestTail = request.catch(() => undefined);
    return request;
  }

  async #callNow(method, params, options = {}) {
    if (typeof method !== "string" || !method.trim()) {
      throw new TypeError("BalatroBot RPC method must be a non-empty string");
    }
    if (params !== undefined && (!params || typeof params !== "object")) {
      throw new TypeError("BalatroBot RPC params must be an object or array when provided");
    }
    if (!options || typeof options !== "object") throw new TypeError("BalatroBot call options must be an object");

    const timeoutMs = normalizeTimeout(options.timeoutMs ?? this.timeoutMs, "call timeoutMs");
    const signal = options.signal;
    if (signal !== undefined && !isAbortSignal(signal)) {
      throw new TypeError("signal must be an AbortSignal");
    }

    const requestId = this.nextRequestId++;
    const payload = { jsonrpc: "2.0", method: method.trim(), id: requestId };
    if (params !== undefined) payload.params = params;
    let body;
    try {
      body = JSON.stringify(payload);
    } catch (cause) {
      throw new TypeError("BalatroBot RPC params must be JSON-serializable", { cause });
    }

    if (signal?.aborted) {
      throw new BalatrobotAbortError(`BalatroBot RPC ${payload.method} was aborted`, {
        method: payload.method,
        requestId,
        cause: signal.reason,
      });
    }

    const controller = new AbortController();
    let abortedByCaller = false;
    let timedOut = false;
    const abortFromCaller = () => {
      if (controller.signal.aborted) return;
      abortedByCaller = true;
      controller.abort(signal.reason);
    };
    signal?.addEventListener("abort", abortFromCaller, { once: true });
    if (signal?.aborted) abortFromCaller();
    const timer = setTimeout(() => {
      if (controller.signal.aborted) return;
      timedOut = true;
      controller.abort(new DOMException("BalatroBot request timed out", "TimeoutError"));
    }, timeoutMs);

    try {
      const response = await this.fetch(this.baseUrl, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body,
        signal: controller.signal,
      });
      const responseText = await response.text();
      let responseBody;
      let parseError;
      if (responseText.trim()) {
        try {
          responseBody = JSON.parse(responseText);
        } catch (cause) {
          parseError = cause;
        }
      }

      if (!response.ok) {
        const detail = httpErrorDetail(responseBody);
        const statusText = response.statusText || "HTTP error";
        throw new BalatrobotHttpError(
          `BalatroBot HTTP ${response.status} ${statusText}${detail ? `: ${detail}` : ""}`,
          {
            method: payload.method,
            requestId,
            status: response.status,
            statusText: response.statusText,
            body: responseBody ?? responseText,
          },
        );
      }
      if (!responseText.trim()) {
        throw new BalatrobotProtocolError("BalatroBot returned an empty response", {
          method: payload.method,
          requestId,
          response: null,
        });
      }
      if (parseError) {
        throw new BalatrobotProtocolError("BalatroBot returned invalid JSON", {
          method: payload.method,
          requestId,
          response: responseText,
          cause: parseError,
        });
      }
      return validateResponse(responseBody, { method: payload.method, requestId });
    } catch (cause) {
      if (timedOut) {
        throw new BalatrobotTimeoutError(`BalatroBot RPC ${payload.method} timed out after ${timeoutMs}ms`, {
          method: payload.method,
          requestId,
          timeoutMs,
          cause,
        });
      }
      if (abortedByCaller || signal?.aborted) {
        throw new BalatrobotAbortError(`BalatroBot RPC ${payload.method} was aborted`, {
          method: payload.method,
          requestId,
          cause: signal?.reason ?? cause,
        });
      }
      if (cause instanceof BalatrobotError) throw cause;
      throw new BalatrobotNetworkError(`BalatroBot RPC ${payload.method} could not reach ${this.baseUrl}`, {
        method: payload.method,
        requestId,
        cause,
      });
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abortFromCaller);
    }
  }
}

export { BalatrobotClient as BalatroBotClient };
export default BalatrobotClient;
