import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "yaml";
import { describe, expect, it, vi } from "vitest";
import { createHandler } from "../src-ts/handler";
import { loadConfig } from "../src-ts/config";
import { runbookCorpus } from "../src-ts/runbookCorpus";
import { RUNBOOK_LIMITS } from "../src-ts/runbookContext";
import {
  CHAT_REQUEST_ALLOWED_FIELDS,
  CHAT_REQUEST_LIMITS,
  parseJsonBody,
} from "../src-ts/validation";

const root = process.cwd();
const openApi = parse(readFileSync(join(root, "openapi/openapi.yaml"), "utf8")) as OpenApiDocument;
const liveMain = readFileSync(join(root, "live/dev/main.tf"), "utf8");

interface OpenApiDocument {
  openapi: string;
  paths: Record<string, Record<string, Operation>>;
  components: {
    schemas: Record<string, JsonSchema>;
    securitySchemes: Record<string, unknown>;
  };
}

interface Operation {
  operationId: string;
  security?: Array<Record<string, unknown>>;
  requestBody?: {
    content: {
      "application/json": {
        schema: JsonSchema;
      };
    };
  };
  responses: Record<string, {
    content?: {
      "application/json"?: {
        schema: JsonSchema;
      };
    };
  }>;
}

interface JsonSchema {
  $ref?: string;
  type?: string;
  description?: string;
  const?: unknown;
  required?: string[];
  not?: JsonSchema;
  allOf?: JsonSchema[];
  additionalProperties?: boolean | JsonSchema;
  properties?: Record<string, JsonSchema>;
  pattern?: string;
  minLength?: number;
  maxLength?: number;
  minimum?: number;
  maximum?: number;
  maxItems?: number;
  items?: JsonSchema;
}

function terraformRoutes(): string[] {
  return Array.from(liveMain.matchAll(/"([A-Z]+ \/[^"]+)"\s*=/g))
    .map((match) => match[1])
    .sort();
}

function openApiRoutes(): string[] {
  return Object.entries(openApi.paths)
    .flatMap(([path, methods]) => Object.keys(methods).map((method) => `${method.toUpperCase()} ${path}`))
    .sort();
}

function resolveSchema(schema: JsonSchema): JsonSchema {
  if (!schema.$ref) {
    return schema;
  }

  const name = schema.$ref.replace("#/components/schemas/", "");
  const resolved = openApi.components.schemas[name];
  if (!resolved) {
    throw new Error(`Unresolved schema ref: ${schema.$ref}`);
  }

  return resolved;
}

function validateSchema(value: unknown, schema: JsonSchema): string[] {
  const resolved = resolveSchema(schema);
  const errors: string[] = [];

  if (resolved.const !== undefined && value !== resolved.const) {
    errors.push(`expected const ${String(resolved.const)}`);
  }

  if (resolved.type === "object") {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return ["expected object"];
    }

    const record = value as Record<string, unknown>;
    // Check the required-field exclusions used by ChatRequest.
    for (const exclusion of [resolved, ...(resolved.allOf ?? [])]) {
      const forbiddenTogether = exclusion.not?.required;
      if (forbiddenTogether?.every((key) => key in record)) {
        errors.push(`incompatible fields: ${forbiddenTogether.join(", ")}`);
      }
    }
    for (const required of resolved.required ?? []) {
      if (!(required in record)) {
        errors.push(`missing ${required}`);
      }
    }

    if (resolved.additionalProperties === false) {
      const allowed = new Set(Object.keys(resolved.properties ?? {}));
      for (const key of Object.keys(record)) {
        if (!allowed.has(key)) {
          errors.push(`unexpected ${key}`);
        }
      }
    }

    for (const [key, propertySchema] of Object.entries(resolved.properties ?? {})) {
      if (key in record) {
        errors.push(...validateSchema(record[key], propertySchema).map((error) => `${key}: ${error}`));
      }
    }
  }

  if (resolved.type === "string" && typeof value !== "string") {
    errors.push("expected string");
  }

  if (resolved.type === "array") {
    if (!Array.isArray(value)) return ["expected array"];
    if (resolved.maxItems !== undefined && value.length > resolved.maxItems) errors.push("too many items");
    if (resolved.items) {
      const items = resolved.items;
      value.forEach((item, index) => {
        errors.push(...validateSchema(item, items).map((error) => `${index}: ${error}`));
      });
    }
  }

  if (resolved.type === "integer" && (!Number.isInteger(value))) {
    errors.push("expected integer");
  }

  if (resolved.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) {
    errors.push("expected number");
  }

  return errors;
}

