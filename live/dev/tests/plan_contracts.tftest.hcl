mock_provider "aws" {
  mock_data "aws_caller_identity" {
    defaults = {
      account_id = "123456789012"
    }
  }

  mock_data "aws_partition" {
    defaults = {
      partition = "aws"
    }
  }

  mock_data "aws_iam_policy_document" {
    defaults = {
      json = <<-EOT
      {
        "Version": "2012-10-17",
        "Statement": [
          {
            "Effect": "Allow",
            "Action": "SNS:Publish",
            "Principal": {
              "Service": "cloudwatch.amazonaws.com"
            },
            "Resource": "*"
          }
        ]
      }
      EOT
    }
  }
}

override_resource {
  target = module.chat_table.aws_dynamodb_table.this

  values = {
    arn = "arn:aws:dynamodb:us-east-1:123456789012:table/chat_history-dev"
  }
}

variables {
  region = "eu-west-1"
}

run "root_lambda_dynamodb_policy_contract" {
  command = plan

  assert {
    condition     = aws_iam_policy.lambda_dynamodb.name == "${local.name_prefix}-lambda-dynamodb"
    error_message = "Lambda DynamoDB access must stay in the dedicated chat history policy."
  }

  assert {
    condition     = aws_iam_policy.lambda_dynamodb.description == "Lambda access to chat history DynamoDB"
    error_message = "Lambda DynamoDB policy must remain scoped to the chat history use case."
  }
}

run "dev_defaults" {
  command = plan

  assert {
    condition     = local.lambda_environment.RAG_ENABLED == "false" && local.lambda_environment.TOOL_CALLING_ENABLED == "false"
    error_message = "Runbook RAG and simulated Tool Calling must default to off."
  }

  assert {
    condition     = var.api_throttling.rate_limit == 2 && var.api_throttling.burst_limit == 5
    error_message = "Dev throttling must default to 2 requests per second with a burst of 5."
  }
}

run "dev_rag_enabled" {
  command = plan

  variables {
    rag_enabled = true
  }

  assert {
    condition     = local.lambda_environment.RAG_ENABLED == "true" && local.lambda_environment.TOOL_CALLING_ENABLED == "false"
    error_message = "Enabling RAG must leave simulated Tool Calling off."
  }
}

run "dev_tool_calling_enabled" {
  command = plan

  variables {
    tool_calling_enabled = true
  }

  assert {
    condition     = local.lambda_environment.RAG_ENABLED == "false" && local.lambda_environment.TOOL_CALLING_ENABLED == "true"
    error_message = "Enabling simulated Tool Calling must leave RAG off."
  }
}

run "reject_zero_throttling_rate" {
  command = plan

  variables {
    api_throttling = { rate_limit = 0, burst_limit = 5 }
  }

  expect_failures = [var.api_throttling]
}

run "reject_fractional_throttling_burst" {
  command = plan

  variables {
    api_throttling = { rate_limit = 2, burst_limit = 1.5 }
  }

  expect_failures = [var.api_throttling]
}

run "cognito_contract" {
  command = plan

  module {
    source = "../../modules/cognito_auth"
  }

  variables {
    name = "aws-bedrock-chat-backend-dev-auth"
  }

  assert {
    condition     = aws_cognito_user_pool.this.name == var.name
    error_message = "The Cognito User Pool must be present with the configured name."
  }

  assert {
    condition     = aws_cognito_user_pool_client.this.generate_secret == false
    error_message = "The Cognito app client must not generate a client secret."
  }

  assert {
    condition = toset(aws_cognito_user_pool_client.this.explicit_auth_flows) == toset([
      "ALLOW_ADMIN_USER_PASSWORD_AUTH",
      "ALLOW_REFRESH_TOKEN_AUTH",
      "ALLOW_USER_SRP_AUTH"
    ])
    error_message = "The Cognito app client auth flows must keep SRP, refresh tokens, and IAM-controlled admin password validation only."
  }

  assert {
    condition     = aws_cognito_user_pool_client.this.prevent_user_existence_errors == "ENABLED"
    error_message = "The Cognito app client must keep user existence errors hidden."
  }

  assert {
    condition = (
      aws_cognito_user_pool.this.password_policy[0].minimum_length == 12 &&
      aws_cognito_user_pool.this.password_policy[0].require_lowercase == true &&
      aws_cognito_user_pool.this.password_policy[0].require_numbers == true &&
      aws_cognito_user_pool.this.password_policy[0].require_symbols == true &&
      aws_cognito_user_pool.this.password_policy[0].require_uppercase == true &&
      aws_cognito_user_pool.this.password_policy[0].temporary_password_validity_days == 7
    )
    error_message = "The Cognito password policy must match the current configuration."
  }
}

