import { expect, it } from "vitest";
import { loadConfig } from "../src-ts/config";

it.each([
  [undefined, undefined, false, false],
  ["false", "false", false, false],
  ["true", "false", true, false],
  ["false", "true", false, true],
  ["true", "true", true, true],
  ["TRUE", "1", false, false],
])("loads RAG %s and Tool Calling %s independently", (rag, tools, ragEnabled, toolCallingEnabled) => {
  const config = loadConfig({ RAG_ENABLED: rag, TOOL_CALLING_ENABLED: tools });
  expect(config).toMatchObject({ ragEnabled, toolCallingEnabled });
});
