# GitHub Actions staging checks

The `staging` workflow is CI-only. It runs on pushes to `staging`, pull
requests targeting `staging`, and manual `workflow_dispatch` runs. The workflow
checks out the repository, installs Node.js 22 dependencies with `npm ci`, and
runs `npm run check`.

GitHub Actions no longer provisions BytePlus infrastructure, runs Terraform,
publishes a GHCR image, requests approval through a GitHub Environment, or
deploys to ECS. There is no active staging deployment path configured in CI,
and the workflow does not require deployment credentials or environment
secrets.

The Terraform files under `deploy/volcengine` and the existing ECS deployment
scripts remain available for local or separately managed infrastructure work.
They are intentionally not invoked by GitHub Actions because the current
BytePlus account cannot use Terraform provisioning.
