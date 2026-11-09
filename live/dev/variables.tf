variable "project" {
  type    = string
  default = "aws-bedrock-chat-backend"
}

variable "region" {
  type    = string
  default = "eu-west-1"
}

variable "env" {
  type    = string
  default = "dev"
}

variable "lambda_runtime" {
  type    = string
  default = "nodejs22.x"
}

variable "chat_retention_days" {
  description = "Chat history retention window written to DynamoDB TTL as epoch seconds."
  type        = number
  default     = 7

  validation {
    condition     = var.chat_retention_days >= 1 && var.chat_retention_days <= 365
    error_message = "chat_retention_days must be between 1 and 365."
  }
}

variable "max_context_chars" {
  description = "Approximate application-level character budget for prior chat history sent to Bedrock."
  type        = number
  default     = 24000

  validation {
    condition     = var.max_context_chars >= 1000 && var.max_context_chars <= 200000
    error_message = "max_context_chars must be between 1000 and 200000."
  }
}

variable "bedrock_model_id" {
  description = "System-defined Bedrock inference profile ID used by the Lambda MODEL_ID environment variable."
  type        = string
  default     = "eu.anthropic.claude-haiku-4-5-20251001-v1:0"

  validation {
    condition     = length(trimspace(var.bedrock_model_id)) > 0 && !can(regex("\\*", var.bedrock_model_id)) && !can(regex("^arn:", var.bedrock_model_id))
    error_message = "bedrock_model_id must be a non-empty inference profile ID, not an ARN or wildcard."
  }
}

variable "bedrock_foundation_model_id" {
  description = "Foundation model ID that backs the configured Bedrock inference profile."
  type        = string
  default     = "anthropic.claude-haiku-4-5-20251001-v1:0"

  validation {
    condition     = length(trimspace(var.bedrock_foundation_model_id)) > 0 && !can(regex("\\*", var.bedrock_foundation_model_id)) && !can(regex("^arn:", var.bedrock_foundation_model_id))
    error_message = "bedrock_foundation_model_id must be a non-empty foundation model ID, not an ARN or wildcard."
  }
}

variable "bedrock_inference_profile_destination_regions" {
  description = "Destination Regions for the configured system-defined Bedrock inference profile."
  type        = list(string)
  default = [
    "eu-north-1",
    "eu-west-3",
    "eu-south-1",
    "eu-south-2",
    "eu-west-1",
    "eu-central-1"
  ]

  validation {
    condition = length(var.bedrock_inference_profile_destination_regions) > 0 && alltrue([
      for region in var.bedrock_inference_profile_destination_regions :
      can(regex("^[a-z]{2}(-gov)?-[a-z]+-[0-9]+$", region))
    ])
    error_message = "bedrock_inference_profile_destination_regions must contain one or more concrete AWS Region names."
  }
}

variable "alarm_email" {
  description = "Optional email address for SNS alarm notifications. Leave empty to skip the email subscription."
  type        = string
  default     = ""
}

variable "tags" {
  type = map(string)
  default = {
    App    = "aws-bedrock-chat-backend"
    Domain = "genai"
  }
}

variable "rag_enabled" {
  description = "Enable Runbook guidance; keep disabled until approved validation."
  type        = bool
  default     = false
  nullable    = false
}
