#!/usr/bin/env bash
set -euo pipefail

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_dir"

if [[ -z "${VOLCENGINE_ACCESS_KEY:-}" || -z "${VOLCENGINE_SECRET_KEY:-}" ]]; then
  echo "Export VOLCENGINE_ACCESS_KEY and VOLCENGINE_SECRET_KEY first." >&2
  exit 1
fi

if [[ ! -f .env.production ]]; then
  echo "Missing .env.production. Copy .env.example and fill the deployment values." >&2
  exit 1
fi

if [[ ! -f deploy/volcengine/terraform.tfvars ]]; then
  echo "Missing deploy/volcengine/terraform.tfvars." >&2
  echo "Copy terraform.tfvars.example and fill the region-specific values." >&2
  exit 1
fi

set -a
source .env.production
set +a

if [[ -z "${LAUNCHPAD_IMAGE:-}" || "${LAUNCHPAD_IMAGE}" != ghcr.io/* ]]; then
  echo "LAUNCHPAD_IMAGE must be an immutable public GHCR image reference in .env.production." >&2
  exit 1
fi

export TF_VAR_image_ref="$LAUNCHPAD_IMAGE"

if [[ -z "${BYTEPLUS_TOS_BUCKET:-}" || -z "${BYTEPLUS_TOS_ENDPOINT:-}" ]]; then
  echo "Set BYTEPLUS_TOS_BUCKET and BYTEPLUS_TOS_ENDPOINT before initializing Terraform." >&2
  exit 1
fi

terraform -chdir=deploy/volcengine init -input=false \
  -backend-config="bucket=$BYTEPLUS_TOS_BUCKET" \
  -backend-config="key=${BYTEPLUS_TOS_KEY:-staging/terraform.tfstate}" \
  -backend-config="region=${VOLCENGINE_REGION:-cn-beijing}" \
  -backend-config="endpoint=$BYTEPLUS_TOS_ENDPOINT" \
  -backend-config="force_path_style=true" \
  -backend-config="skip_region_validation=true" \
  -backend-config="skip_credentials_validation=true" \
  -backend-config="skip_requesting_account_id=true" \
  -backend-config="skip_metadata_api_check=true" \
  -backend-config="skip_s3_checksum=true"
terraform -chdir=deploy/volcengine apply

echo
echo "Deployment requested. Cloud-init may take 5-10 minutes."
terraform -chdir=deploy/volcengine output app_url
