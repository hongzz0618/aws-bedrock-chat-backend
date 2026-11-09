export interface HttpRequestContext {
  http?: {
    method?: string;
  };
  requestId?: string;
  authorizer?: {
    jwt?: {
      claims?: {
        sub?: unknown;
      };
    };
  };
}

export interface HttpEvent {
  rawPath?: string;
  body?: string | null;
  requestContext?: HttpRequestContext;
}

export interface LambdaResponse {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

export interface HealthResponseBody {
  status: "ok";
  service: string;
}

export interface ChatRequestBody {
  mode?: unknown;
  prompt?: unknown;
  session_id?: unknown;
  system_prompt?: unknown;
  history_turns?: unknown;
  max_tokens?: unknown;
  temperature?: unknown;
  top_p?: unknown;
}

export interface ChatTurnItem {
  user_id: string;
  session_id: string;
  sk: string;
  timestamp: number;
  prompt: string;
  response: string;
  model_id: string;
  expires_at: number;
  input_tokens?: number;
  output_tokens?: number;
}

export interface ChatHistoryTurn {
  prompt: string;
  response: string;
}

export interface ChatSuccessResponseBody {
  session_id: string;
  timestamp: number;
  response: string;
  usage: unknown;
  stopReason: string | undefined;
}
