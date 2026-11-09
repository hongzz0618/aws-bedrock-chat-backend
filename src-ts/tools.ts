import type { ConverseCommandInput, ToolResultBlock } from "@aws-sdk/client-bedrock-runtime";

interface SimulatedTool {
  name: string;
  description: string;
  aliasKey: string;
  alias: string;
  read: () => Record<string, number>;
}

const tools: readonly SimulatedTool[] = [
  {
    name: "get_sqs_queue_status",
    description: "Read a simulated SQS queue snapshot.",
    aliasKey: "queue_alias",
    alias: "orders-demo",
    read: () => ({ visibleMessages: 12, inFlightMessages: 2 }),
  },
  {
    name: "get_lambda_function_status",
    description: "Read simulated Lambda function metrics over a five-minute window.",
    aliasKey: "function_alias",
    alias: "chat-demo",
    read: () => ({ windowMinutes: 5, invocations: 42, errors: 1, throttles: 0 }),
  },
];

export const simulatedToolConfig: NonNullable<ConverseCommandInput["toolConfig"]> = {
  tools: tools.map(({ name, description, aliasKey, alias }) => ({
    toolSpec: {
      name,
      description,
      inputSchema: {
        json: {
          type: "object",
          properties: { [aliasKey]: { type: "string", enum: [alias] } },
          required: [aliasKey],
          additionalProperties: false,
        },
      },
    },
  })),
};

export function prepareToolRequest(name: string, input: unknown): (() => ToolResultBlock["content"]) | undefined {
  const tool = tools.find((entry) => entry.name === name);
  if (!tool || typeof input !== "object" || input === null || Array.isArray(input)) {
    return undefined;
  }

  const keys = Object.keys(input);
  if (keys.length !== 1 || keys[0] !== tool.aliasKey ||
      (input as Record<string, unknown>)[tool.aliasKey] !== tool.alias) {
    return undefined;
  }

  return () => [{
    json: { source: "simulated", resourceAlias: tool.alias, ...tool.read() },
  }];
}
