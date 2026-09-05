# Public, non-sensitive staging infrastructure settings. GitHub Actions reads
# this file automatically. Never put credentials, API keys, passwords, or
# private keys here.
region           = "ap-southeast-1"
zone_id          = "ap-southeast-1a"
image_id         = "image-yde3i2v6bwbhccnzezc6"
instance_type    = "ecs.g4i.large"
key_pair_name    = "liuqissh"
project_name     = "default"
allowed_web_cidr = "202.161.35.27/32"
allowed_ssh_cidr = "202.161.35.27/32"

repository_url = "https://github.com/TheMajoris/liuqitechjam.git"
repository_ref = "staging"
