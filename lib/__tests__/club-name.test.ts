import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { CLUB_NAME_MAX_LENGTH, validateClubName } from "../club-name.ts";

describe("社團名稱（validateClubName）", () => {
  it("一般名稱：去掉前後空白", () => {
    assert.deepEqual(validateClubName("  台大熱舞社 "), { ok: true, name: "台大熱舞社" });
  });

  it("全形空白、換行、連續空白都縮成一個半形空白", () => {
    assert.deepEqual(validateClubName("台大\u3000\u3000熱舞社\n公關部"), { ok: true, name: "台大 熱舞社 公關部" });
  });

  it("空的、只有空白、不是文字 → 請填", () => {
    for (const bad of ["", "   ", "\u3000", undefined, null, 123]) {
      assert.deepEqual(validateClubName(bad), { ok: false, message: "請填社團名稱" });
    }
  });

  it("有看不見的字元（零寬字元、控制字元）→ 拒絕", () => {
    for (const bad of ["熱舞\u200b社", "熱舞\u0007社", "\u202e熱舞社"]) {
      assert.equal(validateClubName(bad).ok, false);
    }
  });

  it(`最多 ${CLUB_NAME_MAX_LENGTH} 個字（中文、emoji 都算一個字）`, () => {
    assert.equal(validateClubName("社".repeat(CLUB_NAME_MAX_LENGTH)).ok, true);
    assert.equal(validateClubName("社".repeat(CLUB_NAME_MAX_LENGTH + 1)).ok, false);
    assert.equal(validateClubName("🎉".repeat(CLUB_NAME_MAX_LENGTH)).ok, true);
  });
});
