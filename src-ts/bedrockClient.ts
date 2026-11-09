import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ConverseCommandInput,
  type ConverseCommandOutput,
} from "@aws-sdk/client-bedrock-runtime";

interface ConverseOptions {
  abortSignal?: AbortSignal;
}

export interface BedrockConverseClient {
  converse(input: ConverseCommandInput, options?: ConverseOptions): Promise<ConverseCommandOutput>;
}

export class AwsBedrockConverseClient implements BedrockConverseClient {
  private readonly client: BedrockRuntimeClient;

  constructor(region: string, toolCallingEnabled = false) {
    this.client = new BedrockRuntimeClient({
      region,
      ...(toolCallingEnabled ? { maxAttempts: 1 } : {}),
    });
  }

  async converse(input: ConverseCommandInput, options?: ConverseOptions): Promise<ConverseCommandOutput> {
    return this.client.send(new ConverseCommand(input), options);
  }
}

export function extractResponseText(response: ConverseCommandOutput): string {
  const firstContentBlock = response.output?.message?.content?.[0];
  return firstContentBlock?.text ?? "";
}
