variable "region" {
  description = "Volcengine region, for example cn-beijing."
  type        = string
}

variable "zone_id" {
  description = "Availability zone that has inventory for the chosen instance type."
  type        = string
}

variable "image_id" {
  description = "A public Ubuntu 22.04/24.04 image ID in the selected region."
  type        = string
}

variable "instance_type" {
  description = "ECS instance type. 2 vCPU / 4 GiB or larger is recommended."
  type        = string
  default     = "ecs.g4i.large"
}

variable "key_pair_name" {
  description = "Existing ECS SSH key-pair name."
  type        = string
}

variable "project_name" {
  description = "Volcengine project."
  type        = string
  default     = "default"
}

variable "allowed_web_cidr" {
  description = "CIDR allowed to access the web UI. This must be an explicit, restricted network."
  type        = string
  validation {
    condition     = var.allowed_web_cidr != "0.0.0.0/0"
    error_message = "allowed_web_cidr must not expose this code-execution POC to the entire Internet."
  }
}

variable "allowed_ssh_cidr" {
  description = "CIDR allowed to SSH to the ECS."
  type        = string
  validation {
    condition     = var.allowed_ssh_cidr != "0.0.0.0/0"
    error_message = "allowed_ssh_cidr must not expose SSH to the entire Internet."
  }
}

variable "github_actions_ssh_cidr" {
  description = "Ephemeral /32 CIDR for the current GitHub-hosted deployment runner."
  type        = string
  default     = ""
  validation {
    condition = var.github_actions_ssh_cidr == "" || (
      endswith(var.github_actions_ssh_cidr, "/32") &&
      can(cidrhost(var.github_actions_ssh_cidr, 0)) &&
      var.github_actions_ssh_cidr != "0.0.0.0/0"
    )
    error_message = "github_actions_ssh_cidr must be an IPv4 /32 or empty; it must not be 0.0.0.0/0."
  }
}

variable "repository_url" {
  description = "Public Git URL of this Starter Kit repository."
  type        = string
  validation {
    condition     = startswith(var.repository_url, "https://")
    error_message = "repository_url must be an HTTPS URL."
  }
}

variable "repository_ref" {
  description = "Git branch, tag, or commit checked out by cloud-init for deployment scripts."
  type        = string
  default     = "staging"
}

variable "image_ref" {
  description = "Immutable public GHCR image reference built for this deployment."
  type        = string
  validation {
    condition     = startswith(var.image_ref, "ghcr.io/") && length(var.image_ref) > 20
    error_message = "image_ref must be a public GHCR image reference (ghcr.io/<owner>/<repo>:<tag>)."
  }
}