run "api_gateway_contract" {
  command = plan

  module {
    source = "../../modules/api_http"
  }

  variables {
    name        = "aws-bedrock-chat-backend-dev-http"
    lambda_arn  = "arn:aws:lambda:us-east-1:123456789012:function:aws-bedrock-chat-backend-api-dev"
    lambda_name = "aws-bedrock-chat-backend-api-dev"
    jwt_authorizers = {
      cognito = {
        issuer   = "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example"
        audience = ["client-123"]
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
    cors_allow_origins = ["*"]
    cors_allow_methods = ["GET", "POST", "OPTIONS"]
    cors_allow_headers = ["Authorization", "Content-Type"]
    throttling         = { rate_limit = 1.5, burst_limit = 4 }
  }

  assert {
    condition     = aws_apigatewayv2_route.routes["GET /health"].authorization_type == "NONE"
    error_message = "GET /health must remain unauthenticated."
  }

  assert {
    condition     = aws_apigatewayv2_route.routes["POST /chat"].authorization_type == "JWT"
    error_message = "POST /chat must use JWT authorization."
  }

  assert {
    condition     = aws_apigatewayv2_authorizer.jwt["cognito"].jwt_configuration[0].issuer == "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_example"
    error_message = "The JWT issuer must come from the configured Cognito issuer."
  }

  assert {
    condition     = aws_apigatewayv2_authorizer.jwt["cognito"].jwt_configuration[0].audience == toset(["client-123"])
    error_message = "The JWT audience must come from the configured Cognito app client."
  }

  assert {
    condition     = length(aws_apigatewayv2_stage.default.access_log_settings) == 1
    error_message = "HTTP API access logs must be enabled."
  }

  assert {
    condition = (
      aws_apigatewayv2_stage.default.default_route_settings[0].throttling_rate_limit == 1.5 &&
      aws_apigatewayv2_stage.default.default_route_settings[0].throttling_burst_limit == 4
    )
    error_message = "The stage must use the configured throttling targets."
  }

  assert {
    condition     = !strcontains(aws_apigatewayv2_stage.default.access_log_settings[0].format, "Authorization")
    error_message = "HTTP API access logs must not include the Authorization header."
  }

  assert {
    condition     = aws_cloudwatch_log_group.access.retention_in_days == 14
    error_message = "HTTP API access log retention must be explicit."
  }
}

run "dynamodb_contract" {
  command = plan

  module {
    source = "../../modules/dynamodb_table"
  }

  variables {
    name          = "chat_history-dev"
    hash_key      = "user_id"
    range_key     = "sk"
    billing_mode  = "PAY_PER_REQUEST"
    ttl_attribute = "expires_at"
  }

  assert {
    condition     = aws_dynamodb_table.this.hash_key == "user_id"
    error_message = "Chat history table PK must be user_id."
  }

  assert {
    condition     = aws_dynamodb_table.this.range_key == "sk"
    error_message = "Chat history table SK must be sk."
  }

  assert {
    condition     = aws_dynamodb_table.this.ttl[0].attribute_name == "expires_at" && aws_dynamodb_table.this.ttl[0].enabled == true
    error_message = "Chat history TTL must use expires_at."
  }

  assert {
    condition     = aws_dynamodb_table.this.billing_mode == "PAY_PER_REQUEST"
    error_message = "Chat history billing mode must match the current configuration."
  }
}

run "lambda_iam_bedrock_contract" {
  command = plan

  module {
    source = "../../modules/iam_lambda_basic"
  }

  variables {
    name           = "aws-bedrock-chat-backend-dev-lambda"
    enable_bedrock = true
    bedrock_inference_profile_arns = [
      "arn:aws:bedrock:eu-west-1:123456789012:inference-profile/eu.anthropic.claude-haiku-4-5-20251001-v1:0"
    ]
    bedrock_foundation_model_arns = [
      "arn:aws:bedrock:eu-north-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
      "arn:aws:bedrock:eu-west-3::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
      "arn:aws:bedrock:eu-south-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
      "arn:aws:bedrock:eu-south-2::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
      "arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0",
      "arn:aws:bedrock:eu-central-1::foundation-model/anthropic.claude-haiku-4-5-20251001-v1:0"
    ]
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_policy.bedrock_invoke[0].policy).Statement :
      statement.Action == ["bedrock:InvokeModel"]
    ])
    error_message = "Bedrock IAM must only allow bedrock:InvokeModel."
  }

  assert {
    condition = alltrue([
      for statement in jsondecode(aws_iam_policy.bedrock_invoke[0].policy).Statement :
      !contains(statement.Resource, "*")
    ])
    error_message = "Bedrock IAM resources must not contain wildcard resources."
  }

  assert {
    condition = (
      jsondecode(aws_iam_policy.bedrock_invoke[0].policy).Statement[1].Condition.StringLike["bedrock:InferenceProfileArn"] ==
      ["arn:aws:bedrock:eu-west-1:123456789012:inference-profile/eu.anthropic.claude-haiku-4-5-20251001-v1:0"]
    )
    error_message = "Foundation model access must be constrained by the configured inference profile ARN."
  }
}

