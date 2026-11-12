locals {
  name_prefix = "${var.project}-${var.env}"
  chat_table  = "chat_history-${var.env}"
  lambda_fn   = "api-${var.env}"

  bedrock_model_id              = var.bedrock_model_id
  bedrock_inference_profile_arn = "arn:${data.aws_partition.current.partition}:bedrock:${var.region}:${data.aws_caller_identity.current.account_id}:inference-profile/${local.bedrock_model_id}"
  bedrock_foundation_model_arns = [
    for region in var.bedrock_inference_profile_destination_regions :
    "arn:${data.aws_partition.current.partition}:bedrock:${region}::foundation-model/${var.bedrock_foundation_model_id}"
  ]
}

data "aws_caller_identity" "current" {}

data "aws_partition" "current" {}

# 1) IAM role for Lambda
module "iam_lambda" {
  source                         = "../../modules/iam_lambda_basic"
  name                           = "${local.name_prefix}-lambda"
  enable_bedrock                 = true
  bedrock_inference_profile_arns = [local.bedrock_inference_profile_arn]
  bedrock_foundation_model_arns  = local.bedrock_foundation_model_arns
  tags                           = var.tags
}

# 2) Cognito user pool and app client for API JWT authentication
module "auth" {
  source = "../../modules/cognito_auth"
  name   = "${local.name_prefix}-auth"
  tags   = var.tags
}

# 3) DynamoDB chat history table
module "chat_table" {
  source         = "../../modules/dynamodb_table"
  name           = local.chat_table
  hash_key       = "user_id"
  range_key      = "sk"
  range_key_type = "S"
  billing_mode   = "PAY_PER_REQUEST"
  ttl_attribute  = "expires_at"
  tags           = var.tags
}

# 4) Scoped policy for Lambda access to the table
resource "aws_iam_policy" "lambda_dynamodb" {
  name        = "${local.name_prefix}-lambda-dynamodb"
  description = "Lambda access to chat history DynamoDB"
  policy = jsonencode({
    Version = "2012-10-17",
    Statement = [{
      Sid      = "ChatTableRW",
      Effect   = "Allow",
      Action   = ["dynamodb:PutItem", "dynamodb:Query"],
      Resource = [module.chat_table.table_arn]
    }]
  })
}

resource "aws_iam_role_policy_attachment" "attach_ddb" {
  role       = module.iam_lambda.role_name
  policy_arn = aws_iam_policy.lambda_dynamodb.arn
}

# 5) Lambda (TypeScript build packaged in build/lambda.zip)
locals {
  lambda_environment = {
    CHAT_TABLE           = module.chat_table.table_name
    ENVIRONMENT          = var.env
    MODEL_ID             = local.bedrock_model_id
    RAG_ENABLED          = tostring(var.rag_enabled)
    TOOL_CALLING_ENABLED = tostring(var.tool_calling_enabled)
    HISTORY_TURNS        = "10"
    MAX_CONTEXT_CHARS    = tostring(var.max_context_chars)
    CHAT_RETENTION_DAYS  = tostring(var.chat_retention_days)
    TEMPERATURE          = "0.2"
    MAX_TOKENS           = "1024"
  }
}

module "lambda_api" {
  source             = "../../modules/lambda_function"
  function_name      = "${var.project}-${local.lambda_fn}"
  role_arn           = module.iam_lambda.role_arn
  runtime            = var.lambda_runtime
  handler            = "handler.handler"
  zip_path           = "${path.module}/../../build/lambda.zip"
  memory_size        = 256
  timeout_seconds    = 15
  log_retention_days = 14
  environment        = local.lambda_environment
  tags               = var.tags
}

# 6) API Gateway HTTP v2 routes for /health and /chat
module "api_http" {
  source             = "../../modules/api_http"
  name               = "${local.name_prefix}-http"
  lambda_arn         = module.lambda_api.lambda_invoke_arn
  lambda_name        = module.lambda_api.function_name
  throttling         = var.api_throttling
  cors_allow_origins = ["*"]
  cors_allow_methods = ["GET", "POST", "OPTIONS"]
  cors_allow_headers = ["Authorization", "Content-Type"]
  jwt_authorizers = {
    cognito = {
      issuer   = module.auth.issuer
      audience = [module.auth.user_pool_client_id]
    }
  }
  routes = {
    "GET /health" = {
      authorization_type = "NONE"
    }
    "POST /chat" = {
      authorization_type = "JWT"
      authorizer_key     = "cognito"
    }
  }
  tags = var.tags
}

module "observability" {
  source              = "../../modules/observability"
  project             = var.project
  environment         = var.env
  metric_service_name = "aws-bedrock-chat-backend"
  region              = var.region

  tags = {
    Owner = var.project
  }

  lambda_function_names = [
    module.lambda_api.function_name
  ]
  lambda_log_group_names = {
    (module.lambda_api.function_name) = module.lambda_api.log_group_name
  }

  api_gw_type       = "http_v2"
  apigw_http_api_id = module.api_http.api_id
  apigw_stage_name  = module.api_http.stage_name

  dynamodb_table_name = module.chat_table.table_name

  alarm_email = var.alarm_email

  monthly_budget_amount            = 25
  enable_cost_anomaly_detection    = false
  currency                         = "USD"
  lambda_duration_p95_threshold_ms = 2000
  apigw_latency_p95_threshold_ms   = 1500
}
