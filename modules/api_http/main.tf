resource "aws_apigatewayv2_api" "this" {
  name          = var.name
  protocol_type = "HTTP"
  tags          = var.tags

  cors_configuration {
    allow_headers = var.cors_allow_headers
    allow_methods = var.cors_allow_methods
    allow_origins = var.cors_allow_origins
    max_age       = var.cors_max_age
  }
}

resource "aws_apigatewayv2_integration" "lambda" {
  api_id                 = aws_apigatewayv2_api.this.id
  integration_type       = "AWS_PROXY"
  integration_uri        = var.lambda_arn
  payload_format_version = "2.0"
  timeout_milliseconds   = 29000
}

resource "aws_apigatewayv2_authorizer" "jwt" {
  for_each         = var.jwt_authorizers
  api_id           = aws_apigatewayv2_api.this.id
  name             = each.key
  authorizer_type  = "JWT"
  identity_sources = ["$request.header.Authorization"]

  jwt_configuration {
    issuer   = each.value.issuer
    audience = each.value.audience
  }
}

resource "aws_apigatewayv2_route" "routes" {
  for_each           = var.routes
  api_id             = aws_apigatewayv2_api.this.id
  route_key          = each.key
  target             = "integrations/${aws_apigatewayv2_integration.lambda.id}"
  authorization_type = each.value.authorization_type
  authorizer_id = each.value.authorizer_key == null ? null : (
    aws_apigatewayv2_authorizer.jwt[each.value.authorizer_key].id
  )
}

resource "aws_cloudwatch_log_group" "access" {
  name              = "/aws/apigateway/${var.name}/access"
  retention_in_days = var.access_log_retention_days
  tags              = var.tags
}

resource "aws_apigatewayv2_stage" "default" {
  api_id      = aws_apigatewayv2_api.this.id
  name        = "$default"
  auto_deploy = true
  tags        = var.tags

  default_route_settings {
    throttling_rate_limit  = var.throttling.rate_limit
    throttling_burst_limit = var.throttling.burst_limit
  }

  access_log_settings {
    destination_arn = aws_cloudwatch_log_group.access.arn
    format = jsonencode({
      requestId          = "$context.requestId"
      routeKey           = "$context.routeKey"
      status             = "$context.status"
      responseLatency    = "$context.responseLatency"
      integrationLatency = "$context.integrationLatency"
      errorMessage       = "$context.error.message"
      sourceIp           = "$context.identity.sourceIp"
    })
  }
}

resource "aws_lambda_permission" "allow_invoke" {
  statement_id  = "AllowAPIGatewayInvoke-${var.name}"
  action        = "lambda:InvokeFunction"
  function_name = var.lambda_name
  principal     = "apigateway.amazonaws.com"
  source_arn    = "${aws_apigatewayv2_api.this.execution_arn}/*/*"
}
