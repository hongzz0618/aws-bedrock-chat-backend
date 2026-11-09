export const SERVICE_NAME = "aws-bedrock-chat-backend";

export interface AppConfig {
  chatTable?: string;
  awsRegion: string;
  environment: string;
  modelId: string;
  historyTurns: number;
  maxContextChars: number;
  retentionDays: number;
  maxTokens: number;
  temperature: number;
  toolCallingEnabled?: boolean;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  return {
    chatTable: env.CHAT_TABLE,
    awsRegion: env.AWS_REGION ?? env.AWS_DEFAULT_REGION ?? "eu-west-1",
    environment: nonBlank(env.ENVIRONMENT, "dev"),
    modelId: env.MODEL_ID ?? "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
    historyTurns: parseIntegerInRange(env.HISTORY_TURNS, 10, 0, 20),
    maxContextChars: parseIntegerInRange(env.MAX_CONTEXT_CHARS, 24000, 1, 200000),
    retentionDays: parseIntegerInRange(env.CHAT_RETENTION_DAYS, 7, 1, 365),
    maxTokens: parseIntegerInRange(env.MAX_TOKENS, 1024, 1, 4096),
    temperature: parseNumberInRange(env.TEMPERATURE, 0.2, 0, 1),
    toolCallingEnabled: env.TOOL_CALLING_ENABLED === "true",
  };
}

function nonBlank(value: string | undefined, fallback: string): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function parseIntegerInRange(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = parseInteger(value, fallback);
  if (parsed < min || parsed > max) {
    throw new Error(`Invalid integer config value: ${value ?? parsed}`);
  }

  return parsed;
}

function parseInteger(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isInteger(parsed)) {
    throw new Error(`Invalid integer config value: ${value}`);
  }

  return parsed;
}

function parseNumber(value: string | undefined, fallback: number): number {
  if (!value) {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`Invalid numeric config value: ${value}`);
  }

  return parsed;
}

function parseNumberInRange(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = parseNumber(value, fallback);
  if (parsed < min || parsed > max) {
    throw new Error(`Invalid numeric config value: ${value ?? parsed}`);
  }

  return parsed;
}
