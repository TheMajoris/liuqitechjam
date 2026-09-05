output "instance_id" {
  description = "ECS instance ID."
  value       = byteplus_ecs_instance.launchpad.id
}

output "public_ip" {
  description = "ECS public IP."
  value       = byteplus_eip_address.launchpad.eip_address
}

output "app_url" {
  description = "LQAM URL. Wait for cloud-init to finish before opening it."
  value       = "http://${byteplus_eip_address.launchpad.eip_address}"
}