function jsonResponseSchema(path: string, method: string, status: number): JsonSchema {
  const operation = openApi.paths[path]?.[method];
  const schema = operation?.responses[String(status)]?.content?.["application/json"]?.schema;
  if (!schema) {
    throw new Error(`Missing response schema for ${method.toUpperCase()} ${path} ${status}`);
  }
  return schema;
}

it.each(["rag_enabled", "tool_calling_enabled"])("wires %s to the Lambda environment", (name) => {
  const liveVariables = readFileSync(join(root, "live/dev/variables.tf"), "utf8");
  const lambdaMain = readFileSync(join(root, "modules/lambda_function/main.tf"), "utf8");
  const flag = liveVariables.match(new RegExp(`^variable "${name}"\\s*\\{([^}]*)\\}`, "m"))?.[1] ?? "";
  const lambda = liveMain.match(/^module "lambda_api"\s*\{([\s\S]*?)^\}/m)?.[1] ?? "";
  const environment = liveMain.match(/^\s*lambda_environment\s*=\s*\{([^}]*)\}/m)?.[1] ?? "";
  const resource = lambdaMain.match(/^resource "aws_lambda_function" "this"\s*\{([\s\S]*?)^\}/m)?.[1] ?? "";

  expect(flag).toMatch(/^\s*type\s*=\s*bool\s*$/m);
  expect(flag).toMatch(/^\s*default\s*=\s*false\s*$/m);
  expect(lambda).toMatch(/^\s*source\s*=\s*"\.\.\/\.\.\/modules\/lambda_function"\s*$/m);
  expect(lambda).toMatch(/^\s*environment\s*=\s*local\.lambda_environment\s*$/m);
  expect(environment).toMatch(new RegExp(`^\\s*${name.toUpperCase()}\\s*=\\s*tostring\\(var\\.${name}\\)\\s*$`, "m"));
  expect(resource).toMatch(/^\s*environment\s*\{\s*variables\s*=\s*var\.environment\s*\}/m);
});

