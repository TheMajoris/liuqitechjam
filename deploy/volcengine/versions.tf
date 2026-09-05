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
    byteplus = {
      source  = "byteplus-sdk/byteplus"
      version = "0.0.25"
    }
  }
}

provider "byteplus" {
  region = var.region
}
