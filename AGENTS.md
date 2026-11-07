# Repository Instructions

## Architecture
- This is a TypeScript AWS Lambda backend using Amazon Bedrock Converse.
- Follow existing patterns in `src-ts/` and existing ADRs.
- Keep changes minimal and focused. Avoid unrelated refactoring.

## Compatibility and Security
- Keep `GET /health` public and `POST /chat` JWT-protected.
- Use authenticated JWT `sub` for user identity, never client-supplied identity.
- Preserve user-scoped DynamoDB history, session isolation, and TTL.
- Preserve existing API behavior unless a change is explicitly approved.
- Keep runtime validation, OpenAPI, and contract tests aligned.
- Never log prompts, JWTs, conversation history, or sensitive model responses.

## Bedrock and Observability
- Follow the existing Bedrock Converse client abstraction.
- Preserve structured logs, EMF metrics, and error handling.
- Use bounded inputs and context to limit resource consumption.

## Local Verification
- TypeScript: `npm run typecheck`
- Tests: `npm test`
- API contract: `npm run contract:validate` and `npm run test:contract`
- Build: `npm run build`
- Run relevant checks for the actual changes.
- Report results and any checks not performed.

## AWS Safety
- Prefer mocked AWS clients and local tests.
- Do not run Terraform apply/destroy or deploy AWS resources without approval.
- Avoid real Bedrock calls and cost-generating AWS operations unless approved.

## References
- Architecture and setup: `README.md`
- Architecture decisions: `docs/adr/`
- CI checks: `.github/workflows/ci.yml`