describe("OpenAPI contract", () => {
  it("parses as OpenAPI 3.1 with a Cognito bearer JWT security scheme", () => {
    expect(openApi.openapi).toBe("3.1.0");
    expect(openApi.components.securitySchemes.CognitoJwt).toMatchObject({
      type: "http",
      scheme: "bearer",
      bearerFormat: "JWT",
    });
  });

  it("uses unique operation IDs", () => {
    const operationIds = Object.values(openApi.paths)
      .flatMap((methods) => Object.values(methods).map((operation) => operation.operationId));

    expect(new Set(operationIds).size).toBe(operationIds.length);
  });

  it("keeps OpenAPI routes aligned with Terraform routes", () => {
    expect(openApiRoutes()).toEqual(terraformRoutes());
  });

  it("documents /chat as protected and /health as public", () => {
    expect(openApi.paths["/chat"].post.security).toEqual([{ CognitoJwt: [] }]);
    expect(openApi.paths["/health"].get.security).toEqual([]);
  });

  it("keeps request limits aligned with TypeScript validation constants", () => {
    const requestSchema = resolveSchema(
      openApi.paths["/chat"].post.requestBody?.content["application/json"].schema ?? {},
    );
    const properties = requestSchema.properties ?? {};

    expect(properties.prompt.maxLength).toBe(CHAT_REQUEST_LIMITS.promptMaxLength);
    expect(properties.prompt.pattern).toBe("\\S");
    expect(properties.prompt.description).toContain("trimmed before validation");
    expect(properties.prompt.description).toContain("non-whitespace");
    expect(properties.session_id.maxLength).toBe(CHAT_REQUEST_LIMITS.sessionIdMaxLength);
    expect(properties.system_prompt.maxLength).toBe(CHAT_REQUEST_LIMITS.systemPromptMaxLength);
    expect(properties.history_turns.minimum).toBe(CHAT_REQUEST_LIMITS.historyTurnsMin);
    expect(properties.history_turns.maximum).toBe(CHAT_REQUEST_LIMITS.historyTurnsMax);
    expect(properties.max_tokens.minimum).toBe(CHAT_REQUEST_LIMITS.maxTokensMin);
    expect(properties.max_tokens.maximum).toBe(CHAT_REQUEST_LIMITS.maxTokensMax);
    expect(properties.temperature.minimum).toBe(CHAT_REQUEST_LIMITS.temperatureMin);
    expect(properties.temperature.maximum).toBe(CHAT_REQUEST_LIMITS.temperatureMax);
    expect(properties.top_p.minimum).toBe(CHAT_REQUEST_LIMITS.topPMin);
    expect(properties.top_p.maximum).toBe(CHAT_REQUEST_LIMITS.topPMax);
  });

  it("keeps ChatRequest fields aligned with the runtime allowlist", () => {
    const requestSchema = resolveSchema(
      openApi.paths["/chat"].post.requestBody?.content["application/json"].schema ?? {},
    );

    expect(requestSchema.additionalProperties).toBe(false);
    expect(Object.keys(requestSchema.properties ?? {}).sort()).toEqual(
      [...CHAT_REQUEST_ALLOWED_FIELDS].sort(),
    );
  });

  it("documents gated runbook mode and its incompatible fields", () => {
    const schema = openApi.components.schemas.ChatRequest;
    expect(schema.properties?.mode).toMatchObject({ type: "string", const: "runbook" });
    expect(schema.properties?.mode.description).toContain("only when RAG_ENABLED is true");
    expect(schema.properties?.mode.description).toContain("otherwise HTTP 400");
    expect(schema.allOf).toEqual([
      { not: { required: ["mode", "system_prompt"] } },
      { not: { required: ["mode", "history_turns"] } },
    ]);
  });

  it.each([
    [{}, true],
    [{ system_prompt: "", history_turns: 0 }, true],
    [{ mode: "runbook" }, true],
    [{ mode: "runbook", system_prompt: "" }, false],
    [{ mode: "runbook", system_prompt: null }, false],
    [{ mode: "runbook", history_turns: 0 }, false],
    [{ mode: "runbook", history_turns: null }, false],
    ...[null, "", " ", "chat", "RUNBOOK", " runbook ", 1, true, [], {}].map((mode) => [{ mode }, false]),
  ])("aligns mode parsing with the request schema for %j", (fields, valid) => {
    const body = { prompt: "hello", ...(fields as object) };
    expect(validateSchema(body, openApi.components.schemas.ChatRequest).length === 0).toBe(valid);
    const parseBody = () => parseJsonBody({ body: JSON.stringify(body) });
    if (valid) {
      expect(parseBody).not.toThrow();
    } else {
      expect(parseBody).toThrow("Invalid chat request");
    }
  });

  it("validates the blocked runbook response against the error schema", async () => {
    const response = await createHandler({ config: {
      chatTable: "mock", awsRegion: "eu-west-1", environment: "test", modelId: "mock",
      historyTurns: 10, maxContextChars: 24000, retentionDays: 7, maxTokens: 1024,
      temperature: 0.2, ragEnabled: false,
    } })({
      rawPath: "/chat",
      requestContext: { http: { method: "POST" }, authorizer: { jwt: { claims: { sub: "user-a" } } } },
      body: JSON.stringify({ prompt: "hello", mode: "runbook" }),
    });
    expect(response.statusCode).toBe(400);
    expect(JSON.parse(response.body)).toEqual({ error: "Invalid chat request" });
    expect(validateSchema(JSON.parse(response.body), jsonResponseSchema("/chat", "post", 400))).toEqual([]);
  });

  it.each(["generated", "abstention", "regular"])("validates the %s response against the success schema", async (mode) => {
    const chunk = runbookCorpus[0];
    const converse = vi.fn(async () => ({
      $metadata: {}, stopReason: "end_turn" as const,
      usage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      output: { message: { role: "assistant" as const, content: [{ text: "Mock guidance" }] } },
    }));
    const response = await createHandler({
      config: { ...loadConfig({ CHAT_TABLE: "mock" }), ragEnabled: true },
      repository: { queryHistoryTurns: async () => [], saveTurn: async () => undefined },
      bedrockClient: { converse },
      runbookRetriever: { retrieve: () => mode === "abstention" ? [] : [chunk] },
    })({
      rawPath: "/chat",
      requestContext: { http: { method: "POST" }, authorizer: { jwt: { claims: { sub: "user-a" } } } },
      body: JSON.stringify({ prompt: "SQS backlog", ...(mode !== "regular" ? { mode: "runbook" } : {}) }),
    });
    expect(response.statusCode).toBe(200);
    const body = JSON.parse(response.body);
    expect(validateSchema(body, jsonResponseSchema("/chat", "post", 200))).toEqual([]);
    if (mode === "regular") expect(body).not.toHaveProperty("sources");
    else expect(body.sources).toEqual(mode === "abstention" ? [] : [{
      documentId: chunk.documentId, chunkId: chunk.chunkId, title: chunk.title,
      section: chunk.section, version: chunk.version,
    }]);
    if (mode === "abstention") {
      expect(body.usage).toEqual({});
      expect(body).not.toHaveProperty("stopReason");
      expect(converse).not.toHaveBeenCalled();
    }
  });

  it("documents supplied reference metadata and enforces the source array shape", () => {
    const schema = openApi.components.schemas.ChatSuccessResponse.properties?.sources;
    expect(schema).toBeDefined();
    expect(schema?.maxItems).toBe(RUNBOOK_LIMITS.maxChunks);
    expect(schema?.description).toContain("Present only for runbook responses");
    expect(schema?.description).toContain("not proof that every sentence has been independently verified");
    const source = { documentId: "doc", chunkId: "doc.chunk", title: "Title", section: "Section", version: "1" };
    expect(validateSchema([source], schema!)).toEqual([]);
    for (const key of Object.keys(source)) {
      const incomplete = Object.fromEntries(Object.entries(source).filter(([field]) => field !== key));
      expect(validateSchema([incomplete], schema!).length).toBeGreaterThan(0);
    }
    for (const invalid of [{}, [null], [{ ...source, version: 1 }], [{ ...source, url: "invented" }], Array(4).fill(source)]) {
      expect(validateSchema(invalid, schema!).length).toBeGreaterThan(0);
    }
  });

  it("documents temperature and top_p as mutually exclusive", () => {
    const requestSchema = resolveSchema(
      openApi.paths["/chat"].post.requestBody?.content["application/json"].schema ?? {},
    );

    expect(requestSchema.description).toContain(
      "temperature and top_p are mutually exclusive. Supply at most one.",
    );
    expect(requestSchema.not?.required).toEqual(["temperature", "top_p"]);
  });

  it("documents expected chat error statuses", () => {
    expect(Object.keys(openApi.paths["/chat"].post.responses).sort()).toEqual([
      "200",
      "400",
      "401",
      "429",
      "500",
      "502",
      "503",
    ]);
  });

  it("documents stage throttling on the public health route", () => {
    expect(openApi.paths["/health"].get.responses["429"]).toBeDefined();
  });

  it("validates representative handler responses against OpenAPI schemas", async () => {
    const health = await createHandler()({
      rawPath: "/health",
      requestContext: { http: { method: "GET" } },
    });
    expect(validateSchema(JSON.parse(health.body), jsonResponseSchema("/health", "get", 200))).toEqual([]);

    const unauthorized = await createHandler({ config: {
      chatTable: "chat-table",
      awsRegion: "us-east-1",
      environment: "test",
      modelId: "test-model",
      historyTurns: 10,
      maxContextChars: 24000,
      retentionDays: 7,
      maxTokens: 1024,
      temperature: 0.2,
    } })({
      rawPath: "/chat",
      body: JSON.stringify({ prompt: "hello" }),
      requestContext: { http: { method: "POST" } },
    });
    expect(validateSchema(JSON.parse(unauthorized.body), jsonResponseSchema("/chat", "post", 401))).toEqual([]);
  });
});
