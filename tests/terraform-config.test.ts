import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function readRepoFile(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("terraform Bedrock IAM configuration", () => {
  const iamMain = readRepoFile("modules/iam_lambda_basic/main.tf");
  const iamVariables = readRepoFile("modules/iam_lambda_basic/variables.tf");
  const liveMain = readRepoFile("live/dev/main.tf");
  const liveVariables = readRepoFile("live/dev/variables.tf");
  const combined = [iamMain, iamVariables, liveMain, liveVariables].join("\n");

  it("does not retain broad Bedrock wildcard resources", () => {
    expect(combined).not.toContain("arn:aws:bedrock:*::foundation-model/*");
    expect(combined).not.toContain("arn:aws:bedrock:*:*:inference-profile/*");
    expect(combined).not.toContain("arn:aws:bedrock:*:*:application-inference-profile/*");
    expect(iamMain).not.toMatch(/Resource\s*=\s*"\*"/);
  });

  it("grants only the Bedrock action used by the current Converse path", () => {
    expect(iamMain).toContain('Action   = ["bedrock:InvokeModel"]');
    expect(iamMain).not.toContain("bedrock:InvokeModelWithResponseStream");
  });

  it("requires exact Bedrock resource ARNs without wildcard fallback", () => {
    expect(iamVariables).toContain("bedrock_inference_profile_arns");
    expect(iamVariables).toContain("bedrock_foundation_model_arns");
    expect(iamVariables).toContain("without wildcards");
    expect(iamMain).toContain("at least one exact Bedrock resource ARN");
  });

  it("wires MODEL_ID to matching Bedrock IAM inputs in the dev root", () => {
    expect(liveMain).toMatch(/bedrock_model_id\s*=\s*var\.bedrock_model_id/);
    expect(liveMain).toContain("bedrock_inference_profile_arn");
    expect(liveMain).toContain("bedrock_foundation_model_arns");
    expect(liveMain).toContain("bedrock_inference_profile_arns");
    expect(liveMain).toMatch(/MODEL_ID\s*=\s*local\.bedrock_model_id/);
    expect(liveVariables).toContain('default     = "eu.anthropic.claude-haiku-4-5-20251001-v1:0"');
  });
});

describe("terraform authenticated API configuration", () => {
  const apiMain = readRepoFile("modules/api_http/main.tf");
  const apiVariables = readRepoFile("modules/api_http/variables.tf");
  const ddbMain = readRepoFile("modules/dynamodb_table/main.tf");
  const liveMain = readRepoFile("live/dev/main.tf");
  const observabilityMain = readRepoFile("modules/observability/main.tf");

  it("passes the dev throttling settings to the HTTP API module", () => {
    expect(liveMain).toMatch(/throttling\s*=\s*var\.api_throttling/);
  });

  it("defines a JWT authorizer and applies it only to POST /chat", () => {
    expect(apiMain).toContain('resource "aws_apigatewayv2_authorizer" "jwt"');
    expect(apiMain).toContain('authorizer_type  = "JWT"');
    expect(apiVariables).toContain("jwt_authorizers");
    expect(liveMain).toContain('"GET /health" = {');
    expect(liveMain).toContain('authorization_type = "NONE"');
    expect(liveMain).toContain('"POST /chat" = {');
    expect(liveMain).toContain('authorization_type = "JWT"');
    expect(liveMain).toContain('authorizer_key     = "cognito"');
  });

  it("wires Cognito issuer and audience into the HTTP API authorizer", () => {
    expect(liveMain).toContain('source = "../../modules/cognito_auth"');
    expect(liveMain).toContain("issuer   = module.auth.issuer");
    expect(liveMain).toContain("audience = [module.auth.user_pool_client_id]");
  });

  it("uses user-scoped DynamoDB keys and enables TTL", () => {
    expect(liveMain).toMatch(/hash_key\s*=\s*"user_id"/);
    expect(liveMain).toMatch(/range_key\s*=\s*"sk"/);
    expect(liveMain).toMatch(/ttl_attribute\s*=\s*"expires_at"/);
    expect(ddbMain).toContain("enabled        = true");
  });

  it("enables structured API access logs without authorization headers", () => {
    expect(apiMain).toContain('resource "aws_cloudwatch_log_group" "access"');
    expect(apiMain).toContain("access_log_settings");
    expect(apiMain).toContain("requestId");
    expect(apiMain).toContain("routeKey");
    expect(apiMain).toContain("integrationLatency");
    expect(apiMain).not.toContain("$context.request.header.Authorization");
  });

  it("alarms on Lambda throttles and Bedrock throttle custom metrics", () => {
    expect(observabilityMain).toContain('resource "aws_cloudwatch_metric_alarm" "lambda_throttles"');
    expect(observabilityMain).toContain('metric_name         = "Throttles"');
    expect(observabilityMain).toContain('resource "aws_cloudwatch_metric_alarm" "bedrock_throttles"');
    expect(observabilityMain).toContain('metric_name         = "BedrockThrottleCount"');
    expect(observabilityMain).toContain("namespace           = var.metric_service_name");
    expect(observabilityMain).toContain("Service     = var.metric_service_name");
    expect(liveMain).toContain('metric_service_name = "aws-bedrock-chat-backend"');
  });
});
