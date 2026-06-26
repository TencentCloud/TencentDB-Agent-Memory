import { describe, expect, it } from "vitest";
import { parseExtractionResult } from "./l1-extractor.js";

describe("parseExtractionResult", () => {
  it("ignores non-JSON bracketed text before the extraction array", () => {
    const raw = `
[姓名]）在 [时间] 这类说明不是 JSON。
[
  {
    "scene_name": "排障",
    "message_ids": ["m1"],
    "memories": [
      {
        "content": "用户使用 ollama nomic-embed-text 作为 embedding 模型",
        "type": "episodic",
        "priority": 60,
        "source_message_ids": ["m1"],
        "metadata": {}
      }
    ]
  }
]
补充说明：以上为提取结果。
`;

    const scenes = parseExtractionResult(raw);

    expect(scenes).toHaveLength(1);
    expect(scenes[0]?.scene_name).toBe("排障");
    expect(scenes[0]?.memories[0]?.content).toBe("用户使用 ollama nomic-embed-text 作为 embedding 模型");
  });

  it("accepts object-wrapped scene arrays with trailing text", () => {
    const raw = `{"scenes":[{"scene_name":"配置","message_ids":["m1"],"memories":[]}]} trailing text`;

    const scenes = parseExtractionResult(raw);

    expect(scenes).toHaveLength(1);
    expect(scenes[0]?.scene_name).toBe("配置");
  });

  it("skips unrelated JSON before the scene payload", () => {
    const raw = `{"note":"not the extraction payload"}\n[{"scene_name":"召回","message_ids":[],"memories":[]}]`;

    const scenes = parseExtractionResult(raw);

    expect(scenes).toHaveLength(1);
    expect(scenes[0]?.scene_name).toBe("召回");
  });
});
