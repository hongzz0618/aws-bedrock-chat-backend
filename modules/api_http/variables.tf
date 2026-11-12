variable "name" { type = string }
variable "lambda_arn" { type = string }
variable "lambda_name" { type = string }
variable "throttling" {
  description = "Default route throttling targets for the HTTP API stage."
  type = object({
    rate_limit  = number
    burst_limit = number
  })
}
variable "routes" {
  type = map(object({
    authorization_type = optional(string, "NONE")
    authorizer_key     = optional(string)
  }))
}
variable "jwt_authorizers" {
  type = map(object({
    issuer   = string
    audience = list(string)
  }))
  default = {}
}
variable "access_log_retention_days" {
  type    = number
  default = 14

  validation {
    condition     = contains([1, 3, 5, 7, 14, 30, 60, 90, 120, 150, 180, 365, 400, 545, 731, 1096, 1827, 2192, 2557, 2922, 3288, 3653], var.access_log_retention_days)
    error_message = "access_log_retention_days must be a valid CloudWatch Logs retention value."
  }
}
variable "cors_allow_origins" {
  type        = list(string)
  description = "Origins allowed by HTTP API native CORS."
  default     = ["*"]
}
variable "cors_allow_methods" {
  type        = list(string)
  description = "Methods allowed by HTTP API native CORS."
  default     = ["GET", "POST", "OPTIONS"]
}
variable "cors_allow_headers" {
  type        = list(string)
  description = "Headers allowed by HTTP API native CORS."
  default     = ["Content-Type"]
}
variable "cors_max_age" {
  type        = number
  description = "Browser preflight cache duration in seconds."
  default     = 300
}
variable "tags" {
  type    = map(string)
  default = {}
}
