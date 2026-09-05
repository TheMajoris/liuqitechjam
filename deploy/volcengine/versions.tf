terraform {
  required_version = ">= 1.6.0"

  # HCP Terraform stores the remote state. The workspace must use Local
  # execution so GitHub Actions performs the plan/apply while HCP provides
  # encrypted state storage and locking.
  cloud {
    organization = "liuqitechjam-staging"

    workspaces {
      name = "liuqitechjam-staging"
    }
  }

  required_providers {
    volcenginecc = {
      source  = "volcengine/volcenginecc"
      version = "0.0.58"
    }
  }
}

provider "volcenginecc" {
  region = var.region
}
