import "@testing-library/jest-dom";

/**
 * jsdom does not ship `Request`/`Response` globals, but `next/server`
 * touches them at module-evaluation time. We register a dependency-free
 * shim here (in `setupFilesAfterEach`) so any test file that imports a
 * Next.js route handler can do so without pulling in `undici`.
 *
 * The shim only implements the surface our route handlers actually use
 * (`url`, `method`, `headers`). Tests that need real Web fetch semantics
 * should mock `global.fetch` directly per call.
 */
class RequestShim {
  url: string;
  method: string;
  headers: Map<string, string>;
  private readonly _body: string | null;
  constructor(
    input: string,
    init?: { method?: string; headers?: Record<string, string>; body?: BodyInit | null }
  ) {
    this.url = input;
    this.method = init?.method ?? "GET";
    this.headers = new Map(Object.entries(init?.headers ?? {}));
    const b = init?.body;
    this._body = typeof b === "string" ? b : null;
  }
  async json(): Promise<unknown> {
    if (this._body === null || this._body === "") {
      throw new TypeError("Request body unavailable");
    }
    return JSON.parse(this._body) as unknown;
  }
}

/**
 * Cast the shim writes through `unknown` because globalThis already has
 * DOM types for Request/Response/Headers under jsdom — TS would otherwise
 * reject our minimal classes for missing methods we don't actually need.
 */
const g = globalThis as unknown as {
  Request?: unknown;
  Response?: unknown;
  Headers?: unknown;
};
if (typeof g.Request === "undefined") {
  g.Request = RequestShim;
}
if (typeof g.Response === "undefined") {
  /**
   * Minimal Web `Response`-shaped shim sufficient for `NextResponse`.
   *
   * `NextResponse.json(body, init)` internally does:
   *   const r = Response.json(body, init);
   *   return new NextResponse(r.body, r);
   *
   * which means our `body` must survive the constructor → wrapping →
   * `await res.json()` round trip. We mirror real Web semantics: store
   * the serialized JSON on `body`, parse it back in `.json()`. Headers
   * is a tiny iterable wrapper so the `headers.get(...)` pattern works.
   */
  class HeadersShim {
    private map: Map<string, string>;
    constructor(init?: Record<string, string> | HeadersShim | Iterable<[string, string]>) {
      this.map = new Map();
      if (init instanceof HeadersShim) {
        init.map.forEach((v, k) => this.map.set(k.toLowerCase(), v));
      } else if (init && typeof (init as Iterable<[string, string]>)[Symbol.iterator] === "function") {
        for (const [k, v] of init as Iterable<[string, string]>) {
          this.map.set(k.toLowerCase(), v);
        }
      } else if (init && typeof init === "object") {
        for (const [k, v] of Object.entries(init as Record<string, string>)) {
          this.map.set(k.toLowerCase(), v);
        }
      }
    }
    get(key: string): string | null {
      return this.map.get(key.toLowerCase()) ?? null;
    }
    set(key: string, value: string): void {
      this.map.set(key.toLowerCase(), value);
    }
    has(key: string): boolean {
      return this.map.has(key.toLowerCase());
    }
    [Symbol.iterator]() {
      return this.map.entries();
    }
    entries() {
      return this.map.entries();
    }
  }
  g.Headers = HeadersShim;

  type ResponseInit = {
    status?: number;
    headers?: Record<string, string> | HeadersShim;
  };

  class ResponseShim {
    status: number;
    headers: HeadersShim;
    body: string | null;
    constructor(body?: string | null, init?: ResponseInit | ResponseShim) {
      this.body = body ?? null;
      if (init instanceof ResponseShim) {
        this.status = init.status;
        this.headers = new HeadersShim(init.headers);
      } else {
        this.status = init?.status ?? 200;
        this.headers = new HeadersShim(init?.headers);
      }
    }
    static json(payload: unknown, init?: ResponseInit) {
      const headers = new HeadersShim(init?.headers);
      headers.set("content-type", "application/json");
      return new ResponseShim(JSON.stringify(payload), {
        status: init?.status,
        headers,
      });
    }
    async json() {
      return this.body !== null ? JSON.parse(this.body) : null;
    }
    async text() {
      return this.body ?? "";
    }
  }
  g.Response = ResponseShim;
}

jest.mock("next/cache", () => ({
  unstable_cache: <T>(fn: () => Promise<T>) => fn,
}));