run "lambda_log_retention_contract" {
  command = plan

  module {
    source = "../../modules/lambda_function"
  }

  variables {
    function_name      = "aws-bedrock-chat-backend-api-dev"
    role_arn           = "arn:aws:iam::123456789012:role/aws-bedrock-chat-backend-dev-lambda-role"
    runtime            = "nodejs22.x"
    handler            = "handler.handler"
    zip_path           = "../../build/lambda.zip"
    log_retention_days = 14
  }

  assert {
    condition     = aws_cloudwatch_log_group.this.retention_in_days == 14
    error_message = "Lambda log retention must be explicit."
  }
}

run "observability_contract" {
  command = plan

  module {
    source = "../../modules/observability"
  }

  variables {
    project               = "aws-bedrock-chat-backend"
    environment           = "dev"
    metric_service_name   = "aws-bedrock-chat-backend"
    region                = "us-east-1"
    lambda_function_names = ["aws-bedrock-chat-backend-api-dev"]
    lambda_log_group_names = {
      "aws-bedrock-chat-backend-api-dev" = "/aws/lambda/aws-bedrock-chat-backend-api-dev"
    }
    api_gw_type           = "http_v2"
    apigw_http_api_id     = "api123"
    apigw_stage_name      = "$default"
    dynamodb_table_name   = "chat_history-dev"
    monthly_budget_amount = 25
    currency              = "USD"
    alarm_email           = ""
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.lambda_errors["aws-bedrock-chat-backend-api-dev"].threshold == 1
    error_message = "Lambda error alarms must be present."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.lambda_throttles["aws-bedrock-chat-backend-api-dev"].metric_name == "Throttles"
    error_message = "Lambda throttle alarms must be present."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.apigw_5xx.metric_name == "5xx"
    error_message = "HTTP API 5XX alarm must be present."
  }

  assert {
    condition     = aws_cloudwatch_metric_alarm.bedrock_throttles.dimensions["Service"] == "aws-bedrock-chat-backend"
    error_message = "Bedrock throttle alarm must include the explicit Service dimension."
  }
}
