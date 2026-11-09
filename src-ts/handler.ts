import { SERVICE_NAME, loadConfig } from "./config";
import { AwsBedrockConverseClient } from "./bedrockClient";
import { handleChat, type ChatDependencies } from "./chatService";
import { DynamoDbChatRepository } from "./chatRepository";
import { jsonResponse } from "./response";
import type { HealthResponseBody, HttpEvent, LambdaResponse } from "./types";
import { getHttpMethod, getRawPath } from "./validation";

type ChatDependenciesFactory = () => ChatDependencies;

export function createCachedChatDependenciesFactory(
  createDependencies: ChatDependenciesFactory,
): ChatDependenciesFactory {
  let cachedDependencies: ChatDependencies | undefined;

  return () => {
    cachedDependencies ??= createDependencies();
    return cachedDependencies;
  };
}

function createDefaultChatDependencies(): ChatDependencies {
  const config = loadConfig();

  if (!config.chatTable) {
    return { config };
  }

  return {
    config,
    repository: new DynamoDbChatRepository(config.chatTable, config.awsRegion),
    bedrockClient: new AwsBedrockConverseClient(config.awsRegion, config.toolCallingEnabled),
  };
}

const getDefaultChatDependencies = createCachedChatDependenciesFactory(
  createDefaultChatDependencies,
);

export function createHandler(
  dependencies: ChatDependencies = {},
  defaultChatDependencies: ChatDependenciesFactory = getDefaultChatDependencies,
) {
  const hasInjectedChatDependencies = Object.keys(dependencies).length > 0;

  return async function handleEvent(
    event: HttpEvent,
    context?: { getRemainingTimeInMillis(): number },
  ): Promise<LambdaResponse> {
    const method = getHttpMethod(event);
    const path = getRawPath(event);

    if (method === "GET" && path === "/health") {
      const body: HealthResponseBody = {
        status: "ok",
        service: SERVICE_NAME,
      };

      return jsonResponse(200, body);
    }

    if (method === "POST" && path === "/chat") {
      return handleChat(
        event,
        hasInjectedChatDependencies ? dependencies : defaultChatDependencies(),
        context && (() => context.getRemainingTimeInMillis()),
      );
    }

    return jsonResponse(404, { error: "Not Found" });
  };
}

export const handler = createHandler();
