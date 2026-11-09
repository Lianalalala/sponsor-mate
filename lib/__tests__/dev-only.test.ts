import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

import { isLocalRequest, isLocalToolEnabled } from "../dev-only.ts";

const env = process.env as Record<string, string | undefined>;
const originalNodeEnv = env.NODE_ENV;

function request(headers: Record<string, string>): Request {
  // fetch 規格不讓一般程式設定 host，所以用最小的假物件
  return { headers: new Headers(headers) } as Request;
}

describe("本機工具的開關", () => {
  afterEach(() => {
    env.NODE_ENV = originalNodeEnv;
  });

  it("部署後一律關閉，就算 host 是 localhost", () => {
    env.NODE_ENV = "production";
    assert.equal(isLocalToolEnabled(), false);
    assert.equal(isLocalRequest(request({ host: "localhost:3000" })), false);
  });

  it("開發時接受 localhost", () => {
    env.NODE_ENV = "development";
    assert.equal(isLocalRequest(request({ host: "localhost:3000" })), true);
    assert.equal(
      isLocalRequest(request({ host: "127.0.0.1:3000", origin: "http://127.0.0.1:3000" })),
      true,
    );
  });

  it("開發時擋下區網和其他網站", () => {
    env.NODE_ENV = "development";
    assert.equal(isLocalRequest(request({ host: "192.168.1.5:3000" })), false);
    assert.equal(
      isLocalRequest(request({ host: "localhost:3000", origin: "https://evil.example" })),
      false,
    );
  });
});
