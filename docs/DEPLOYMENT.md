# Deployment

## Supported path: local containers

For this fork the supported, judged path is **local Docker, Colima, or rootless
Podman** on one machine - the control plane, the model-gateway sidecar, and a
disposable Runtime container per turn. Follow [docs/LOCAL_POC.md](LOCAL_POC.md)
for engine selection, the two-process startup (`npm run gateway` +
`npm run poc`), state directories, and the `docker-compose.yml` topology. That
is the environment the Kill Switch evidence, the security checkpoint
(`bash scripts/security-checkpoint.sh`), and [docs/DEMO.md](DEMO.md) are written
against.

## Inherited from the starter, out of scope for the Kill Switch MVP

The starter kit ships a Volcengine ECS deployment (`deploy/volcengine/*.tf` plus
`scripts/deploy-existing-ecs.sh` and `scripts/deploy-volcengine.sh`); the plan
excludes any ECS work until the complete local flow is verified and frozen
([tasks/plan.md](../tasks/plan.md) section 3). Those scripts and Terraform files
are left in place unchanged and untested for this submission - the secretless
gateway topology has not been validated on ECS, so this document does not
describe a cloud deploy flow it cannot verify.

### Existing Linux ECS

Inherited starter script: `scripts/deploy-existing-ecs.sh <env-file>` deploys
from the current source tree to an existing Docker host. Not exercised for the
Kill Switch MVP; use the local path above.

### Terraform deployment

Inherited starter path: `deploy/volcengine/` provisions VPC, subnet, security
group, ECS, and EIP, driven by `scripts/deploy-volcengine.sh`. Not exercised for
the Kill Switch MVP.

## Related documents

- [docs/LOCAL_POC.md](LOCAL_POC.md) - the supported local run.
- [docs/ARCHITECTURE.md](ARCHITECTURE.md) - components and trust zones.
- [docs/ONBOARDING.md](ONBOARDING.md) - developer setup and repo map.
- [SECURITY.md](../SECURITY.md) - known limitations and safe-use guidance.
